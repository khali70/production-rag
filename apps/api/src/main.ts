import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { AppModule } from "./app.module.js";
import { AppConfig } from "./config/app-config.js";

/**
 * HTTP bootstrap: serves the ask playground at / and its JSON API under /api.
 *
 * Bound to localhost only. The playground lets the caller pick any pack user,
 * which is impersonation, so it must never be reachable from the network.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfig);

  // A local LLM can take minutes. Node's default 5 minute request timeout
  // would cut the response before LLM_TIMEOUT_MS fires, so outlast it.
  const server = app.getHttpServer() as Server;
  server.requestTimeout = config.llm.timeoutMs + 60_000;

  await app.listen(config.port, "127.0.0.1");
  console.log(`ask playground: http://localhost:${config.port}/`);
}

void bootstrap();
