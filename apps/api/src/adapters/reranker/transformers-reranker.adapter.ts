import { Inject, Injectable, Logger } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { RerankerPort } from "../../ports/reranker.port.js";

/**
 * bge-reranker style cross-encoder running in-process on CPU through
 * transformers.js (ONNX). Shares the embedding model cache and the
 * allow-remote switch, so offline runs stay offline.
 *
 * The model is loaded on first use, not at boot: callers that never rerank
 * pay nothing.
 */
const MAX_TOKENS = 512;

type Tokenizer = (
  texts: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
) => unknown;
type Classifier = (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>;

@Injectable()
export class TransformersRerankerAdapter extends RerankerPort {
  private readonly logger = new Logger(TransformersRerankerAdapter.name);

  readonly modelId: string;

  private loading: Promise<{ tokenizer: Tokenizer; model: Classifier }> | null = null;

  constructor(@Inject(AppConfig) private readonly config: AppConfig) {
    super();
    this.modelId = config.reranker.modelId;
  }

  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];

    const { tokenizer, model } = await this.load();
    const inputs = tokenizer(new Array<string>(passages.length).fill(query), {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: MAX_TOKENS,
    });
    const { logits } = await model(inputs);
    // One logit per pair; sigmoid maps it to a [0, 1] relevance score.
    return logits.tolist().map((row) => 1 / (1 + Math.exp(-row[0]!)));
  }

  /** Loads tokenizer and model once, even under concurrent first calls. */
  private load(): Promise<{ tokenizer: Tokenizer; model: Classifier }> {
    this.loading ??= this.create();
    return this.loading;
  }

  private async create(): Promise<{ tokenizer: Tokenizer; model: Classifier }> {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
      "@huggingface/transformers"
    );

    env.cacheDir = this.config.embedding.cacheDir;
    env.allowRemoteModels = this.config.embedding.allowRemote;
    env.allowLocalModels = true;

    this.logger.log(
      `Loading ${this.modelId} (${this.config.reranker.dtype}) from ${this.config.embedding.cacheDir}` +
        (this.config.embedding.allowRemote ? ", downloading if absent" : ", offline"),
    );

    const tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
    const model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, {
      dtype: this.config.reranker.dtype,
      device: "cpu",
    });

    return {
      tokenizer: tokenizer as unknown as Tokenizer,
      model: model as unknown as Classifier,
    };
  }
}
