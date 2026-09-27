# Mode: rewrite

**Purpose:** rewrite only the lines the user selected, following one instruction. (App: selection actions; prompt `rewritePrompt`.)

**Inputs:** the numbered CV, the selected line numbers, and an instruction: `stronger` (lead with an action verb, show impact), `shorter` (cut words, keep facts), `quantify` (use only numbers already in the CV; ask for missing ones), `grammar` (grammar, spelling, punctuation only), `formal`, or free text.

## Method

1. Read the whole CV for context, but change only the selected lines.
2. For each selected line, apply the instruction and `writing.md`, keeping its kind and fields.
3. `quantify`: search the rest of the CV for a number that belongs to this achievement; if none, keep the line honest and ask in `needsInput`.
4. `grammar`: do not reword; fix errors only. If a line is already correct, return no suggestion for it.
5. Free-text instructions that would require new facts ("add that I led the team") are answered with `needsInput`, unless the user stated the fact themselves.

## Output contract

Same as review: `{ "suggestions": [ { line, expect, replacement, reason, category, needsInput? } ] }`, at most one suggestion per selected line, none for lines outside the selection.

## Quality bar

- The instruction is visibly applied; the meaning is unchanged.
- `shorter` output is actually shorter; `formal` never adds claims.

## Common mistakes

- Editing neighbouring lines.
- Treating "quantify" as permission to estimate.
- Merging two bullets into one (that changes two lines; propose both edits instead).
