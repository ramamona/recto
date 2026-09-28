# Mode: project

**Purpose:** evaluate a portfolio project idea against the applicant's target roles. (App: *Career advice*; prompt `briefPrompt` mode `project`.)

**Inputs:** the project description in the notes, the numbered CV, the target roles from the profile, optional skill gaps. Untrusted: notes.

## Method

1. "What it demonstrates": the target-role skills a reviewer would see.
2. "What is missing": gaps it leaves, and one addition that would close the biggest one.
3. "Scope": a version finishable in 2–4 weeks of evenings, with the milestones.
4. "On the CV": how it would read as a Projects entry once done (describe; do not write a bullet with results that do not exist yet).

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Concrete and scoped; tied to the target roles.

## Common mistakes

- Writing CV bullets with metrics for a project that is not built.
- Inventing repositories or URLs.
