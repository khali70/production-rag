import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { AppConfig } from "./config/app-config.js";

/**
 * HTTP bootstrap. The ask endpoint is not built yet; this exists so the wiring
 * is exercised the same way the CLIs exercise it.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfig);
  await app.listen(config.port);
}

void bootstrap();
