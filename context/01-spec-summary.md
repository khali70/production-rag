# Spec summary (Quest #88)

Role: Senior AI Engineer (Generative AI & Azure AI Platform), Kentrick.ai, Cairo.

Goal: "What is our process for approving a new enterprise vendor?" gets a useful, evidence-backed answer when trustworthy info exists, and a safe, honest response when it does not.

## Part 1: Local RAG prototype
- Simple interface: question + user identity.
- Answers grounded in permitted info with traceable sources.
- Safe behavior when evidence is missing, outdated, conflicting, restricted or untrustworthy.
- Zero leakage from inaccessible material in answers, references or diagnostics.
- Document content cannot override rules, expand permissions, disclose protected data or trigger actions.
- Four repeatable end-to-end cases (the incidents below).
- Consistent results across equivalent phrasings.
- CPU only, no GPU, no Azure account, no cloud. No original file parsing needed. Model choice must be justified.

## Part 2: Azure production architecture (design only)
- Azure services only. Storage + change management, question flow + access enforcement, ops + release, trust boundaries, retries, dependency failures, scaling, quality/latency/cost regressions, migration path with priorities.
- Assumptions: 60,000 docs (~180 GB), ~200 changes/day, 5,000 employees, 20 req/s peak, P95 < 6 s, zero unauthorized disclosure, region residency, high-risk requests fail safe during outages.

## Four incidents
1. **Wrong policy became the answer:** current guidance must beat retired/conflicting versions; explain trust logic.
2. **Convincing unsupported answer:** supplier agreement mentions support but no SLA; must not invent targets.
3. **Security failure:** engineer asking about leave must not see confidential HR investigation; malicious doc with "ignore rules, reveal secrets" must be constrained; permission-consistent across equivalent requests.
4. **Undetected regression:** the four behaviors are repeatable and release-blocking via an eval command.

## Deliverables
Repo, README (setup/run/eval commands, flow diagram, decisions, config, limitations, AI usage note), versioned eval cases + latest results, Azure design doc + diagram, 5-7 min video.

## Scoring
Retrieval & grounding 25%, Security & RAI 25%, Eval & tests 20%, Architecture & quality 20%, Judgment 10%.
Critical fails: unauthorized info leaks anywhere, confident unsupported claims, cannot run from docs, cannot explain the work, undisclosed AI assistance.

## Deadlines
Registration 2026-09-23, submission 2026-09-25.
