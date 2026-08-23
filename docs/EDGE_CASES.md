# SignalDraft edge cases

These four cases come from the original SDR problem: research a **specific person at a specific company**, then draft a **real outreach email** the SDR will review. Wrong-company hits and invented hooks are worse than sending nothing.

Nothing is auto-sent. A hold is the correct outcome when the hook is not confirmed.

## 1. Lookalike company names

**Example:** SDR enters `Santhosh Chandrashekar` / **Cube Global**. News returns `CUBE`, Cube Logic, Black Cube, “A Cube”.

**Why it happens:** Token search and HN queries used to look for the first distinctive word (`Cube`), which matches many other orgs.

**What we do:**
- Search and match the **full quoted company phrase**. Multi-word names are never shortened to `Cube`.
- `looksLikeWrongCompany` flags `Cube Logic` / lone `CUBE` when the target is Cube Global.
- After the LLM entity check, a safety net drops any “match” that does not contain the exact company phrase.
- Hacker News searches the full name, not the first token.

**What you should see:** Lookalikes stay in the candidate pool as `suspect` / rejected. They are never the chosen hook.

## 2. Person–company split

**Example:** SDR enters `Jeff Bezos` / **Amazon**. Public news also covers Blue Origin, the Earth Fund, and the Washington Post.

**Why it happens:** Person-only search (`"Jeff Bezos"`) is useful for recall, but those stories are often about another employer.

**What we do:**
- Person match requires the first and last name **near each other** (not “Jeff” in one paragraph and “Bezos” much later).
- A sendable hook **must name the target company**. Person-only items cannot be the primary hook.
- If the only hits are other-employer stories, the run **holds** (case 3).

**What you should see:** Amazon coverage can become the email. Blue Origin-only coverage cannot.

## 3. No confirmed public hook

**Example:** Cube Global (or any low-coverage company) has no exact-name news in Google News / Wikipedia / HN.

**Why it happens:** After exact-match and the person+company rule, the pool can be empty. Inventing a hook would create a generic or wrong email.

**What we do:**
- Draft is an **internal hold note**, not an outreach email (`hold: true`).
- Subject: `HOLD — no confirmed hook`. Body starts with `HOLD — do not send`.
- **Add to Gmail drafts** is disabled (API also rejects hold notes).
- Refine is disabled. You can **Store hold** on the dashboard so the miss is tracked.

**What you should do:** Add a LinkedIn URL, a more precise legal name, or a source in Notes, then run again.

## 4. Sensitive / negative news

**Example:** The only (or top) exact-company story is layoffs, a lawsuit, a death, a bankruptcy, or a data breach.

**Why it happens:** That story is a real hook, but a congratulatory “noticed the news” email is the wrong tone for a stranger.

**What we do:**
- Sensitive headlines are tagged and scored down.
- If a non-sensitive exact-company hook exists, we pick that instead.
- If the chosen hook is still sensitive: analysis cannot stay “positive”, risk flags are added, confidence is capped at medium, and the UI shows a **sensitive** warning.
- The draft must not congratulate or treat the event as a win.

**What you should see:** A caution banner on Live, Dashboard, and Bulk. Review tone before you copy the email to your mailbox.

---

## Residual risks (not fully solved)

- **Single-token brands** (`Apple`, `Delta`, `Meta`, `Cube`) can still collide. Prefer a precise name (`Cube.dev`) **and** a LinkedIn URL. See [SAME_NAME_COMPANIES.md](./SAME_NAME_COMPANIES.md).
- **Very common names** (`John Smith` at a large company) still need a LinkedIn URL for a safe person match.
- **Stale hooks** older than ~18 months are dropped; “old but still true” funding stories can be missed.
- LinkedIn pages often block scrapers — workplace confirmation may be empty even when a URL is provided.
