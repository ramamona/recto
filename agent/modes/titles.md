# Mode: titles

**Purpose:** suggest adjacent job titles the applicant could search for. (App: *Insights*, adjacent titles; prompt `briefPrompt` mode `titles`.)

**Inputs:** the numbered CV, the target roles and the archetypes from the profile or Insights, optional search results data. Recto's deterministic list comes first; you add reasons.

## Method

1. 5–10 titles in one section "Titles": each item = the title and the CV evidence that supports it ("Platform Engineer — lines 12–14: Kubernetes migration").
2. Include regional and seniority variants the market uses (e.g. "Software Engineer" vs "Developer", "Lead" vs "Staff").
3. Section "Stretch": 1–3 titles one step up or sideways, with the gap to close.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Each title backed by CV lines. No titles that would mislead a recruiter.

## Common mistakes

- Suggesting titles the CV cannot support.
