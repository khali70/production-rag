import { Inject, Injectable, Logger } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";

/**
 * bge-v1.5 style embedder (bge-v1.5, snowflake-arctic-embed v1.5) running in-process on CPU through transformers.js (ONNX).
 *
 * Chosen over an Ollama-hosted model so the assessed run path has one less
 * prerequisite process: `pnpm ingest` works with nothing but Node and Docker.
 *
 * Two details this model is fussy about, both handled here so no caller can
 * get them wrong:
 *   - CLS pooling, not mean. bge's own 1_Pooling/config.json sets
 *     pooling_mode_cls_token: true. Mean pooling silently degrades recall.
 *   - Queries take an instruction prefix, documents take none.
 */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const BATCH_SIZE = 16;

type Extractor = (
  texts: string[],
  options: { pooling: "cls"; normalize: boolean },
) => Promise<{ tolist(): number[][]; dims: number[] }>;

@Injectable()
export class TransformersEmbeddingAdapter extends EmbeddingPort {
  private readonly logger = new Logger(TransformersEmbeddingAdapter.name);

  readonly modelId: string;
  readonly dim: number;
  readonly prefixScheme: string;

  private extractor: Extractor | null = null;
  private loading: Promise<Extractor> | null = null;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    /** Injected only by unit tests, to assert prefix handling without a model download. */
    extractor?: Extractor,
  ) {
    super();
    this.modelId = config.embedding.modelId;
    this.dim = config.embedding.dim;
    this.prefixScheme = `bge-v1.5:query-instruction;doc-raw;cls;l2;${config.embedding.dtype}`;
    if (extractor) this.extractor = extractor;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (texts.length === 0) return [];

    const prepared = kind === "query" ? texts.map((t) => QUERY_PREFIX + t) : texts;
    const extractor = await this.load();
    const out: number[][] = [];

    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const batch = prepared.slice(i, i + BATCH_SIZE);
      const tensor = await extractor(batch, { pooling: "cls", normalize: true });
      const got = tensor.dims[tensor.dims.length - 1];
      if (got !== this.dim) {
        throw new Error(
          `Embedding model ${this.modelId} returned dim ${got}, configured EMBEDDING_DIM is ${this.dim}.`,
        );
      }
      out.push(...tensor.tolist());
    }

    return out;
  }

  /** Loads the pipeline once, even under concurrent first calls. */
  private async load(): Promise<Extractor> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = this.createExtractor();
    }
    this.extractor = await this.loading;
    return this.extractor;
  }

  private async createExtractor(): Promise<Extractor> {
    const { pipeline, env } = await import("@huggingface/transformers");

    env.cacheDir = this.config.embedding.cacheDir;
    env.allowRemoteModels = this.config.embedding.allowRemote;
    env.allowLocalModels = true;

    this.logger.log(
      `Loading ${this.modelId} (${this.config.embedding.dtype}) from ${this.config.embedding.cacheDir}` +
        (this.config.embedding.allowRemote ? ", downloading if absent" : ", offline"),
    );

    const pipe = await pipeline("feature-extraction", this.modelId, {
      dtype: this.config.embedding.dtype,
      device: "cpu",
    });

    return pipe as unknown as Extractor;
  }
}
