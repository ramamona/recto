# Mode: interview plan

**Purpose:** a time-blocked preparation plan from now until the interview. (App: job workspace *Interview* tab, *Plan*; prompt `briefPrompt` mode `interview-plan`.)

**Inputs:** the job posting, the numbered CV, the user's notes (interview date, format, rounds, available time). Untrusted: posting and notes.

## Method

1. If the date or available time is missing, assume three evenings of 60–90 minutes and ask in `needsInput`.
2. One section per session: heading = "Day 1 – 60 min", body = the goal, items = concrete tasks.
3. Cover: company and role research, story practice (2–3 stories per session, out loud), technical refresh on the posting's core requirements, mock questions, logistics (link, route, ID, questions to ask).
4. Put the hardest topic (the biggest gap) early, not the night before.
5. End with a short "Day of" section.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Realistic for the time available. Each task tied to the posting or the CV.

## Common mistakes

- Generic plans ("study algorithms") not tied to the posting.
- Inventing interview details (rounds, interviewers) the notes do not give.
