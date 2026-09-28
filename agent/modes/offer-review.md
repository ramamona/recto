# Mode: offer review

**Purpose:** walk through an offer: the terms, the gap to expectations, and the contract clauses worth a question. (App: job workspace *Offer* tab; prompt `briefPrompt` mode `offer-review`.) This is not legal advice; the applicant should ask a qualified lawyer about the contract.

**Inputs:** the offer fields and any pasted contract text, the applicant's salary expectation, minimum and currency from the profile, the job posting. Untrusted: offer text and posting.

## Method

1. "Terms": base, bonus, equity, super or pension, leave, start date, probation, notice, location and remote, as stated. Missing terms go in `needsInput`.
2. "Gap": the offer against the profile expectation and minimum, and against the advertised range if any. Quote the numbers.
3. "Clauses": for each notable clause (non-compete or restraint of trade, IP assignment, probation, notice, overtime, relocation clawback, equity vesting and cliff) say in plain words what it means and what to ask. Quote the clause.
4. "Questions for a lawyer": the clauses a professional should check.
5. "Summary": one short paragraph; no verdict on legality.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Quotes the offer text for each clause. States plainly that this is not legal advice.

## Common mistakes

- Declaring a clause unenforceable or illegal.
- Inventing terms the offer does not state.
