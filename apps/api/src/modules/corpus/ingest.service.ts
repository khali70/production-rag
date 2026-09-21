import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppConfig } from "../../config/app-config.js";
import { rankOf } from "../../domain/tier.js";
import type { ChunkRecord, IndexInfo, Permissions } from "../../domain/types.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";
import { VectorStorePort } from "../../ports/vector-store.port.js";
import { resolvePermissions } from "./acl.resolver.js";
import { AuthorityCrossCheck } from "./authority.crosscheck.js";
import {
  AuthorityLoader,
  authorityKey,
  toRelations,
  type AuthorityEntry,
} from "./authority.loader.js";
import { ChecksumVerifier } from "./checksum.verifier.js";
import { chunkContent, chunkId, embeddingText } from "./chunker.js";
import { scanForInjection } from "./injection.scanner.js";
import { PackLoader, type CorpusRecord } from "./pack.loader.js";
import { capsToUnverified, mapStatus } from "./status.mapper.js";

export type IngestOptions = {
  /** Re-embed and rewrite every document even when its hash is unchanged. */
  reindex?: boolean;
  /** Run every check and report, write nothing. */
  dryRun?: boolean;
};

export type IngestReport = {
  filesVerified: number;
  documents: number;
  written: number;
  skipped: number;
  chunks: number;
  lowTrust: string[];
};

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(PackLoader) private readonly pack: PackLoader,
    @Inject(ChecksumVerifier) private readonly checksums: ChecksumVerifier,
    @Inject(AuthorityLoader) private readonly authority: AuthorityLoader,
    @Inject(AuthorityCrossCheck) private readonly crossCheck: AuthorityCrossCheck,
    @Inject(EmbeddingPort) private readonly embeddings: EmbeddingPort,
    @Inject(VectorStorePort) private readonly store: VectorStorePort,
  ) {}

  async run(options: IngestOptions = {}): Promise<IngestReport> {
    // 1. The pack must be untouched. This runs before any database write, so
    //    a tampered corpus never reaches the index even partially.
    const filesVerified = await this.checksums.verify();

    // 2. Load and validate every input.
    const records = await this.pack.loadCorpus();
    const entitlements = await this.pack.loadEntitlements();
    const { index: authorityIndex } = await this.authority.load();

    // 3. The reviewed authority layer must agree with what documents say.
    this.crossCheck.check(records, authorityIndex);
    this.crossCheck.checkDelegationQuotes(records, authorityIndex);

    // 4. The index must have been built by this same embedding setup.
    const expected: IndexInfo = {
      embeddingModel: this.embeddings.modelId,
      dim: this.embeddings.dim,
      prefixScheme: this.embeddings.prefixScheme,
    };
    const actual = await this.store.indexInfo();
    const indexChanged =
      actual !== null &&
      (actual.embeddingModel !== expected.embeddingModel ||
        actual.dim !== expected.dim ||
        actual.prefixScheme !== expected.prefixScheme);

    if (indexChanged && !options.reindex) {
      throw new Error(
        `Index was built with ${actual!.embeddingModel} dim=${actual!.dim} scheme=${actual!.prefixScheme}, ` +
          `runtime provides ${expected.embeddingModel} dim=${expected.dim} scheme=${expected.prefixScheme}. ` +
          `Changing the embedding setup requires a full re-embed: re-run with --reindex.`,
      );
    }
    const forceWrite = options.reindex === true || indexChanged;

    const report: IngestReport = {
      filesVerified,
      documents: records.length,
      written: 0,
      skipped: 0,
      chunks: 0,
      lowTrust: [],
    };

    for (const record of records) {
      const entry = authorityIndex.get(authorityKey(record.document_id, record.version))!;
      const result = await this.ingestOne(record, entry, entitlements, forceWrite, options.dryRun);
      report.chunks += result.chunks;
      if (result.lowTrust) report.lowTrust.push(`${record.document_id} v${record.version}`);
      if (result.written) report.written += 1;
      else report.skipped += 1;
    }

    if (!options.dryRun) {
      await this.store.setIndexInfo(expected);
    }

    return report;
  }

  private async ingestOne(
    record: CorpusRecord,
    entry: AuthorityEntry,
    entitlements: Awaited<ReturnType<PackLoader["loadEntitlements"]>>,
    forceWrite: boolean,
    dryRun = false,
  ): Promise<{ written: boolean; chunks: number; lowTrust: boolean }> {
    const label = `${record.document_id} v${record.version}`;

    // Lifecycle. An unrecognised status throws rather than defaulting.
    const status = mapStatus(record.status, record.document_id);

    // Trust. A document carrying instruction-like text is data only.
    const findings = scanForInjection(record.content);
    const lowTrust = findings.length > 0 || capsToUnverified(record.status);
    if (findings.length > 0) {
      this.logger.warn(
        `${label}: injection patterns [${findings.map((f) => f.patternId).join(", ")}] -> trust low, tier capped at unverified`,
      );
    }

    // Authority. Content can never promote itself: an injection hit or an
    // Unverified status forces the lowest tier whatever authority.yaml says.
    const tier = lowTrust ? "unverified" : entry.tier;
    const relations = lowTrust ? [] : toRelations(entry);

    // Permissions. Default deny, unknown classification resolves to nobody.
    const permissions: Permissions = resolvePermissions(
      record.document_id,
      record.classification,
      record.allowed_groups,
      entitlements,
    );

    const contentSha256 = this.hashInputs(record, entry, permissions);

    if (!forceWrite && !dryRun) {
      const unchanged = await this.isUnchanged(record, contentSha256);
      if (unchanged) {
        this.logger.log(`${label}: unchanged, skipped`);
        return { written: false, chunks: 0, lowTrust };
      }
    }

    const pieces = chunkContent(record.content);

    const vectors = dryRun
      ? pieces.map(() => new Array<number>(this.embeddings.dim).fill(0))
      : await this.embeddings.embed(
          pieces.map((piece) =>
            embeddingText(
              { title: record.title, version: record.version, sectionPath: piece.sectionPath },
              piece.text,
            ),
          ),
          "document",
        );

    const chunks: ChunkRecord[] = pieces.map((piece, i) => ({
      chunkId: chunkId(record.document_id, record.version, piece.chunkIndex),
      text: piece.text,
      embedding: vectors[i]!,
      contentSha256,
      source: {
        documentId: record.document_id,
        version: record.version,
        title: record.title,
        sourcePath: record.source_path,
        sectionPath: piece.sectionPath,
        pageStart: piece.pageStart,
        pageEnd: piece.pageEnd,
        charStart: piece.charStart,
        charEnd: piece.charEnd,
        chunkIndex: piece.chunkIndex,
      },
      ...permissions,
      tier,
      authorityRank: rankOf(tier),
      level: entry.level,
      owner: entry.owner,
      relations,
      status,
      rawStatus: record.status,
      effectiveFrom: record.effective_date,
      trust: lowTrust ? "low" : "normal",
    }));

    if (dryRun) {
      this.logger.log(
        `${label}: would write ${chunks.length} chunks, tier=${tier} level=${entry.level} status=${status}`,
      );
      return { written: true, chunks: chunks.length, lowTrust };
    }

    await this.store.upsert(chunks);
    this.logger.log(
      `${label}: ${chunks.length} chunks, tier=${tier} level=${entry.level} status=${status} trust=${lowTrust ? "low" : "normal"}`,
    );
    return { written: true, chunks: chunks.length, lowTrust };
  }

  /**
   * Hash of everything that would change a stored chunk: the supplied record,
   * the reviewed authority entry, the resolved permissions and the embedding
   * setup. Unchanged hash means re-ingest can skip the embed entirely.
   */
  private hashInputs(
    record: CorpusRecord,
    entry: AuthorityEntry,
    permissions: Permissions,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          record,
          entry,
          permissions,
          model: this.embeddings.modelId,
          dim: this.embeddings.dim,
          scheme: this.embeddings.prefixScheme,
        }),
      )
      .digest("hex");
  }

  private async isUnchanged(record: CorpusRecord, hash: string): Promise<boolean> {
    const stored = await this.store.documentHash(record.document_id, record.version);
    return stored !== null && stored === hash;
  }
}
