# Recto Markdown for models

Recto CV text is a strict, line-oriented Markdown dialect: each line means one thing, and the same text always parses the same way. Full reference: `docs/syntax.md`.

## Lines

| Line | Meaning |
|---|---|
| `# Name` | The person's name. First line; only one. |
| lines after `#` and before the first `##` | Header lines: a tagline, or contacts separated by ` · ` (`Email: jane@doe.dev · +49 151 0000000 · Berlin, DE`). |
| `## Title` or `## Title {#id}` | Section. `##` alone is an untitled section. The `{#id}` keeps layout settings attached; never remove it. |
| `### Title \| Org \| Date \| Location` | Entry. Fields split on `\|`, positional; keep their order and count. |
| `- text` (also `* `, `• `) | Bullet. Lists are flat. |
| 2+ spaces + text right after a bullet | Continuation of that bullet. |
| `---` | Rule; closes the current entry. |
| anything else | Paragraph text; consecutive lines join; trailing `\` is a hard break. |

- Inline: `**bold**`, `*italic*`, `` `code` ``, `[text](https://link)`. Escape literal `* _ [ ] ( ) | # \` with a backslash.
- Only `http`, `https`, `mailto`, `tel` links. No HTML, images or tables.
- Dates: `2020`, `2021-03`, `03/2021`, `Mar 2021`; ranges with `–` or a range word; present-words like `Present`, `heute`, `aujourd'hui`, `actualidad`.

## Edits are whole-line replacements

Every change you propose is one object:

```json
{ "line": 12, "expect": "- Worked on the billing migration", "replacement": "- Migrated billing system to AWS", "reason": "Verb first, shorter", "category": "impact" }
```

- `line`: the 1-based line number shown in the numbered CV (`12│ …`). The number prefix is not part of the text.
- `expect`: the line's exact current text, character for character. If it does not match, Recto rejects the edit (the CV changed underneath you).
- `replacement`: the complete new line, of the **same kind**: a bullet stays a bullet, an entry stays an entry with the same number of `|` fields, a heading stays a heading at the same level, and a section keeps its `{#id}`.
- One edit per line. To delete a line's content, shorten it; to reorder, propose replacements for each affected line.
- `category`: one of `impact`, `clarity`, `keyword`, `concision`, `grammar`, `structure`.
- `needsInput` (optional): a question for the user when the better line needs a fact the CV does not have.

Recto's guard re-checks every edit: line match, kind preserved, and "new facts" (numbers, URLs, capitalised words not already in the CV). Flagged edits are never auto-accepted.
