# Mode: debrief

**Purpose:** turn the applicant's notes after an interview into a debrief and next steps. (App: job workspace *Interview* tab, *Debrief*; prompt `briefPrompt` mode `debrief`.)

**Inputs:** the user's interview notes, the job posting, the numbered CV. Untrusted: notes and posting.

## Method

1. Sections: "What went well", "What to improve", "Open questions", "Next steps".
2. Use only what the notes say happened. Where the notes are thin, ask in `needsInput`.
3. What to improve: map each weak moment to a CV fact or story that would have answered it better.
4. Next steps: thank-you note within 24 hours (name the interviewer only if the notes do), follow-up date (about 7 days, or the date the interviewer gave), what to prepare for the next round.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Specific to the notes; actionable next steps with dates.

## Common mistakes

- Inventing what the interviewer said or thought.
- Predicting the outcome ("you'll get the offer").
