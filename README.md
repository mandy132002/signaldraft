# SignalDraft

Live process: **prospect → public research → exact-match ranking → LLM analysis → outreach draft**, held for a human. Not a mock. Not a send tool.

Auth: **Google sign-in** via Auth.js. Data: **MongoDB** (runs scoped to your Google account).

LLM: **Groq** (cloud). Set `GROQ_API_KEY` locally and on Vercel.

**Full documentation:** [docs/PRODUCT.md](docs/PRODUCT.md) · printable PDF: [docs/SignalDraft-Documentation.pdf](docs/SignalDraft-Documentation.pdf)

## Manual setup (required once)

### 1. MongoDB Atlas

1. Create a free cluster at [https://cloud.mongodb.com](https://cloud.mongodb.com).
2. **Database Access** → add a user (username + password).
3. **Network Access** → **Add IP Address** → for local + Vercel use `0.0.0.0/0` (or Atlas “allow access from anywhere”).
4. **Database** → **Connect** → **Drivers** → copy the `mongodb+srv://…` URI.
5. Replace `<password>` in the URI with your DB user password (URL-encode special characters).

### 2. Google OAuth (+ optional Gmail drafts)

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create or pick a project.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** (Web application).
3. Authorized JavaScript origins: `http://localhost:3000` (add your Vercel URL later).
4. Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google` (add Vercel callback later).
5. Copy **Client ID** and **Client Secret**.

**Login only needs** email/profile. Gmail is requested later when you click **Allow Gmail access**.

#### Gmail drafts (fix `access_denied`)

`gmail.compose` is a **restricted** Google scope. Unverified apps in **Production** get `Error 403: access_denied`.

1. **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**:
   - User type: **External**
   - Publishing status: **Testing** (do not publish until Google verifies the app)
   - **Test users** → add the exact Google account you sign in with
   - **Scopes** → add `https://www.googleapis.com/auth/gmail.compose`
3. Sign in to SignalDraft normally, generate an email, click **Add to Gmail drafts** → **Allow Gmail access**.
4. If Google shows an unverified-app warning: **Advanced** → **Go to SignalDraft (unsafe)** (normal for local/test apps).

### 3. Env file

```bash
cp .env.example .env.local
openssl rand -base64 32   # paste into AUTH_SECRET
```

Fill `.env.local`:

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | output of `openssl rand -base64 32` |
| `AUTH_URL` | `http://localhost:3000` |
| `GOOGLE_CLIENT_ID` | from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `MONGODB_URI` | Atlas connection string |
| `MONGODB_DB` | `signaldraft` (or leave default) |
| `GROQ_API_KEY` | from [console.groq.com](https://console.groq.com/keys) |
| `GROQ_MODEL` | `openai/gpt-oss-20b` (optional) |

### 4. Groq API key

1. Create an account at [https://console.groq.com](https://console.groq.com)
2. **API Keys** → create a key
3. Set `GROQ_API_KEY=...` in `.env.local` (default model: `openai/gpt-oss-20b`)

### 5. Run the app locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → **Continue with Google** → then use Live / **Bulk** / Dashboard.

Collections created automatically in MongoDB: Auth.js (`users`, `accounts`, `sessions`, …), app `runs`, and `bulk_jobs`.

> Prior `data/runs.json` history is **not** migrated. New runs are per Google account in MongoDB.

## Deploy on Vercel (free)

### A. Groq key

1. [console.groq.com/keys](https://console.groq.com/keys) → create API key.

### B. Push repo & import

1. Push this project to GitHub.
2. [vercel.com](https://vercel.com) → **Add New Project** → import the repo.
3. Framework: **Next.js** (auto-detected).

### C. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | same as local (or new `openssl rand -base64 32`) |
| `AUTH_URL` | `https://YOUR_PROJECT.vercel.app` |
| `GOOGLE_CLIENT_ID` | same |
| `GOOGLE_CLIENT_SECRET` | same |
| `MONGODB_URI` | Atlas URI |
| `MONGODB_DB` | `signaldraft` |
| `GROQ_API_KEY` | from Groq |
| `GROQ_MODEL` | `openai/gpt-oss-20b` (optional) |

### D. Google OAuth for production

In Google Cloud → your OAuth client:

- **Authorized JavaScript origins:** add `https://YOUR_PROJECT.vercel.app`
- **Authorized redirect URIs:** add `https://YOUR_PROJECT.vercel.app/api/auth/callback/google`

### E. Deploy

Click **Deploy**. After it finishes, open the Vercel URL, sign in with Google, run a Live draft.

**Notes**

- Hobby Vercel has function time limits; Live runs are fine; large **Bulk** jobs may need Resume if a batch times out.
- Atlas must allow network access from Vercel (`0.0.0.0/0` is simplest for a personal project).

## Bulk CSV

1. Open **Bulk** in the nav (or [/bulk](http://localhost:3000/bulk)).
2. Download the template (or use `public/signaldraft-prospects.csv`).
3. Required columns: `fullName` (or `name`), `company`. Optional: `title`, `linkedinUrl`, `companyWebsite`, `notes`.
4. Set your sender defaults → start research (up to 40 rows, one-at-a-time).
5. Review drafts in the queue → **Approve & store** / **Reject & store**.

## Pipeline

| Stage | What happens |
| --- | --- |
| Exact company match | Wikipedia (quoted name) |
| News / funding / hiring | Google News RSS + Hacker News, exact-name filter |
| Rank | Keep person+company hooks; drop lookalike collisions |
| **LLM analysis** | Groq → sentiment, business impact, outreach angle |
| **Draft** | LLM writes a short sendable email |
| Review | Approve / reject — **nothing is auto-sent** |

> Groq model IDs change. If Logs show `model_not_found` on fallbacks, see [docs/RCA-GROQ-FAILURES.md](docs/RCA-GROQ-FAILURES.md).

## Edge cases

The pipeline prefers a **hold** over a wrong or invented email. Details: [docs/EDGE_CASES.md](docs/EDGE_CASES.md).

| Case | Example | Outcome |
| --- | --- | --- |
| Lookalike company | Cube Global vs CUBE / Cube Logic | Dropped — exact phrase required |
| Same short name | Cube vs Cube.dev vs other Cubes | LinkedIn workplace used to pick the right org — see [docs/SAME_NAME_COMPANIES.md](docs/SAME_NAME_COMPANIES.md) |
| Person at another org | Bezos / Amazon vs Blue Origin news | Not used as the hook |
| No public hook | Low-coverage company | Internal hold — Gmail disabled |
| Sensitive news | Layoffs, lawsuit, death, breach | Safer hook if one exists; else caution draft |

## Demo

1. Sign in with Google.
2. Prefill is Jeff Bezos / Amazon (or any public company).
3. Ensure `GROQ_API_KEY` is set in `.env.local`.
4. Hit **Research & draft email**, narrate stages.
5. Approve and open **Dashboard** (your runs only).
