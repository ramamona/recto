# Mode: training

**Purpose:** evaluate a course or certification the applicant is considering against their target roles. (App: *Career advice*; prompt `briefPrompt` mode `training`.)

**Inputs:** the course description in the notes, the numbered CV, the target roles from the profile, optional skill gaps from Insights. Untrusted: notes.

## Method

1. "Relevance": which target-role requirements or skill gaps it addresses, and which it does not.
2. "What it adds": what the CV would show afterwards that it does not show now.
3. "Cost": time and effort from the description; if cost or duration is missing, ask in `needsInput`.
4. "Verdict": take it, skip it, or a cheaper or more credible alternative (a project that shows the same skill). One reason.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Honest: many certificates do not move hiring decisions; say so when true.

## Common mistakes

- Inventing course providers, prices, accreditation or URLs.
