import { Inject, Injectable, Logger } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";
import { withExternalDataFallback } from "../external-data.js";

/**
 * CLS-pooled embedder (snowflake-arctic-embed v2.0 / v1.5, bge-v1.5) running in-process on CPU through transformers.js (ONNX).
 *
 * Chosen over an Ollama-hosted model so the assessed run path has one less
 * prerequisite process: `pnpm ingest` works with nothing but Node and Docker.
 *
 * Two details this model is fussy about, both handled here so no caller can
 * get them wrong:
 *   - CLS pooling, not mean. These models' 1_Pooling/config.json sets
 *     pooling_mode_cls_token: true. Mean pooling silently degrades recall.
 *   - Queries take an instruction prefix (EMBEDDING_QUERY_PREFIX), documents take none.
 */

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

  private readonly queryPrefix: string;
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
    this.queryPrefix = config.embedding.queryPrefix ? `${config.embedding.queryPrefix} ` : "";
    // The prefix text is part of the scheme: changing it makes stored vectors incomparable.
    this.prefixScheme = `query:${JSON.stringify(this.queryPrefix)};doc-raw;cls;l2;${config.embedding.dtype}`;
    if (extractor) this.extractor = extractor;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (texts.length === 0) return [];

    const prepared = kind === "query" ? texts.map((t) => this.queryPrefix + t) : texts;
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

    const pipe = await withExternalDataFallback((extra) =>
      pipeline("feature-extraction", this.modelId, {
        dtype: this.config.embedding.dtype,
        device: "cpu",
        ...extra,
      }),
    );

    return pipe as unknown as Extractor;
  }
}
