# Recto Markdown

Recto content is a small, **strict, line-oriented** Markdown dialect. Every line is classified on its own, so the same text always parses the same way, and anything the parser doesn't understand renders as plain text plus a diagnostic in the Check panel. It never disappears silently. In the app, the **?** button next to the editor shows this grammar with one example per row.

## A complete example

```
# Jane Doe
Staff Platform Engineer
Email: jane@doe.dev · +49 151 0000000 · linkedin.com/in/janedoe · Berlin, DE

## Summary
Engineer who likes boring infrastructure and fast feedback loops.

## Experience {#work}
### Staff Engineer | Acme Corp | Jan 2021 – Present | Berlin
Led the platform group.
- Cut deploy time **70%** by rebuilding CI on ephemeral runners
- Mentored 6 engineers; 3 promoted
---
### Senior Engineer | Globex | 2017 – 2020

## Skills
- **Languages:** Go, Rust, TypeScript
- **Infra:** Kubernetes, Terraform
```

## Line classification

Each line is tested against these patterns in order, and the first match wins.

| # | Line | Meaning | Example |
|---|---|---|---|
| 1 | blank | Ends a paragraph or list. Skipped in the header region. | |
| 2 | `---` (three or more dashes) | **Rule.** In the header region it draws a rule under the header. Inside an entry it closes the entry and becomes a section-level rule. | `---` |
| 3 | `# ` + text (the space is required) | **Name.** Only the first one counts. Later `# ` lines become paragraph text with the diagnostic `extra-name`. | `# Jane Doe` |
| 4 | `##` + space or end of line | **Section.** An optional `{#id}` at the end of the line sets its id (`[a-z0-9-]+`). An empty title makes an untitled section. | `## Experience {#work}` |
| 5 | `###` + space or end of line | **Entry.** `####` and deeper are plain paragraph text. | `### Title \| Org \| Date \| Location` |
| 6 | `- `, `* ` or `• ` (indentation ignored) | **Bullet.** Lists are flat. | `- Shipped the thing` |
| 7 | two or more spaces + text, directly after a bullet | **Continuation** of that bullet, joined with a space. | `  …and kept it running` |
| 8 | anything else | **Paragraph line.** Consecutive lines are joined with a space. A trailing `\` makes a hard line break. | `Led the platform group.` |

## Header

The **header region** is every line after the `#` line and before the first `##`.

- Each non-blank line there, other than a rule, is taken literally as one header line. Bullets and `###` lines in the header get the diagnostic `header-markup`.
- With no `#` line, the document has no header, and lines before the first `##` are ignored with the diagnostic `text-before-name`.
- A header line is split into parts on ` · `, ` | ` or ` • `.
- A part may start with a **label**: up to 20 letters or spaces followed by `:`, as in `Email: jane@doe.dev` or `Phone: +1 555 0100`. The label is rendered as text before the value.
- If **any** part of a line looks like a contact, the whole line is a **contact line**, and every part becomes a contact. Parts that aren't contact-like, such as a city, become text contacts. Otherwise the line is a **tagline**.
- The first separator found in contact lines is used between contacts when rendering. The default is ` · `.

### Contact detection

Detection is loose and validation is strict. Preflight reports contacts that were detected but aren't valid.

| Kind | Detected when | Valid when |
|---|---|---|
| email | A single token containing `@` | It matches `name@domain.tld` |
| url | It has a `scheme:`, starts with `www.`, or looks like `host.tld[/path]` **and** has a `/path` or ends in a common TLD (`com org net io dev app me co ai page site xyz info eu uk de fr es it nl ch at se no dk fi pl in ca au us`, lowercase) | `new URL()` accepts it, the scheme is allowed, and the host contains a `.` |
| phone | Only `+`, digits, spaces, `( ) - .`, with at least 7 digits | Always |
| link | `[text](href)`: the kind comes from the href scheme | As above |

So `Node.js` is not a URL (no path, and `js` is not in the list), `alexmorgan.dev` and `github.com/alex` are URLs, and a bare domain gets `https://`. If a word is detected as a URL by mistake, write it as a Markdown link or escape it.

A section whose heading means "Contact" (for example `## Contact` or `## Kontakt`) runs the same detection over its list items and paragraphs. Checks and exports use header contacts first, then these.

## Entries

```
### Title | Organisation | Date | Location
```

- The text after `### ` is split on unescaped `|` **before** inline formatting is parsed. A pipe inside code or a link must be escaped as `\|`.
- Fields are trimmed and positional: **title | org | date | location**. Missing fields are empty. A fifth or later field is joined into the location with ` | ` and gets the diagnostic `entry-extra-fields`.
- `date` and `location` are plain text: escapes are removed and there is no formatting.
- An entry owns the paragraphs and lists that follow it, up to the next `###`, `##` or `---`.

### Dates

The date field is parsed as a range for checks, sorting and JSON Resume export. If it can't be parsed, the text still renders, and you get the diagnostic `unparseable-date`.

| Endpoint formats | Examples |
|---|---|
| `YYYY` | `2020` |
| `YYYY-MM` | `2021-03` |
| `MM/YYYY` | `03/2021` |
| `Mon YYYY` / `Month YYYY` | `Mar 2021`, `Sept. 2021`, `März 2021` (month names in English and the CV language, case-insensitive, trailing `.` allowed) |

- Range separators: `–`, `—`, ` - `, a `-` between endpoints, or a range word (`to`, `bis`, `à`, `a`).
- Present-words (English, German, French, Spanish) mark an ongoing role: `present, current, now, today, ongoing`, `heute, aktuell, jetzt, bis heute`, `présent, aujourd'hui, actuel, en cours`, `presente, actualidad, actual, hoy`.
- A single date means start = end.

Examples: `Jan 2021 – Present`, `2017 – 2020`, `03/2019 - 11/2020`, `2021-03 to present`, `Sept 2018`.

## Paragraphs and lists

- A paragraph ends at a blank line or at any rule, heading or bullet line. A bullet may directly follow a paragraph line.
- After a bullet, an unindented plain line ends the list and starts a new paragraph. Indent it two or more spaces to continue the bullet instead.
- Consecutive paragraph lines are joined with a space. End a line with `\` to keep a hard line break.

```
Led the platform group.\
Reported to the CTO.
- Rebuilt CI on ephemeral runners,
  cutting deploy time by 70%
```

## Inline formatting

| Syntax | Result |
|---|---|
| `**strong**` | **strong** |
| `*em*` or `_em_` | *em*. `_` counts only when the outer side of each `_` is not a letter or digit, so `snake_case` stays literal. |
| `` `code` `` | `code` |
| `[text](https://example.com)` | a link |
| `https://example.com`, `jane@doe.dev` | autolinked. Trailing `.,;:!?'"` is left out, and so is a trailing `)` when the parentheses don't balance. |
| `\* \_ \[ \] \( \) \| \# \\ \`` | the literal character |

- An unmatched `**`, `*` or `_` renders literally, with the diagnostic `unclosed-emphasis`.
- Runs of whitespace inside text collapse to one space.

## Links

Only `http`, `https`, `mailto` and `tel` links are allowed. A URL-like bare domain gets `https://`. Any other scheme (`javascript:`, `data:`, `file:` …) renders as plain text with the diagnostic `unsafe-link`.

## Never interpreted

Raw HTML (it shows as the literal text you typed), images and tables. Nested lists are flattened.

## Section ids

Layout settings (column, variant, panel …) are keyed by section id.

- An explicit `{#id}` is reserved first.
- Other sections get `slugify(title)`: accents are removed, the title is lowercased, runs of other characters become `-`, and leading or trailing dashes are trimmed. An empty result becomes `section`.
- Duplicates get `-2`, `-3`, ….

If you rename a section, its settings follow it. To keep them attached for certain, give the section an explicit id.

## Diagnostics

| Code | Cause |
|---|---|
| `text-before-name` | Text before the first `##` with no `# Name` line |
| `extra-name` | A second `# ` line |
| `header-markup` | A bullet or `###` in the header region |
| `unclosed-emphasis` | An unmatched `**`, `*` or `_` |
| `unsafe-link` | A link with a scheme other than http, https, mailto or tel |
| `entry-extra-fields` | More than 4 `\|`-separated fields in an entry line |
| `unparseable-date` | An entry date that isn't a recognized date or range |
