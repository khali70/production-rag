import { Inject, Injectable } from "@nestjs/common";
import type { AccessScope, ScoredChunk, SearchQuery, VersionQuery } from "../../../domain/types.js";
import { VectorStorePort } from "../../../ports/vector-store.port.js";
import type { PipelineStage } from "./stage.js";

export type SearchInput = { scope: AccessScope; query: SearchQuery };
export type Searched = { chunks: ScoredChunk[]; ms: number };

/** query vector -> candidate chunks. Permissions and lifecycle are filtered inside the store. */
@Injectable()
export class SearchStage implements PipelineStage<SearchInput, Searched> {
  constructor(@Inject(VectorStorePort) private readonly store: VectorStorePort) {}

  async run({ scope, query }: SearchInput): Promise<Searched> {
    const started = Date.now();
    const chunks = await this.store.search(scope, query);
    return { chunks, ms: Date.now() - started };
  }

  /** Other versions of the documents already found: old next to current, per file. */
  async versions(scope: AccessScope, query: VersionQuery): Promise<Searched> {
    const started = Date.now();
    const chunks = await this.store.versions(scope, query);
    return { chunks, ms: Date.now() - started };
  }
}
