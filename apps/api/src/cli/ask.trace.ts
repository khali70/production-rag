import type { Answer, Citation } from "../modules/answer/answer.schema.js";
import type { AskOptions, AskResult } from "../modules/answer/answer.service.js";

/**
 * Human-readable trace of one ask, every stage from query embedding to the
 * final answer. Holds document text and the full prompt: local debugging only.
 */
export type TraceContext = {
  startedAt: Date;
  user: { id: string; groups: string[] };
  question: string;
  options: AskOptions;
  embedding: { modelId: string; prefixScheme: string };
  llm: { modelId: string; baseUrl: string };
  /** Reasoning text streamed per attempt; never part of the answer. */
  reasoning: string[];
};

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

const indent = (text: string, pad = "    ") =>
  text
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

const fmtCos = (c: number | null) => (c === null ? " n/a " : c.toFixed(3));

function step(n: number, title: string, meta?: string): string {
  return `\n${RULE}\nSTEP ${n}  ${title}${meta ? `   (${meta})` : ""}\n${RULE}\n`;
}

export function formatCitations(cs: Citation[]): string {
  return cs.map((c) => c.id).join(",");
}

export function formatAnswer(answer: Answer): string {
  const out: string[] = [`STATUS: ${answer.status.toUpperCase()}`, "", answer.summary];
  if (answer.claims.length > 0) {
    out.push("", "Claims:");
    for (const c of answer.claims) out.push(`  - ${c.text} [${formatCitations(c.citations)}]`);
  }
  if (answer.conflicts.length > 0) {
    out.push("", "Conflicts:");
    for (const c of answer.conflicts) out.push(`  - ${c.description} [${formatCitations(c.citations)}]`);
  }
  if (answer.missing.length > 0) {
    out.push("", "Not covered by the sources:");
    for (const m of answer.missing) out.push(`  - ${m}`);
  }
  const sources = new Map<string, Citation>();
  for (const c of [...answer.claims, ...answer.conflicts].flatMap((x) => x.citations)) sources.set(c.id, c);
  if (sources.size > 0) {
    out.push("", "Sources:");
    for (const c of [...sources.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const s = c.source;
      out.push(`  ${c.id}  ${s.title} (${s.documentId} v${s.version}, ${c.role})`, `      ${s.sourcePath}`);
    }
  }
  if (answer.warnings.length > 0) {
    out.push("", "Validator notes:");
    for (const w of answer.warnings) out.push(`  ! ${w}`);
  }
  return out.join("\n");
}

export function formatTrace(ctx: TraceContext, result: AskResult): string {
  const { answer, debug } = result;
  const o = ctx.options;
  const out: string[] = [];

  out.push(
    RULE,
    "ASK TRACE",
    RULE,
    `Time:      ${ctx.startedAt.toISOString()}`,
    `User:      ${ctx.user.id}  groups=[${ctx.user.groups.join(", ")}]`,
    `Question:  ${ctx.question}`,
    `LLM:       ${ctx.llm.modelId} @ ${ctx.llm.baseUrl}`,
    `Options:   topK=${o.topK} order=${o.orderBy} statuses=${(o.includeStatuses ?? ["current"]).join(",")} ` +
      `asOf=${o.asOf ?? "today"} minCosine=${o.minCosine ?? "none"} gateCosine=${o.gateCosine} ` +
      `cosineMargin=${o.relativeCosineMargin} maxContextChars=${o.maxContextChars} ` +
      `rerank=${o.rerank ? `pool:${o.rerank.pool},min:${o.rerank.minScore}` : "off"}`,
    `Total:     ${(debug.totalMs / 1000).toFixed(1)} s`,
    "",
    `Pipeline:  embed -> retrieve -> gate -> ${o.rerank ? "rerank -> " : ""}off-topic filter -> resolve authority -> prompt -> LLM -> parse -> validate -> answer`,
  );

  // 1. Embedding
  out.push(step(1, "EMBED THE QUESTION", `${debug.embedding.ms} ms`));
  out.push(
    `Model:        ${ctx.embedding.modelId}`,
    `Scheme:       ${ctx.embedding.prefixScheme}`,
    `Dimensions:   ${debug.embedding.dim}`,
    `First values: [${debug.embedding.preview.map((v) => v.toFixed(4)).join(", ")}, ...]`,
    "",
    "The question is turned into a vector with the query prefix. Documents were embedded without it at ingest.",
  );

  // 2. Retrieval
  out.push(step(2, "RETRIEVE CHUNKS FROM THE VECTOR DB", `${debug.searchMs} ms, ${debug.retrieved.length} chunks`));
  out.push(
    "Hybrid search: vector similarity + Postgres full-text, fused with RRF.",
    "Permissions, soft delete, status and effective date are filtered INSIDE the SQL,",
    "so chunks this user may not see never appear here.",
    "",
  );
  if (debug.retrieved.length === 0) out.push("(no chunks visible to this user matched)");
  for (const [i, c] of debug.retrieved.entries()) {
    const dropped = debug.offTopic.includes(c);
    const cut = debug.rerank !== undefined && !debug.rerank.kept.includes(c);
    const rerankScore = debug.rerank?.scores[c.chunkId];
    out.push(
      `#${i + 1}  ${c.source.documentId} v${c.source.version}  "${c.source.title}"${dropped ? "   [DROPPED: off-topic]" : ""}${cut ? "   [CUT: below rerank topK]" : ""}`,
      `     section: ${c.source.sectionPath.join(" > ")}   chunk ${c.source.chunkIndex}`,
      `     tier=${c.tier} level=${c.level} rank=${c.authorityRank} status=${c.status} from=${c.effectiveFrom} trust=${c.trust}`,
      `     cosine=${fmtCos(c.cosine)}  rrf=${c.score.toFixed(4)}${rerankScore === undefined ? "" : `  rerank=${rerankScore.toFixed(4)}`}`,
      `     relations: ${c.relations.length === 0 ? "none" : c.relations.map((r) => `${r.kind} ${r.documentId} v${r.version}`).join("; ")}`,
      `     text: ${oneLine(c.text, 240)}`,
      "",
    );
  }

  // 3. Gate
  out.push(step(3, "EVIDENCE GATE (no LLM)"));
  out.push(
    `Best cosine: ${debug.bestCosine < -0.99 ? "n/a" : debug.bestCosine.toFixed(3)}   threshold: ${o.gateCosine}`,
    debug.gate
      ? `Result: REFUSE without calling the model (${debug.gate})`
      : "Result: PASS, the evidence is strong enough to try an answer",
  );

  if (!debug.gate) {
    // 4. Off-topic filter
    const floor = debug.bestCosine - o.relativeCosineMargin;
    out.push(step(4, o.rerank ? "RERANK, THEN DROP OFF-TOPIC CHUNKS" : "DROP OFF-TOPIC CHUNKS", debug.rerank ? `${debug.rerank.ms} ms` : undefined));
    out.push(
      debug.rerank
        ? `Reranker ${debug.rerank.modelId} kept the top ${debug.rerank.kept.length} of ${debug.retrieved.length}; keep those with rerank >= ${o.rerank!.minScore}`
        : `Keep chunks with cosine >= best - margin = ${debug.bestCosine.toFixed(3)} - ${o.relativeCosineMargin} = ${floor.toFixed(3)}`,
      "",
    );
    if (debug.offTopic.length === 0) out.push("Nothing dropped.");
    for (const c of debug.offTopic) {
      const score = debug.rerank ? `rerank=${debug.rerank.scores[c.chunkId]!.toFixed(4)}` : `cosine=${fmtCos(c.cosine)}`;
      out.push(`Dropped: ${c.source.documentId} v${c.source.version} [${c.source.sectionPath.join(" > ")}] ${score}`);
    }

    // 5. Authority
    out.push(step(5, "RESOLVE VERSIONS AND AUTHORITY (no LLM)", `${debug.evidence.length} documents`));
    out.push(
      "Chunks are grouped per document version, then each document gets a role:",
      "  primary     highest authority; the answer is built from it",
      "  modifier    amends / qualifies a primary, applied with it",
      "  secondary   lower authority; fills gaps, loses on conflict",
      "  supporting  record / unverified; background only",
      "  historical  superseded, retired or older version; never the current rule",
      "",
    );
    for (const d of debug.evidence) {
      out.push(
        `${d.id}  ${d.role.toUpperCase()}${d.equalAuthority ? " (equal authority with another primary)" : ""}`,
        `    ${d.documentId} v${d.version}  "${d.title}"`,
        `    tier=${d.tier} level=${d.level} rank=${d.authorityRank} status=${d.status} from=${d.effectiveFrom} owner=${d.owner}`,
        `    chunks sent: ${d.chunks.length} (${d.chunks.map((c) => c.source.sectionPath.join(" > ")).join(" | ")})`,
      );
      if (d.note) out.push(`    why: ${d.note}`);
      out.push("");
    }

    // 6. Prompt
    if (debug.prompt) {
      out.push(step(6, "PROMPT SENT TO THE LLM", `${debug.prompt.system.length + debug.prompt.user.length} chars`));
      out.push("----- SYSTEM PROMPT -----", "", debug.prompt.system, "", "----- USER PROMPT -----", "", debug.prompt.user);
    }

    // 7. Generation
    out.push(step(7, "LLM GENERATION", `${debug.generations.length} attempt(s)`));
    for (const [i, g] of debug.generations.entries()) {
      const err = debug.parseErrors[i];
      out.push(
        `${THIN}\nAttempt ${i + 1}: ${g.modelId}   ${(g.latencyMs / 1000).toFixed(1)} s   tokens in=${g.usage.inputTokens} out=${g.usage.outputTokens}\n${THIN}`,
      );
      const reasoning = ctx.reasoning[i]?.trim();
      if (reasoning) out.push("", "Model reasoning (thinking, not part of the answer):", "", indent(reasoning));
      out.push("", "Raw output:", "", indent(debug.raw[i] ?? ""), "", `Parse: ${err === null ? "OK, matches the JSON schema" : `FAILED (${err})`}`, "");
    }

    // 8. Validation
    out.push(step(8, "VALIDATE THE ANSWER AGAINST THE EVIDENCE (no LLM)"));
    out.push(
      "Checks: every citation id was in the prompt; every claim has a citation;",
      "every number in a claim / the summary appears in the cited text;",
      "claims rest on primary / modifier / secondary documents; modifiers are not ignored.",
      "",
    );
    if (answer.warnings.length === 0) out.push("All checks passed.");
    for (const w of answer.warnings) out.push(`! ${w}`);
  }

  // 9. Answer
  out.push(step(9, "FINAL ANSWER"));
  out.push(formatAnswer(answer), "");
  return out.join("\n");
}
