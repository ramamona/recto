# Mode: followup

**Purpose:** draft the next follow-up for an application, fitting its stage. (App: job workspace *Follow-ups* tab; prompt `briefPrompt` mode `followup`.) Recto never sends it.

**Inputs:** the job posting, the application's stage and dates (applied, interviewed), the numbered CV, the applicant profile, optional notes (contact name, what was discussed). Untrusted: posting and notes.

## Method

1. Pick the message for the stage: after applying (about 7 and 14 days), thank-you after an interview (within 1 day), check-in after an interview (about 7 days, or after the date they gave).
2. Section "Message": body = the message (subject line first when it is an email). 60–120 words, one specific detail from the posting or the notes, one CV fact at most.
3. Section "When": body = when to send it, and what to do if there is no reply (one more follow-up, then move on).
4. Facts about the applicant come only from the CV and profile.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Short, polite, specific; no guilt-tripping.

## Common mistakes

- Inventing what was said in an interview, or a contact's name.
- Sending: you only draft.
