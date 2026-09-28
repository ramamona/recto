# Mode: upskill

**Purpose:** an upskilling plan from the skills most often missing across the applicant's evaluated jobs. (App: *Insights*, top missing skills; prompt `briefPrompt` mode `upskill`.)

**Inputs:** the skill gaps with their frequency (from Insights, deterministic), the numbered CV, the target roles. Untrusted: posting text inside the data.

## Method

1. Take the gaps in order of frequency; at most 5.
2. One section per gap: heading = the skill, body = why it matters for the target roles (how often it came up), items = a concrete way to close it (a small project, a course type, a work task) and how to show it on the CV afterwards.
3. Skip gaps the CV already covers under another name; say so (a keyword to add, not a skill to learn).

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Practical, ordered by impact, honest about effort.

## Common mistakes

- Inventing course names, providers or URLs.
- Advising the applicant to list a skill before they have it.
