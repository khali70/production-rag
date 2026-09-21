import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { PackLoader } from "./pack.loader.js";

/**
 * Verifies every file listed in the pack's checksums.sha256 before ingest
 * touches the database.
 *
 * The pack must not be silently rewritten, and an altered corpus would quietly
 * change what the system answers. This fails the whole run, loudly, and does it
 * first so nothing partial is written.
 */
export class ChecksumMismatchError extends Error {
  constructor(readonly problems: string[]) {
    super(`Assessment pack failed checksum verification:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "ChecksumMismatchError";
  }
}

@Injectable()
export class ChecksumVerifier {
  private readonly logger = new Logger(ChecksumVerifier.name);

  constructor(@Inject(PackLoader) private readonly pack: PackLoader) {}

  async verify(): Promise<number> {
    const manifest = await readFile(this.pack.path("checksums.sha256"), "utf8");
    const problems: string[] = [];
    let checked = 0;

    for (const line of manifest.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed);
      if (!match) {
        problems.push(`unparseable checksum line: ${trimmed}`);
        continue;
      }
      const [, expected, relPath] = match as unknown as [string, string, string];

      let actual: string;
      try {
        actual = await this.sha256(this.pack.path(relPath));
      } catch {
        problems.push(`${relPath}: missing`);
        continue;
      }

      checked += 1;
      if (actual !== expected) {
        problems.push(`${relPath}: expected ${expected}, got ${actual}`);
      }
    }

    if (problems.length > 0) throw new ChecksumMismatchError(problems);

    this.logger.log(`pack checksums verified (${checked} files)`);
    return checked;
  }

  private async sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex");
  }
}
