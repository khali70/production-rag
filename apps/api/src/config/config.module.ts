import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { REPO_ROOT, AppConfig } from "./app-config.js";
import { validateEnv, type Env } from "./env.schema.js";
import { resolve } from "node:path";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(REPO_ROOT, ".env")],
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // ConfigService holds the object validateEnv returned, already coerced.
        const env = Object.fromEntries(
          [
            "NODE_ENV", "PORT",
            "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_HOST_PORT",
            "DATABASE_URL", "TEST_DATABASE_URL",
            "PACK_DIR", "AUTHORITY_FILE",
            "EMBEDDING_MODEL_ID", "EMBEDDING_DIM", "EMBEDDING_DTYPE",
            "EMBEDDING_CACHE_DIR", "EMBEDDING_ALLOW_REMOTE",
            "PURGE_RETENTION_DAYS",
          ].map((key) => [key, config.get(key)]),
        ) as unknown as Env;
        return new AppConfig(env);
      },
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
