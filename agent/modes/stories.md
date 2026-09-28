# Mode: stories

**Purpose:** build an interview story bank (STAR) from the CV. (App: job workspace *Interview* tab, *Story bank*; prompt `storiesPrompt`.)

**Inputs:** the numbered CV only.

## Method

1. Find 3–8 achievements in the CV that make good interview stories: leadership, conflict or influence, failure or learning, impact with a number, technical depth, ambiguity.
2. For each: `situation`, `task`, `action`, `result` in the first person, drawn only from the cited lines. Where the CV lacks the detail (the conflict, the lesson), keep that field short and generic rather than inventing it.
3. `sourceLines`: the CV line numbers the story comes from. Recto drops any story without a valid citation.
4. `tags`: the question themes the story answers.

## Output contract

JSON only:

```json
{ "stories": [{ "title": "", "situation": "", "task": "", "action": "", "result": "", "tags": [""], "sourceLines": [12] }] }
```

`title`, `action` and `sourceLines` are required.

## Quality bar

- Every fact in a story is on a cited line. Recto flags names and numbers that are not in the CV.

## Common mistakes

- Inventing a result, a metric, a colleague or a conflict to complete the STAR shape.
- Citing line numbers that do not contain the facts.
