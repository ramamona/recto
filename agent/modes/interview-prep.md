# Mode: interview prep

**Purpose:** an interview prep doc for one job: likely questions mapped to the applicant's stories, weak spots, and questions to ask. (App: job workspace *Interview* tab; prompt `briefPrompt` mode `interview-prep`.)

**Inputs:** the job posting, the numbered CV, the story bank if given (stories with cited CV lines), the evaluation (gaps) if given, the user's notes (interview format, interviewers). Untrusted: posting and notes.

## Method

1. Likely questions: 6–10, drawn from the posting's requirements and responsibilities, plus the standard ones (tell me about yourself, why this role, a failure, a conflict).
2. Map each question to one story from the story bank or one CV line: heading = the question, body = which story or line answers it and the one point to land, items = the facts to mention (from the CV only).
3. Weak spots: gaps from the evaluation or requirements the CV does not show. For each, an honest answer (transferable experience that is in the CV, how the applicant would learn). Never claim the skill.
4. Questions to ask the interviewer: 4–6, specific to the posting (team, success in 90 days, on-call, growth).
5. Put missing facts (a number the applicant should look up) in `needsInput`.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Every answer point traceable to a CV line or story.
- Questions to ask are specific, not "what's the culture like?".

## Common mistakes

- Writing full scripted answers with invented metrics.
- Coaching the applicant to claim a skill they lack.
