# Same-name company disambiguation

Short brands like **Cube**, **Meta**, **Delta**, or **Apex** map to many unrelated orgs. A hook about the wrong Cube is worse than a hold.

## What SignalDraft does now

1. **LinkedIn workplace is the source of truth** when the typed company name is ambiguous.
   - Parses public LinkedIn meta for employer strings (`at Cube`, `@ Cube.dev`) and domains (`cube.dev`).
   - Confirms whether that workplace matches the company you typed.
   - Searches news for those LinkedIn aliases, not just the bare token `Cube`.
   - Ranking + Groq entity check prefer stories that match the LinkedIn workplace.
   - Safety net drops “matches” that don’t name the company or the LinkedIn workplace alias.

2. **Exact / multi-word names stay preferred** (`Cube Global`, `Cube.dev`) — less collision.

3. **UI hint** on Live: for single-token company names, LinkedIn is recommended.

## What you should enter (SDR tips)

| Approach | Example | Why it helps |
| --- | --- | --- |
| **LinkedIn URL (best for short names)** | `https://linkedin.com/in/colin-ross-…` | Confirms *which* Cube they work at |
| **Precise legal / product name** | `Cube.dev` or `Cube Global` instead of `Cube` | Avoids token collisions in news search |
| **Domain in Notes** | `employer domain: cube.dev` | Extra hint for research + LLM |
| **Person + company together** | Prefer hooks that name *Colin* and *Cube* | Filters celebrity / other-employer noise |
| **Industry keyword in Notes** | `semantic layer / analytics` | Helps ranking when several Cubes exist |

## Other options (product backlog)

These are useful next steps if LinkedIn meta is blocked or missing:

1. **Company LinkedIn / website field** — separate `companyUrl` (e.g. `https://cube.dev`) required when the name is one token.
2. **Manual “confirm workplace” step** — after research, show 2–3 candidate orgs and let the SDR pick before drafting.
3. **Wikipedia disambiguation** — if wiki returns “Cube (disambiguation)”, force a more precise name or LinkedIn.
4. **Location / HQ filter** — optional city/country on the prospect to drop foreign lookalikes.
5. **Clearbit / enrichment API** — resolve person → current employer canonical name (paid).

## Residual risk

LinkedIn often blocks scrapers. When meta isn’t fetchable we still use the profile URL / vanity for identity, but workplace confirmation may be empty — then prefer a precise company name or a hold.
