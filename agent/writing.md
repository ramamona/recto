# CV writing craft

Rules for every line you propose. They serve one goal: a recruiter skimming for six seconds and an ATS parsing for keywords both find the right facts fast. None of them overrides the no-fabrication rule in `recto.md`.

## Impact bullets

Shape: **action + scope + result**. Lead with a verb, say what and how big, end with the outcome.

- Result first when it is strong: "Cut deploy time 70% by rebuilding CI on ephemeral runners".
- Quantify only with numbers already in the CV or given by the user. No number? Describe the result qualitatively, or ask (`needsInput`: "How many users / how much faster?").
- One idea per bullet, ideally one line, never more than two.
- 3–6 bullets for recent roles, 1–3 for older ones, none for roles over ~12 years old unless relevant.
- Put the most relevant bullet first in each entry.

## Strong verbs by function

| Function | Verbs |
|---|---|
| Building | built, shipped, designed, implemented, launched, automated |
| Improving | cut, reduced, sped up, simplified, raised, stabilised |
| Leading | led, mentored, hired, coordinated, set up, ran |
| Selling / growth | won, closed, grew, negotiated, expanded, converted |
| Analysis | analysed, modelled, measured, forecast, identified, audited |
| Operations | managed, scheduled, resolved, streamlined, maintained |
| Research | investigated, published, tested, validated, surveyed |

Avoid overusing one verb; vary within an entry. Pick the verb that is true: "contributed to" is weak but honest if the person did not lead.

## Cut filler

- Weak openers: "Responsible for", "Worked on", "Helped with", "Tasked with", "Involved in", "Duties included". Replace with the actual action — only if the CV supports it (helped ≠ led).
- Empty adjectives: passionate, dynamic, results-driven, hard-working, team player, synergy, go-getter.
- Redundancy: "successfully", "various", "in order to", "a number of", "etc."
- Obvious lines: "References available on request", full street address, date of birth (unless the market expects it).

## Tense and person

- Current role: present tense. Past roles: past tense. Achievements in a current role that are finished: past tense is fine.
- No "I", "me", "my" in bullets. Implied first person.
- No articles where they add nothing ("Led the team of 5" → "Led team of 5" is optional; keep natural reading).

## Length and density

- Under 10 years' experience: aim for one page. Otherwise two at most. Academic CVs are the exception.
- White space beats a third page. Cut old, irrelevant or duplicated bullets before shrinking fonts.
- Keep every line earning its space; a bullet that restates the title goes.

## Summary

2–3 lines at the top. Who (title and years, from the CV), what they are strong at (2–3 skills the CV proves), what they want next (only if the user said so). No buzzwords, no "I". Tailor it per job by reordering emphasis, never by adding claims.

## Skills section

- Grouped lines: `- **Languages:** Go, Rust, TypeScript`.
- Only skills the person has. Proven skills (used in an entry) first.
- Use the standard spelling of each tool (JavaScript, PostgreSQL, Kubernetes).
- No skill bars, percentages or star ratings; ATSs cannot read them and recruiters distrust them.

## Keyword mirroring without stuffing

- When the job says "PostgreSQL" and the CV says "Postgres", mirror the posting's form. When the job says "stakeholder management" and a bullet shows exactly that, use the phrase.
- A keyword may appear only where the CV already shows the underlying fact. Never add a skill the person lacks to match a posting.
- Once or twice in context beats a keyword list. No hidden or white text, no repeated lists.
- Spell out an acronym once if the posting does: "Search Engine Optimisation (SEO)".

## ATS rules

- Standard headings: Summary, Experience, Education, Skills, Projects, Certifications, Languages (or the CV language's equivalents).
- Entries as `### Title | Org | Date | Location`; one date format throughout (e.g. `Jan 2021 – Present`).
- Contacts in the header as plain text: email, phone, city, one or two links.
- No tables, columns inside text, emoji, icons, symbols as bullets, text in images or headers/footers.
- Recto's `check` and `ats` report the rest; trust them.

## Per-language notes

- **en:** US résumés skip photo, age and marital status; UK CVs likewise. Keep the user's spelling variant consistent.
- **de:** Lebenslauf often includes a photo and date of birth by convention (optional, the user decides). Reverse chronological. Nouns capitalised; bullets in nominal style are fine ("Aufbau der CI-Pipeline …"). Dates like `03/2021 – heute`.
- **fr:** CV usually one page; "Expérience professionnelle", "Formation", "Compétences". Infinitive or past-participle bullets are both common; stay consistent. Use `à` / `aujourd'hui` in ranges.
- **es:** "Experiencia", "Formación", "Habilidades". Past tense (pretérito) for past roles; `actualidad` for ongoing.
- Never mix languages within a CV except for fixed tool names.

## Before / after (no new facts)

CV line: `- Responsible for the migration of the billing system to AWS, which reduced costs by 30%`
After: `- Migrated billing system to AWS, cutting costs 30%` (same facts, verb first, shorter)

CV line: `- Worked on improving the onboarding flow`
After: `- Improved onboarding flow` plus `needsInput`: "What changed as a result (completion rate, time to first use)?" — do not invent "by 25%".

CV line: `- Helped the team with customer tickets`
After: `- Resolved customer support tickets as part of a 4-person team` only if "4-person team" is in the CV; otherwise `- Resolved customer support tickets` and ask for volume.

CV line: `- Passionate, results-driven engineer with excellent communication skills`
After: cut, or replace with a summary built from facts in the entries.

Wrong: `- Led a team of 8 engineers` when the CV only says "Senior Engineer". That adds scope; ask instead.
