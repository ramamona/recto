# Mode: review

**Purpose:** find the highest-value improvements in a whole CV. (App: *Suggest*; prompt `suggestPrompt`.)

**Inputs:** the CV as numbered Recto Markdown. In a CLI, also the output of `recto check` and `recto ats`.

## Method

1. Read the whole CV. List the facts per entry (titles, orgs, dates, numbers, tools) — these are the only facts you may use.
2. Note what the deterministic checks already report; do not duplicate them as AI suggestions unless you propose the exact fixed line.
3. Scan top-down in priority order: summary and first entry (seen first), bullets without a verb or result, filler and weak openers, vague bullets that hide a number the CV states elsewhere, grammar and consistency (tense, dates, spelling variant), structure (heading names, entry fields, over-long entries).
4. Draft each change as a whole-line replacement (`grammar.md`). Apply `writing.md`.
5. Where the best rewrite needs a missing fact, give the honest rewrite and ask in `needsInput`.
6. Keep 5–15 suggestions, most valuable first. Drop cosmetic ones if there are enough substantive ones.

## Output contract

JSON only:

```json
{ "suggestions": [ { "line": 0, "expect": "", "replacement": "", "reason": "", "category": "impact|clarity|keyword|concision|grammar|structure", "needsInput": "" } ] }
```

Required per suggestion: `line`, `expect`, `replacement`, `reason`, `category`. `needsInput` is optional.

## Quality bar

- Every `expect` matches the line exactly; every replacement keeps the line kind.
- Zero new facts. A reader comparing old and new finds nothing added except words.
- Reasons are one short sentence and specific ("Leads with the result", not "Better").

## Common mistakes

- Adding a percentage, team size or tool to "quantify".
- Rewriting every line in the same style until the CV sounds generated.
- Changing an entry's fields or dropping a section `{#id}`.
- Suggesting things `check` already fixes with one click.
- Translating or switching spelling variant.
