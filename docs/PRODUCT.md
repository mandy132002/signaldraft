# SignalDraft — Product Documentation

**Version:** 1.0 · **Stack:** Next.js 15 · Auth.js · MongoDB Atlas · Groq  
**Generated:** 23 August 2026

> Live process: prospect → public research → exact-match ranking → Groq analysis → outreach draft, held for a human. Not a mock. Not a send tool.

A printable PDF of this document is at [`SignalDraft-Documentation.pdf`](./SignalDraft-Documentation.pdf).

---

## 1. Product overview

SignalDraft helps an SDR research a named person at a named company and produce a real first-touch email grounded in a checkable public hook. The output is the email the SDR would send — not a pitch for SignalDraft itself.

**Core promise**

- Live process (Wikipedia, Google News RSS, Hacker News, Groq)
- Exact person + company matching
- Human in the loop — nothing is auto-sent
- Prefer a hold over a wrong or invented email

| Surface | Route | Purpose |
| --- | --- | --- |
| Live run | `/` | One prospect → stages → draft → review |
| Bulk | `/bulk` | CSV upload, sequential research, review queue |
| Dashboard | `/history` | Saved runs, KPIs, edit / approve / Gmail |
| Login | `/login` | Google sign-in via Auth.js |

## 2. Problem statement

An SDR enters prospect details (e.g. Jeff Bezos at Amazon) and needs an outreach email that cites a relevant public hook. Research breaks down when company names collide (Cube Global vs Cube Logic) or when the person appears under another employer (Bezos / Blue Origin while researching Amazon).

SignalDraft automates public signal gathering, exact-name ranking, Groq entity confirmation, sentiment/impact analysis, and a short cold email for human review.

## 3. Architecture & stack

| Layer | Choice | Notes |
| --- | --- | --- |
| App | Next.js 15 (App Router) | React 19, TypeScript |
| Auth | Auth.js + Google OAuth | JWT sessions; MongoDB adapter |
| Data | MongoDB Atlas | Runs / bulk jobs scoped by `userId` |
| LLM | Groq only | Default `openai/gpt-oss-20b` |
| Email drafts | Gmail API (optional) | Incremental `gmail.compose` |
| Hosting | Vercel | Edge-safe middleware via `getToken` |

**Auth layout:** `auth.config.ts` (Edge-safe) · `auth.ts` (Google + adapter, Node) · `middleware.ts` (`getToken`).

**Collections:** Auth.js `users` / `accounts` / `sessions`; app `runs`, `bulk_jobs`. Prior `data/runs.json` is not migrated.

## 4. Research & draft pipeline

| Stage | What happens |
| --- | --- |
| Intake | Validate name + company; LinkedIn / notes / offer |
| Company + LinkedIn | Wikipedia (quoted exact name); optional LinkedIn |
| News & funding | Google News RSS |
| Person signals | Person + company; HN (full company phrase) |
| Soft-rank | Score exact / soft / suspect / person |
| Groq entity match | Confirm right org / person |
| Groq analysis | Sentiment, impact, angle, risk flags |
| Draft | Short cold email + Low / Medium / High confidence |
| Review | Edit, refine, approve/reject, optional Gmail — not sent |

Matching: multi-word names never shorten to the first token; sendable hooks must contain the exact company phrase; person-only other-employer stories cannot be the primary hook.

## 5. Features by surface

**Live:** intake form, stage timeline, signals, Groq entity/analysis, refine, approve/reject, Gmail, hold/sensitive callouts, session restore.

**Bulk:** CSV template; required `fullName`/`name` + `company`; up to 40 rows; review queue; Resume on timeout.

**Dashboard:** KPIs with loading skeletons (no flash of zeros); search; edit; store; confidence badge.

## 6. Edge cases

See also [`EDGE_CASES.md`](./EDGE_CASES.md).

1. **Lookalike companies** (Cube Global vs CUBE) — full phrase + safety net.
2. **Person–company split** (Bezos / Amazon vs Blue Origin) — company required on hook.
3. **No confirmed hook** — internal hold; Gmail/Refine disabled.
4. **Sensitive news** — prefer safer hook; else sober tone + Medium cap.

Residual: single-token brands, common names, stale hooks (>~18 months).

## 7. Draft confidence

| Rating | Meaning |
| --- | --- |
| High | Clear entity + pack-grounded facts + natural offer bridge |
| Medium | Solid company match; thin/older hook or inferred offer link |
| Low | Weak/sensitive hook or hold |

Sensitive / rewritten drafts cannot stay High. Holds stay Low.

Groq entity check uses a larger completion budget and model fallbacks so reasoning models do not return empty JSON.

## 8. Local setup

1. MongoDB Atlas cluster + user + network access (`0.0.0.0/0` for local+Vercel).
2. Google OAuth web client: origin `http://localhost:3000`, redirect `…/api/auth/callback/google`.
3. Env:

```bash
cp .env.example .env.local
openssl rand -base64 32   # AUTH_SECRET
```

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | Random secret |
| `AUTH_URL` | `http://localhost:3000` (bare URL only) |
| `GOOGLE_CLIENT_ID` / `SECRET` | Google Cloud |
| `MONGODB_URI` / `MONGODB_DB` | Atlas / `signaldraft` |
| `GROQ_API_KEY` / `GROQ_MODEL` | Groq / `openai/gpt-oss-20b` |

```bash
npm install && npm run dev
npm test && npm run build
```

## 9. Vercel deployment

Set production env vars (`AUTH_URL=https://YOUR_PROJECT.vercel.app`), add Google origin/callback, deploy.  
Project URL used here: `https://signaldraft-sand.vercel.app`. Bulk may need Resume on Hobby timeouts.

## 10. Gmail drafts

Login = email/profile only. Enable Gmail API; OAuth Testing + test user + `gmail.compose`. Hold notes cannot go to Gmail. Tokens persist in JWT + MongoDB on sign-in.

## 11. API map

| Route | Role |
| --- | --- |
| `/api/auth/[...nextauth]` | Auth.js |
| `/api/runs/start` | Live SSE pipeline |
| `/api/runs`, `/api/runs/[id]` | List / get / approve / save |
| `/api/runs/[id]/refine` | Refine draft |
| `/api/bulk`, `/api/bulk/[id]`, `…/process` | Bulk jobs |
| `/api/gmail/draft` | Gmail draft |
| `/api/health` | Env debug |

## 12. Key files

`lib/pipeline.ts`, `research.ts`, `relevance.ts`, `edge-cases.ts`, `llm.ts`, `draft.ts`, `gmail.ts`, `auth.ts`, `auth.config.ts`, `middleware.ts`, `docs/EDGE_CASES.md`, `lib/edge-cases.test.ts`.

## 13. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Entity check failed | Check `GROQ_API_KEY` / model fallbacks |
| `model_not_found` | Fallback IDs must be live — see [RCA-GROQ-FAILURES.md](./RCA-GROQ-FAILURES.md). Use `openai/gpt-oss-20b` / `120b` / `qwen/qwen3.6-27b` |
| Rate limit (429) | Wait / fallback; free tier RPM is low — space Live runs or upgrade |
| Auth 500 | Bare `AUTH_URL` value |
| Middleware fail | Edge-safe `getToken` middleware |
| Gmail `access_denied` | Testing + test user |
| Wrong company | Exact match + hold; add LinkedIn/notes |

---

*SignalDraft — not a send tool. Every outreach draft requires human review.*
