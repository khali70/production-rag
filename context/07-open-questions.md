# Open questions

Frontend
- [ ] Next static export served by Nest (one command) vs two processes via docker-compose?
- [ ] Keep chat sessions/history or single Q&A? (lean single: multi-turn adds context-leak risk)
- [ ] Upgrade to Next 15 / React 19 or stay on 14?

Backend
- [ ] pnpm monorepo `apps/api` + `apps/web` OK?
- [ ] Ollama as prerequisite, or in-process node-llama-cpp?
- [ ] ACL model: group allow-list + classification enough, or add per-user deny?
- [ ] Docker OK for pgvector, or LanceDB embedded as local default?
- [ ] Qdrant as real second adapter now, or stub later?
- [ ] Does the corpus include Arabic? (drives bge-m3 vs bge-small)

Next step once answered: scaffold Nest + Next shell, data folder, eval runner skeleton.
