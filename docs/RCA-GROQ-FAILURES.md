# RCA — Groq failures (23 Aug 2026)

## Symptoms (Groq Logs)

| Time | Model | Code | Error |
| --- | --- | --- | --- |
| 11:12:13 | `openai/gpt-oss-20b` | **429** | `rate_limit_exceeded` |
| 11:12:13–14 | `llama-3.3-70b-versatile` | **404** | `model_not_found` |
| 11:12:14 | `qwen/qwen3-32b` | **404** | `model_not_found` |

API key label: **zamp**. Input/output tokens were **0** on every row (no generation happened).

## Root cause

Two independent issues stacked in one live run:

### 1. Primary model rate-limited (429) — contributing

`openai/gpt-oss-20b` is the configured primary. Free/developer Groq tiers have low RPM/TPM. A single pipeline turn calls Groq several times (entity resolve → analysis → draft, each with possible retries), so the primary can hit **rate_limit_exceeded** mid-run.

### 2. Fallback models retired (404) — primary defect

After the 429, `lib/llm.ts` fell through to hardcoded fallbacks:

- `llama-3.3-70b-versatile` — **shutdown 16 Aug 2026** (free/dev)
- `qwen/qwen3-32b` — **no longer on this key’s model list**

Those IDs return **404 `model_not_found`**. Worse, the old retry logic treated 404 as “retryable” and **called the same dead ID again** without JSON mode, doubling useless 404s (matches the dense 11:12:14 cluster).

Verified against this key (`GET /openai/v1/models`): chat-capable IDs include  
`openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b` — **not** the retired Llama / qwen3-32b IDs.

### Cascade effect on the product

When every model attempt fails, `resolveEntities` returns `null` → UI shows  
**“Groq entity check failed — using exact-tier heuristic only.”**  
Drafting may also fall back to heuristics or hold.

## Fix applied

1. **Fallback list** updated to live models only:
   - `openai/gpt-oss-20b` → `openai/gpt-oss-120b` → `qwen/qwen3.6-27b`
2. **404 / `model_not_found`**: skip that model ID immediately (no second same-ID call).
3. **429 / rate limit**: wait (`Retry-After` or ~1.5s), retry once, then try the next live model.

## Prevention

- Keep fallbacks aligned with `GET https://api.groq.com/openai/v1/models` after Groq deprecation notices.
- Prefer fewer Groq calls under free-tier limits (or upgrade / space out Bulk).
- Optional: set `GROQ_MODEL=openai/gpt-oss-120b` if 20b is rate-limited often.

## References

- [Groq Model Deprecation](https://console.groq.com/docs/deprecations) — Llama 3.1 8B Instant & Llama 3.3 70B Versatile shut down 16 Aug 2026.
