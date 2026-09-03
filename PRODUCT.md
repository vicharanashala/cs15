# Crowd Source FAQ — Product Overview

A self-maintaining FAQ + community Q&A portal. Combines semantic vector search, AI-powered ingestion, and an expert promotion layer so the right answer is in front of a user before they finish typing.

---

## What it does

Four zero-touch pillars, in order of automation:

1. **Ingest** — Zoom recordings, manual uploads (PDF/DOCX/XLSX/images), and webhooks feed a knowledge base. No human scheduling or categorising.
2. **Answer** — Unanswered community posts are auto-matched against the knowledge base every 24h via semantic search. High-confidence matches are auto-posted; low-confidence escalate to admins.
3. **Quality** — Approved FAQs are re-evaluated every 6h for drift, contradictions, and staleness. Drift is auto-flagged.
4. **Lifecycle** — User deletion is anonymisation, not destruction. Reputation, attribution, and audit history persist.
- **Real-time observability** — tagged colored logs (`[ INFO ] [ cron ]` etc.), Discord ALERT webhook, optional Sentry.

---
---

## Offline Mode

The application supports Progressive Web App (PWA) functionality to improve usability when internet connectivity is unavailable.

### Features

- Displays an offline banner when the user loses internet connectivity.
- Allows access to previously cached FAQ pages.
- Provides a Retry button to refresh the application when the network is restored.
- Improves user experience by clearly indicating online and offline status.
## Key features

- **Hybrid search** — vector + keyword + Reciprocal Rank Fusion. Auto-falls-back to keyword when vector search is empty.
- **Public FAQ portal** — no-auth browse path, batch-scoped, with popularity ranking and guest analytics.
- **Community Q&A** — posts + threaded comments + upvotes + AI auto-answer; admin escalation flow.
- **Session Support** — student issue tracker with 4-step troubleshooting checklists, evidence uploads, admin follow-ups.
- **Golden Tickets** — admin-promoted high-priority support requests with Spurti Points (SP) economy and 48h cooldown.
- **Reputation system** — points, tier ladder (newcomer → knowledge_master), auto-awarded badges.
- **Admin panel** — FAQs, users, golden tickets, support inbox, AI settings, feature flags, batches, categories.
- **Real-time observability** — tagged colored logs (`[ INFO ] [ cron ]` etc.), Discord ALERT webhook, optional Sentry.

---

## Tech stack (one-liner per layer)

| Layer | Pick |
|---|---|
| Frontend | React 18 + Vite + TS + Tailwind + Framer Motion |
| Backend | Node 22 + Express 4 + TS (ESM) + Mongoose 8 |
| DB | MongoDB Atlas (with Vector Search) + Upstash Redis (optional cache) + Cloudinary (uploads) |
| Search & AI | `mixedbread-ai/mxbai-embed-large-v1` (1024-dim, via HF Inference API; falls back to in-process ONNX), RRF, Atlas `$vectorSearch` |
| AI providers | Anthropic, OpenAI, XAI, MiniMax, Gemini, custom — admin-configurable per-pipeline |
| Infra | Sentry, Ngrok (webhook dev tunnel), Twilio (SMS), SMTP, Helmet, express-rate-limit, JWT, bcryptjs |

---

## Recent changes (v1.68)

- **Embedding model swap**: `Xenova/multi-qa-mpnet-base-dot-v1` (768-dim) → `mixedbread-ai/mxbai-embed-large-v1` (1024-dim, SOTA MTEB 64.68). Now routed through the HuggingFace Inference API when `HUGGINGFACE_API_KEY` is set, with a fall-back to the in-process ONNX pipeline. The retrieval-tuned query prompt (`Represent this sentence for searching relevant passages:`) is auto-prepended for queries via `generateQueryEmbedding()`.
- **Schema + data audit pass** — 3 critical, 4 high, 7 medium, 6 low fixes across the 29 Mongoose models. See [`docs/schema-audit.md`](docs/schema-audit.md).
- **Race-condition sweep** — all 8 `findByIdAndUpdate` + `save()` anti-patterns in user-facing controllers (comments, bookmarks, FAQ, posts, golden tickets) replaced with atomic `$set` / `$addToSet` / `$pull`.
- **Observability overhaul** — 11 named loggers (`authLog`, `adminLog`, `cronLog`, etc.), background-colored level tags (`[ INFO ]`, `[ WARN ]`, `[ ERR ]`, `[ ALRT ]`), glyph-prefixed lines, Discord webhook forwarder with exponential-backoff retry queue.
- **Live-data seed** — `npm run seed:live` populates 20 community posts, 8 support tickets, 2 zoom meetings, badge awards, search logs, and a populated leaderboard. Idempotent.

---

## Reference docs

| Topic | File |
|---|---|
| Full architecture deep-dive | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| AI provider configuration | [`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md) |
| Pipelines (Zoom / doc / AI extraction) | [`docs/PIPELINES.md`](docs/PIPELINES.md) |
| Batch + category scoping | [`docs/BATCH MANAGEMENT_PLAN.md`](docs/BATCH%20MANAGEMENT_PLAN.md) |
| Public FAQ page design | [`docs/PUBLIC_FAQ_PLAN.md`](docs/PUBLIC_FAQ_PLAN.md) |
| Schema-driven context fields | [`docs/SCHEMA_DRIVEN_CONTEXT_PLAN.md`](docs/SCHEMA_DRIVEN_CONTEXT_PLAN.md) |
| Public API surface | [`docs/openapi.yaml`](docs/openapi.yaml) |
| Backup strategy | [`docs/BACKUP.md`](docs/BACKUP.md) |
| MCP server integration | [`docs/MCP.md`](docs/MCP.md) |
| Schema + data audit (v1.68) | [`docs/schema-audit.md`](docs/schema-audit.md) |
| Code audit (issues tracker) | [`docs/issues.md`](docs/issues.md) |
| Progress log | [`docs/progress.md`](docs/progress.md) |
| Wire diagram | [`docs/wire.md`](docs/wire.md) |
| Context | [`docs/context.md`](docs/context.md) |
| Project README | [`README.md`](README.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Code of Conduct | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) |
| License | [`LICENSE`](LICENSE) |

---

## Useful npm scripts (backend)

| Script | What it does |
|---|---|
| `npm start` | Run backend (tsx server.ts) |
| `npm run dev` | Run with watch |
| `npm run seed` | Seed 130 FAQs from `faqs.json` |
| `npm run seed:live` | Seed realistic test data (posts, tickets, badges, zoom, etc.) |
| `npm run audit:data` | Read-only data-quality report |
| `npm run cleanup:seed` | Undo `seed:live` |
| `npm run cleanup:orphan-notifications` | Delete orphan notifications |
| `npm run recompute:tier` | Fix stale user `tier` values |
| `npm run backfill:embeddings` | Regenerate all stored vectors with the current model |
| `npm run create:vector-index -- --drop` | Drop + recreate the Atlas vector search index |
| `npm run migrate` | Add / update Mongo indexes |

---

## Repository

- GitHub: https://github.com/vicharanashala/crowd-source-faq
- License: see [`LICENSE`](LICENSE)
- Branch: `main` (active), with `MCSFAQ/main-v2` for the next iteration
