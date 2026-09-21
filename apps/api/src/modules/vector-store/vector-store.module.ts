import { Module } from "@nestjs/common";
import { Migrator } from "../../adapters/vector-store/pgvector/migrate.js";
import { PgPool } from "../../adapters/vector-store/pgvector/pg.pool.js";
import { PgVectorStoreAdapter } from "../../adapters/vector-store/pgvector/pgvector.adapter.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";
import { VectorStorePort } from "../../ports/vector-store.port.js";
import { EmbeddingModule } from "../embedding/embedding.module.js";

@Module({
  imports: [EmbeddingModule],
  providers: [
    PgPool,
    Migrator,
    {
      provide: VectorStorePort,
      inject: [PgPool, EmbeddingPort],
      useFactory: (pool: PgPool, embeddings: EmbeddingPort) =>
        new PgVectorStoreAdapter(pool, embeddings),
    },
  ],
  exports: [VectorStorePort, Migrator, PgPool],
})
export class VectorStoreModule {}
