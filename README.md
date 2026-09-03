# Crowd Source FAQ (Yaksha FAQ Portal)

Full-stack FAQ portal with semantic vector search, AI-powered community moderation, and an expert promotion layer. Built to handle 1 million registered users.

GitHub: https://github.com/vicharanashala/crowd-source-faq
Full reference: [`docs/`](docs/README.md) · [Contributing](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md) · [License](./LICENSE)

---

## Vision

**Automate the FAQ lifecycle end-to-end. Zero people in the loop. Reduce the operational FAQ culture.**

Every question a user has has been asked before — and most will be asked again. The right answer should be there before the user finishes typing. The platform achieves this through four zero-touch pillars:

- **Zero-touch ingestion** — Zoom meetings, webhooks, and manual uploads feed the knowledge base without human scheduling, categorising, or approval.
- **Zero-touch answering** — A 24-hour scheduler matches unanswered posts against the knowledge base; high-confidence matches auto-post, low-confidence escalate to humans.
- **Zero-touch quality control** — Approved FAQs are re-evaluated every 6 hours; drift, contradictions, and staleness are detected and flagged automatically.
- **Zero-touch user lifecycle** — Deletion is anonymisation, not destruction. Reputation, attribution, and audit history persist.

The platform acts as the primary operator, while people handle exceptions instead of routine operations.

---

## About

Samagama (internally "Yaksha FAQ Portal") turns an organisation's accumulated conversations into a searchable, self-maintaining FAQ. It combines hybrid vector + keyword search with a community Q&A board and a fully automated ingestion pipeline that pulls transcripts from Zoom, extracts Q&A with AI, and indexes them for retrieval in seconds.

Built for organisations whose community generates more questions than a human team can answer — student cohorts, open-source projects, internal forums, customer-success communities. Target scale: 1 million registered users with constant conversational input.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture deep-dive and [docs/PIPELINES.md](docs/PIPELINES.md) for pipeline internals.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, Framer Motion, Axios, Recharts, React Router 6, Vitest |
| Backend | Node.js, Express 4, TypeScript (ESM), Mongoose 8, JWT, bcryptjs, Helmet, CORS, Morgan, Multer, Zod, express-rate-limit, dotenv, OpenAI SDK, Vitest |
| Database & Storage | MongoDB Atlas (with Vector Search), Upstash Redis (optional), LRU cache, Cloudinary |
| Search & AI | Xenova/transformers (768-dim local embeddings), Atlas Vector Search, $text search, Reciprocal Rank Fusion |
| AI Providers | Anthropic, OpenAI, XAI, MiniMax (per-pipeline configurable) |
| DevOps | Sentry, Ngrok (local webhook tunnel), Twilio (SMS), SMTP, Vitest |

---

## Quick Start

```bash
./run.sh        # Full-stack runner: env setup, ngrok, backend + frontend
```

`run.sh` prompts for `MONGODB_URI` and `JWT_SECRET` on first run, then saves them to `apps/backend/.env.local`. The script will not overwrite existing values. Session logs are written to `logs/session_*.txt`.

---

## Key Features

Eight flagship capabilities define this platform:

- **Zoom transcript ingestion with per-user OAuth** — Each user connects their own Zoom account via OAuth. Webhook-fired downloads parse VTT transcripts, extract Q&A pairs via AI, and dual-publish: `ZoomInsight` (admin-reviewed) and `TranscriptKnowledge` (auto-approved, immediately vector-searchable). Includes retry + dead-letter queue for failed meetings and admin backfill for historical meetings. See [docs/PIPELINES.md#4-zoom-ingestion-pipeline](docs/PIPELINES.md).
- **AI auto-answer pipeline for community posts** — A scheduler (every 24h) — and a one-click **Run AI** button in the admin dashboard — finds unanswered posts and searches **all three knowledge sources in parallel** (FAQ + Community Q&A + Transcript Knowledge). Best match above ≥0.85 confidence auto-posts; 0.60–0.84 queues for human review; below 0.60 (or sensitive content) escalates. When no direct match exists, the LLM is given the top gathered context to synthesize an answer. Per-pipeline AI provider configurable. See [docs/PIPELINES.md#1-auto-answer-pipeline](docs/PIPELINES.md).
- **FAQ audit pipeline** — A scheduler (every 6h) re-evaluates approved FAQs against the live knowledge base (TranscriptKnowledge + ZoomInsights). Uses AI to judge correctness and emits verdicts: `correct` (≥0.80), `drift_detected` (0.60–0.79), `contradiction` (<0.60), or `stale`. Flagged FAQs land in `/admin/faqs/review` with `reviewStatus='pending_review'`, `flagType='auto'`, and an incremented `reviewCycle`. See [docs/PIPELINES.md#2-faq-audit-pipeline](docs/PIPELINES.md).
- **FAQ freshness & staleness detection** — Every approved FAQ carries a `freshness_tier` (`evergreen` / `seasonal` / `volatile`) and a per-tier review interval. A daily cron auto-flags FAQs whose last-verified date exceeds the interval, opening a peer-review window on `/admin/faqs/review`. Anyone can vote `still_accurate` / `needs_update`; the threshold auto-verifies, otherwise it escalates to a moderator. `FreshnessBadge` on the public FAQ card surfaces verified-vs-under-review status. See [docs/PIPELINES.md#7-faq-freshness-pipeline](docs/PIPELINES.md).
- **Golden Ticket — Spurti Points escalation** — A premium user-driven escalation channel. Users spend Spurti Points (SP) to bump a time-sensitive query to the top of the admin queue (higher SP = higher priority). SP is consumed on submission; a 48h cooldown blocks repeat submissions. Admins resolve or reject — no penalty, no ban, just a single unified cooldown rule. Includes a live Escalation Queue (right column on `/golden`) sorted by SP spend, anonymous to non-admin viewers. Toggleable from `/admin/features`.
- **Batch management + public guest FAQ portal** — FAQs, categories, and analytics are scoped to a `Batch` (cohort, term, program). A first-class `Category` model replaces the old free-text field. Guests land on `/explore/select` to pick a batch, then browse the public FAQ at `/faq` with no account required. Admin can create/archive batches and promote FAQs between them. See [docs/BATCH_MANAGEMENT_PLAN.md](docs/BATCH_MANAGEMENT_PLAN.md).
- **Schema-driven context fields per support category** — Each support category (`internet`, `camera`, `microphone`, `device`, `power`, `other`) has an admin-editable schema of context fields (text, textarea, number, date, boolean, dropdown). Admins add, edit, reorder, or archive fields from `/admin/support/categories` without redeploying. The frontend renders dynamic inputs from the live schema. See [docs/SCHEMA_DRIVEN_CONTEXT_PLAN.md](docs/SCHEMA_DRIVEN_CONTEXT_PLAN.md).
- **Soft-delete with anonymization** — Deleting a user never hard-deletes their records. The account is anonymised: `isDeleted=true`, `deletedAt` timestamp, `name` becomes `Deleted User`, `email` is rewritten to a non-routable placeholder, `password` is replaced with a random UUID to break login. All posts, comments, votes, reputation logs, and audit trail entries remain intact — preserving referential integrity, attribution history, and regulatory compliance.

Other capabilities: semantic hybrid search, community Q&A board, reputation system + badges + leaderboard, SpillTheTea event-driven notifications, per-user Zoom OAuth, RAG-powered `/ask-ai` assistant with image + file attachments, soft user lifecycle, experimental feature flags, support tickets (troubleshoot → admin triage → resolution).

---
---

# Offline Mode (PWA)

The Crowd Source FAQ portal supports Progressive Web App (PWA) functionality to improve usability during network interruptions.

## Features

- Displays an offline banner when internet connectivity is lost.
- Allows users to continue browsing previously cached FAQ pages.
- Provides a Retry button to refresh content after reconnecting.
- Caches important frontend assets for faster loading.
- Automatically restores the latest data once the network becomes available.

## Benefits

- Better experience for users with unstable internet.
- Faster page loading using cached resources.
- Improved accessibility in low-connectivity environments.
## Admin Dashboard

The admin panel at `/admin` (mounted at `/api/admin/*`) provides telemetry, moderation, and operational control. Key areas:

- **Telemetry & analytics** — live stats, FAQ growth, top categories, search insights, user-activity charts, activity feed, failed-query analytics, unresolved-search tracker
- **Operational pages** — AdminDashboard, AdminFAQs, FaqReview, AdminFAQAudit, AdminAutoAnswerQueue, AdminCommunity, AdminUsers, AdminModeration, AdminZoomMeetings, AdminZoomInsights, AdminLeaderboard, AdminUnresolvedSearch, AdminAISettings, AdminSettings, AdminLogin
- **Moderation** — every ban, suspend, warn, and soft-delete recorded in `ModerationLog`; every reputation change (+2 upvote, +5 accepted answer, -2/-5 on removal) recorded in `ReputationLog`
- **AI pipeline visibility** — unified `PipelineResult` collection (30-day TTL) for both auto-answer and audit outcomes; Zoom health endpoint reports OAuth/API circuit state, cache hit rate, failing-meetings count, dead-letter count, pending-retry count; Prometheus metrics at `/api/metrics` (search latency, cache hits, RAG duration, queue depth)

For the full admin route map and per-page behaviour, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## User Experience

The user-facing app (`/`, `/faq`, `/community`, `/saved`, `/account`, `/leaderboard`) gives authenticated users full participation in the knowledge loop:

- **Discover** — hybrid semantic + keyword search at `/api/search` (public), semantic suggestions at `/api/search/suggest`, category browsing
- **Ask the community** — post creation with Zod validation, debounced duplicate detection against the FAQ base (banner + block on match), auto-normalised tags, Cloudinary image attachments
- **Engage** — upvotes with reputation-farming prevention (reverses on removal), bookmarks at `/saved`, nested comment threads with optimistic UI, accept-answer (locks verified/expert comments from edit), edit/delete own comments, share via clipboard, report and flag-outdated
- **Notifications** — in-app bell, SpillTheTea event stream (`post_answered`, `post_deleted`, etc.), per-event-type settings, email + SMS delivery
- **Reputation** — points for accepted answers, badges at thresholds, expert promotion by peer vote, public leaderboard
- **AI assistant** — RAG-powered `/ask-ai` (5/day anonymous quota via localStorage, unlimited for authenticated users), sources cited, **accepts file and image attachments (max 4 files, 10 MB each) — images sent as vision input, text files inlined into the prompt**
- **Zoom integration** — per-user OAuth from `/account`, manual `.vtt` / `.txt` / raw-text upload, last-synced status card, no admin required
- **Search feedback** — "Report missing FAQ" on zero results, admin-promotable to FAQ

For per-route behaviour and field schemas, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Project Structure

```
Crowd Source FAQ/
├── apps/
│   ├── backend/       # Express + TypeScript API
│   └── frontend/      # React + Vite SPA
├── docs/              # Full documentation      
└── run.sh             # Local dev runner (env setup, ngrok, backend + frontend)
```

---

## Environment Variables

Required: `MONGODB_URI`, `JWT_SECRET`
Optional: at least one AI provider key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `MINIMAX_API_KEY`), Zoom OAuth credentials, `CLOUDINARY_*`, `SENTRY_DSN`, Twilio + SMTP for notifications, `UPSTASH_REDIS_*`

See [docs/ARCHITECTURE.md#10-env-variables-reference](docs/ARCHITECTURE.md#10-env-variables-reference) for the full list.
Minor documentation update

---

## License

[MIT](./LICENSE) © 2026 vicharanashala
