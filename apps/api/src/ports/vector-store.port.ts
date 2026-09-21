import type {
  AccessScope,
  ChunkRecord,
  IndexInfo,
  Permissions,
  ScoredChunk,
  SearchQuery,
  Status,
} from "../domain/types.js";

/** Thrown when the index was built by a different embedding setup than the live one. */
export class IndexMismatchError extends Error {
  constructor(expected: IndexInfo, actual: IndexInfo) {
    super(
      `Embedding index mismatch. Index holds ${actual.embeddingModel} dim=${actual.dim} scheme=${actual.prefixScheme}, ` +
        `runtime provides ${expected.embeddingModel} dim=${expected.dim} scheme=${expected.prefixScheme}. ` +
        `Re-ingest with --reindex.`,
    );
    this.name = "IndexMismatchError";
  }
}

/** Thrown when a search is attempted without a resolved access scope. */
export class MissingScopeError extends Error {
  constructor() {
    super("Refusing to search without an access scope. Default is deny.");
    this.name = "MissingScopeError";
  }
}

export abstract class VectorStorePort {
  /**
   * Permissions, lifecycle and authority filters are applied INSIDE the query,
   * never after it. A post-filter both loses recall and pulls restricted text
   * into process memory.
   */
  abstract search(scope: AccessScope, q: SearchQuery): Promise<ScoredChunk[]>;

  /** Upserts one document and its chunks in a single transaction. */
  abstract upsert(chunks: ChunkRecord[]): Promise<void>;

  abstract softDeleteDoc(documentId: string, by: string, reason: string, at: Date): Promise<void>;
  abstract restoreDoc(documentId: string, by: string): Promise<void>;
  abstract setDocStatus(documentId: string, version: string, status: Status): Promise<void>;
  abstract setDocPermissions(documentId: string, perms: Permissions): Promise<void>;

  /** Hard-deletes rows soft-deleted before `olderThan`. Returns the document count removed. */
  abstract purgeDeleted(olderThan: Date): Promise<number>;

  /**
   * content_sha256 of a stored document version, or null when absent.
   * Lets ingest skip re-embedding a document whose inputs have not changed.
   */
  abstract documentHash(documentId: string, version: string): Promise<string | null>;

  abstract indexInfo(): Promise<IndexInfo | null>;
  abstract setIndexInfo(info: IndexInfo): Promise<void>;
}
