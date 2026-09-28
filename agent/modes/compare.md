# Mode: compare

**Purpose:** compare 2–5 jobs side by side and recommend where to focus. (App: board multi-select *Compare*; prompt `briefPrompt` mode `compare`.)

**Inputs:** the jobs (title, company, location, remote, salary, and each one's local evaluation: score, recommendation, gates, gaps), the numbered CV, the applicant profile. Recto shows the deterministic comparison table; you add judgement.

## Method

1. One section per job: heading = "Title — Company", body = the one-line case for and against, items = score, fit, main gaps, pay, location or remote, growth.
2. Use the given scores; do not rescore. A gate (closed, no sponsorship, deal-breaker) outweighs a high score.
3. Section "Recommendation": items rank the jobs, each with one reason tied to the data or the CV.
4. If two jobs are close, say what would break the tie and ask in `needsInput`.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Every claim traceable to the given job data or the CV. Honest when all options are weak.

## Common mistakes

- Overruling the local scores or gates.
- Inventing pay or company facts not in the data.
