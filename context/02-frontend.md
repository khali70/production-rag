# Frontend plan

## Decision
Reuse the shell of https://github.com/khali70/AI_Rag_demo `frontend/` (Next.js 14 App Router, Tailwind, React Query). Rebuild the pages. The UI carries no scoring weight; its job is to demo the 4 incidents and make trust logic visible.

## Keep
- `package.json` stack, Tailwind config, `components/providers.tsx`, `app/layout.tsx`.
- Two-column layout from `app/chat/page.tsx` (session sidebar optional, lean toward dropping).
- `getApiBase` idea from `lib/api.ts`, rewritten with env validation (fail fast, no silent localhost default in prod).

## Drop
- `auth/login`, `auth/signup`, `auth-guard`, JWT in localStorage.
- `documents/` upload (dataset is version-controlled, no file parsing needed).
- LLM-generated session titles.

## New structure
```
app/
  page.tsx          Ask: persona picker + question + answer card
  compare/page.tsx  same question, 2 personas side by side (Incident 3 demo)
  corpus/page.tsx   read-only list of docs visible to persona (id, version, status, effective date)
  eval/page.tsx     reads eval/results/latest.json: 4 cases, pass/fail, expected vs actual
components/
  persona-select.tsx
  answer-card.tsx   status badge, answer, citations, trust notes
  citation.tsx      title, version, "superseded by" marker, snippet
lib/api.ts          typed client, persona sent as X-User-Id header
lib/env.ts          env validation layer
```

## API contract expected
```ts
type AskResponse = {
  status: "answered" | "qualified" | "refused";
  answer: string;
  citations: { doc_id: string; title: string; version: number; effective_date: string; status: "current" | "retired"; snippet: string }[];
  trust_notes: string[];   // e.g. "Used v3 (2026-03); v2 retired"
  request_id: string;      // links to backend audit trace
};
```

## Security rules for the UI
- Persona is a demo stand-in for identity. Backend maps persona to groups and filters before retrieval. README must say this; Azure maps to Entra ID.
- Restricted docs never appear: no titles, no counts ("3 withheld" leaks too).
- Render document text as plain text only, never HTML.

## Packaging
Next static export served by the NestJS backend (ServeStaticModule), one run command.

## Rejected alternative
Streamlit: less code, but loses existing UI and makes compare/eval views harder.
