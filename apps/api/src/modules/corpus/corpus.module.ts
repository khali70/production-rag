import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { VectorStoreModule } from "../vector-store/vector-store.module.js";
import { AuthorityCrossCheck } from "./authority.crosscheck.js";
import { AuthorityLoader } from "./authority.loader.js";
import { ChecksumVerifier } from "./checksum.verifier.js";
import { IngestService } from "./ingest.service.js";
import { PackLoader } from "./pack.loader.js";

@Module({
  imports: [EmbeddingModule, VectorStoreModule],
  providers: [
    PackLoader,
    ChecksumVerifier,
    AuthorityLoader,
    AuthorityCrossCheck,
    IngestService,
  ],
  exports: [IngestService, PackLoader],
})
export class CorpusModule {}
