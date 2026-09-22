#!/usr/bin/env bash
# =============================================================================
# Ask one question through the full RAG pipeline and print a human-readable
# trace of every step:
#
#   embed -> search -> gate -> [rerank] -> off-topic filter -> authority
#         -> prompt -> LLM -> finalize -> answer
#
# Usage:
#   pnpm --filter api trace "who approves a regulated vendor"
#   pnpm trace "who approves a regulated vendor"                  (from the repo root)
#   pnpm --filter api trace --user u-fin-201 --k 5 "who approves a regulated vendor"
#
# Edit the settings below. An empty value means "use whatever .env says".
# Values set here override .env for this run only; .env is never modified.
# Flags passed on the command line win over the settings below
# (same flags as `pnpm --filter api ask`).
# =============================================================================
set -euo pipefail

# ---- Who is asking (permissions are resolved server-side from this id) -----
USER_ID="u-proc-310"

# ---- Embedding model --------------------------------------------------------
# Changing the model or dim needs a re-ingest first:  pnpm ingest --reindex
# Otherwise search stops with "Embedding index mismatch".
EMBEDDING_PROVIDER=""          # transformers | fake
EMBEDDING_MODEL_ID=""          # e.g. Xenova/bge-small-en-v1.5
EMBEDDING_DIM=""               # must match the model, e.g. 384
EMBEDDING_DTYPE=""             # fp32 | fp16 | q8 | int8 | uint8 | q4

# ---- Reranker (cross-encoder) ----------------------------------------------
RERANK=true                    # true | false
RERANKER_PROVIDER=""           # transformers | fake
RERANKER_MODEL_ID=""           # e.g. Xenova/bge-reranker-base
RERANKER_DTYPE=""              # fp32 | fp16 | q8 | int8 | uint8 | q4
RERANK_POOL=20                 # chunks fetched from search for the reranker
RERANK_MIN=0.1                 # drop chunks with reranker score below this

# ---- LLM --------------------------------------------------------------------
LLM_PROVIDER=""                # openai-compat | fake
LLM_BASE_URL=""                # e.g. http://localhost:11434 (Ollama, no /v1)
LLM_MODEL_ID=""                # e.g. qwen3:4b
LLM_MAX_TOKENS=""              # e.g. 1500
LLM_DISABLE_THINKING=""        # true for Qwen3-style thinking models
# LLM_API_KEY is deliberately not here: keep secrets in .env only.

# ---- Retrieval --------------------------------------------------------------
TOP_K=8                        # chunks that reach the LLM
ORDER="precedence"             # precedence | relevance (ignored when RERANK=true)
STATUSES="current"             # comma list: current,superseded,retired
AS_OF=""                       # YYYY-MM-DD, empty = today
MIN_COSINE=""                  # SQL floor on the vector leg, empty = none
GATE_COSINE=0.3                # refuse without an LLM call if best cosine is below (model-specific: arctic-m off-topic <= 0.27, on-topic >= 0.31)
COSINE_MARGIN=0.15             # off-topic filter when not reranking
MAX_CONTEXT_CHARS=12000        # evidence budget in the prompt

# ---- Output -----------------------------------------------------------------
BUILD=true                     # rebuild the API before running
PRINT_TRACE=true               # print the full trace file after the answer
# =============================================================================

if [[ $# -eq 0 ]]; then
  echo 'Usage: pnpm --filter api trace [ask flags] "your question"' >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Export only the settings that were filled in, so empty ones fall back to .env.
override() {
  local name="$1" value="$2"
  if [[ -n "$value" ]]; then
    export "$name=$value"
    echo "  override $name=$value"
  fi
}
echo "Settings from this script (everything else comes from .env):"
override EMBEDDING_PROVIDER   "$EMBEDDING_PROVIDER"
override EMBEDDING_MODEL_ID   "$EMBEDDING_MODEL_ID"
override EMBEDDING_DIM        "$EMBEDDING_DIM"
override EMBEDDING_DTYPE      "$EMBEDDING_DTYPE"
override RERANKER_PROVIDER    "$RERANKER_PROVIDER"
override RERANKER_MODEL_ID    "$RERANKER_MODEL_ID"
override RERANKER_DTYPE       "$RERANKER_DTYPE"
override LLM_PROVIDER         "$LLM_PROVIDER"
override LLM_BASE_URL         "$LLM_BASE_URL"
override LLM_MODEL_ID         "$LLM_MODEL_ID"
override LLM_MAX_TOKENS       "$LLM_MAX_TOKENS"
override LLM_DISABLE_THINKING "$LLM_DISABLE_THINKING"

if [[ "$BUILD" == "true" ]]; then
  echo "Building the API..."
  pnpm --silent build
fi

TRACE_FILE="traces/ask-$(date +%Y%m%d-%H%M%S)-${USER_ID}.txt"

ARGS=(
  --user "$USER_ID"
  --k "$TOP_K"
  --order "$ORDER"
  --statuses "$STATUSES"
  --gate-cosine "$GATE_COSINE"
  --cosine-margin "$COSINE_MARGIN"
  --max-context-chars "$MAX_CONTEXT_CHARS"
  --trace-file "$TRACE_FILE"
)
[[ -n "$AS_OF" ]] && ARGS+=(--as-of "$AS_OF")
[[ -n "$MIN_COSINE" ]] && ARGS+=(--min-cosine "$MIN_COSINE")
[[ "$RERANK" == "true" ]] && ARGS+=(--rerank --rerank-pool "$RERANK_POOL" --rerank-min "$RERANK_MIN")

# Script defaults first, command-line args last: for repeated flags the last one wins.
node apps/api/dist/cli/ask.js "${ARGS[@]}" "$@"

if [[ "$PRINT_TRACE" == "true" && -f "$TRACE_FILE" ]]; then
  echo
  cat "$TRACE_FILE"
  echo
  echo "Trace saved to $TRACE_FILE"
fi
