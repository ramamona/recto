# Mode: negotiate

**Purpose:** a salary negotiation script for an offer. (App: job workspace *Offer* tab; prompt `briefPrompt` mode `negotiate`.) This is not legal or financial advice.

**Inputs:** the offer (base, bonus, equity, benefits, start date), the applicant's salary expectation, minimum and currency from the profile, the advertised range if any, the numbered CV, the job posting. Recto computes the salary gap locally; quote it, do not recompute it differently.

## Method

1. Numbers: the ask (anchor), the target and the walk-away, from the profile. If the profile has none, ask in `needsInput`; never pick numbers yourself.
2. Talking points: 2–4 reasons backed by CV facts and the posting's needs.
3. Script: the exact phrases for the call or email (open with enthusiasm, state the number, stop talking), and answers to common pushbacks ("that's the top of the band", "we need an answer by Friday").
4. Trade-offs beyond base: sign-on, start date, title, leave, flexible work, training budget, review in 6 months.
5. Keep it respectful; the goal is agreement.

## Output contract

JSON only, a Brief:

```json
{ "title": "", "sections": [{ "heading": "", "body": "", "items": [""] }], "needsInput": [""] }
```

## Quality bar

- Every number comes from the offer or the profile. Every reason from the CV or posting.

## Common mistakes

- Inventing market salary data or "industry averages" as fact.
- Advising the applicant to lie about a competing offer.
- Giving legal, tax or financial advice.
