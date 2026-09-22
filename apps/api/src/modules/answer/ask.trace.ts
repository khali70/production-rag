import type { Answer } from "./answer.types.js";
import type { AskOptions, AskResult } from "./answer.service.js";

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

const fmtCos = (c: number | null) => (c === null ? " n/a " : c.toFixed(3));

function step(n: number | string, title: string, meta?: string): string {
  return `\n${RULE}\nSTEP ${n}  ${title}${meta ? `   (${meta})` : ""}\n${RULE}\n`;
}

export function formatAnswer(answer: Answer): string {
  const out: string[] = [`STATUS: ${answer.status.toUpperCase()}`, "", answer.message];
  if (answer.warnings.length > 0) {
    out.push("", "Checks:");
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
    `Mode:      ${o.mode}${o.mode === "retrieval" ? " (best reranked chunk is the answer, no LLM)" : ""}`,
    o.mode === "llm" ? `LLM:       ${ctx.llm.modelId} @ ${ctx.llm.baseUrl}` : `Reranker:  ${debug.rerank?.modelId ?? (o.rerank ? "not reached" : "off")}`,
    `Options:   topK=${o.topK} order=${o.orderBy} statuses=${(o.includeStatuses ?? ["current"]).join(",")} ` +
      `asOf=${o.asOf ?? "today"} minCosine=${o.minCosine ?? "none"} gateCosine=${o.gateCosine} ` +
      `cosineMargin=${o.relativeCosineMargin} maxContextChars=${o.maxContextChars} versionChunks=${o.versionChunks} relatedChunks=${o.relatedChunks} ` +
      `rerank=${o.rerank ? `pool:${o.rerank.pool},min:${o.rerank.minScore}` : "off"}`,
    `Total:     ${(debug.totalMs / 1000).toFixed(1)} s`,
    "",
    `Pipeline:  embed -> retrieve -> gate -> ${o.rerank ? "rerank -> " : ""}off-topic filter -> ` +
      (o.mode === "retrieval"
        ? "best match -> answer"
        : "related documents -> other versions -> resolve authority -> prompt -> LLM -> finalize -> answer"),
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
      "     text:",
      indent(c.text.trim(), "       "),
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
    if (debug.rerank) {
      out.push("Reranker order (whole pool):");
      const ranked = [...debug.retrieved].sort((a, b) => debug.rerank!.scores[b.chunkId]! - debug.rerank!.scores[a.chunkId]!);
      for (const [i, c] of ranked.entries()) {
        const kept = debug.rerank.kept.includes(c);
        const tag = !kept ? "cut (below top k)" : debug.offTopic.includes(c) ? "dropped (below min score)" : "kept";
        out.push(
          `  ${String(i + 1).padStart(2)}. rerank=${debug.rerank.scores[c.chunkId]!.toFixed(4)}  cosine=${fmtCos(c.cosine)}  ` +
            `${c.source.documentId} v${c.source.version} [${c.source.sectionPath.join(" > ")}]  ${tag}`,
        );
      }
      out.push("");
    }
    if (debug.offTopic.length === 0) out.push("Nothing dropped.");
    for (const c of debug.offTopic) {
      const score = debug.rerank ? `rerank=${debug.rerank.scores[c.chunkId]!.toFixed(4)}` : `cosine=${fmtCos(c.cosine)}`;
      out.push(`Dropped: ${c.source.documentId} v${c.source.version} [${c.source.sectionPath.join(" > ")}] ${score}`);
    }

    if (o.mode === "retrieval") {
      // 5. Best match
      out.push(step(5, "BEST MATCH (no LLM)"));
      const b = debug.best;
      if (b) {
        const rr = debug.rerank?.scores[b.chunkId];
        out.push(
          "The best remaining chunk is returned verbatim as the answer: the highest reranked one,",
          "except that a current version beats a higher-ranked old one unless the question asks about the past.",
          "",
          `${b.source.documentId} v${b.source.version}  "${b.source.title}"`,
          `    section: ${b.source.sectionPath.join(" > ")}   chunk ${b.source.chunkIndex}`,
          `    status=${b.status} from=${b.effectiveFrom} trust=${b.trust} role=${debug.evidence[0]?.role ?? "?"}`,
          `    cosine=${fmtCos(b.cosine)}${rr === undefined ? "" : `  rerank=${rr.toFixed(4)}`}`,
          `    why: ${debug.bestReason ?? ""}`,
        );
      }
      if (answer.warnings.length > 0) out.push("", ...answer.warnings.map((w) => `! ${w}`));
      out.push(step(6, "FINAL ANSWER"));
      out.push(formatAnswer(answer), "");
      return out.join("\n");
    }

    // 4b. Documents that amend or qualify the ones found
    out.push(step("4b", "ADD RELATED DOCUMENTS (AMENDS / QUALIFIES)", `${debug.related.ms} ms, ${debug.related.chunks.length} chunks`));
    out.push(
      o.relatedChunks > 0
        ? `For every file found, the best ${o.relatedChunks} chunk(s) of each document related to it by an authority relation, if this user can see it.`
        : "Off (relatedChunks=0).",
      "",
    );
    if (o.relatedChunks > 0 && debug.related.chunks.length === 0) out.push("No related documents visible.");
    for (const c of debug.related.chunks) {
      out.push(
        `+  ${c.source.documentId} v${c.source.version}  "${c.source.title}"  status=${c.status} from=${c.effectiveFrom}`,
        `     section: ${c.source.sectionPath.join(" > ")}   chunk ${c.source.chunkIndex}   cosine=${fmtCos(c.cosine)}`,
        "     text:",
        indent(c.text.trim(), "       "),
        "",
      );
    }

    // 4c. Other versions of the documents found or related
    out.push(step("4c", "ADD OTHER VERSIONS OF THE FILES FOUND", `${debug.versions.ms} ms, ${debug.versions.chunks.length} chunks`));
    out.push(
      o.versionChunks > 0
        ? `For every file found, the best ${o.versionChunks} chunk(s) of each other version this user can see, by cosine to the question.`
        : "Off (versionChunks=0).",
      "",
    );
    if (o.versionChunks > 0 && debug.versions.chunks.length === 0) out.push("No other versions visible.");
    for (const c of debug.versions.chunks) {
      out.push(
        `+  ${c.source.documentId} v${c.source.version}  "${c.source.title}"  status=${c.status} from=${c.effectiveFrom}`,
        `     section: ${c.source.sectionPath.join(" > ")}   chunk ${c.source.chunkIndex}   cosine=${fmtCos(c.cosine)}`,
        "     text:",
        indent(c.text.trim(), "       "),
        "",
      );
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
      "Priority 1 wins. It follows role, then level, tier and date; equal-authority primaries share it.",
      "",
    );
    for (const d of debug.evidence) {
      out.push(
        `${d.id}  priority ${d.priority}  ${d.role.toUpperCase()}${d.equalAuthority ? " (equal authority with another primary)" : ""}`,
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
    out.push(step(7, "LLM GENERATION", `${debug.generations.length} call(s)`));
    for (const [i, g] of debug.generations.entries()) {
      out.push(
        `${THIN}\nAttempt ${i + 1}: ${g.modelId}   ${(g.latencyMs / 1000).toFixed(1)} s   tokens in=${g.usage.inputTokens} out=${g.usage.outputTokens}\n${THIN}`,
      );
      const reasoning = ctx.reasoning[i]?.trim();
      if (reasoning) out.push("", "Model reasoning (thinking, not part of the answer):", "", indent(reasoning));
      out.push("", "Raw output:", "", indent(debug.raw[i] ?? ""), "");
    }

    // 8. Validation
    out.push(step(8, "FINALIZE THE ANSWER (no LLM)"));
    out.push(
      "Detect a refusal; append the documents the model was given as sources;",
      "flag any number in the answer that the documents, the question and today's date do not contain,",
      "and any number only an old version contains, unless its sentence says it is old.",
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
