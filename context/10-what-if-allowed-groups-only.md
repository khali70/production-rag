# What if we filter by `allowed_groups` only and ignore classification?

Thought experiment, 2026-09-21. Question: check only the document's `allowed_groups` against the user's groups, and skip the classification rule (and `deny_groups`) from `access/entitlements.json`. Sources: the assessment pack and [08-assessment-pack.md](08-assessment-pack.md).

## Short answer
- In this pack, the results would be **the same**. All tests would still pass.
- It is still wrong. It turns one mistake into a leak, ignores the supplied rules, and a leak is a critical failure in the quest.
- Checking all three costs almost nothing, so keep all three.

## The three checks (reminder)
A user sees a document only if all three pass. Anything else is denied (`default_rule: deny`).

1. **`allowed_groups`**: the document's own list, set by the document owner.
2. **Classification rule**: one rule per sensitivity label, set by security or compliance for every document with that label.
   - `INTERNAL` -> `all_employees`
   - `RESTRICTED_HR_INVESTIGATION` -> `hr_investigations`
3. **`deny_groups`**: explicit block from `document_overrides`, wins over any allow. HR-CASE-778 blocks `engineering` and `procurement`.

## What happens in this pack
Every document's `allowed_groups` already matches its classification rule:

| Document | classification | allowed_groups | Rule groups |
|---|---|---|---|
| 7 INTERNAL documents | INTERNAL | all_employees | all_employees |
| APX-HR-CASE-778 | RESTRICTED_HR_INVESTIGATION | hr_investigations | hr_investigations |

So for the 3 users:

| User | All 3 checks | allowed_groups only |
|---|---|---|
| u-eng-104 | HR-CASE-778 hidden | hidden |
| u-hr-207 | HR-CASE-778 visible | visible |
| u-proc-310 | HR-CASE-778 hidden | hidden |

Same outcome. The difference only shows up when something is wrong, which is exactly when security matters.

## What breaks

### 1. One mistake becomes a leak
Someone edits HR-CASE-778 and sets `allowed_groups` to `all_employees` (typo, bad import, copy of another document's metadata).
- allowed_groups only: every employee can now retrieve the investigation. Incident 3 fails.
- All three checks: the classification rule still requires `hr_investigations`, and `deny_groups` still blocks engineering and procurement. Nothing leaks.

### 2. Wrong group membership becomes a leak
An engineer is added to `hr_investigations` by mistake.
- Without `deny_groups`: they see the case.
- With it: `engineering` is denied, and deny wins.

### 3. New or unknown labels pass through
A new document arrives labelled `RESTRICTED_LEGAL` with `allowed_groups: [all_employees]`, and nobody wrote a rule for that label yet.
- allowed_groups only: visible to everyone.
- With the classification check: no rule for the label means no allowed groups, so it is denied (fail closed).

### 4. It ignores the supplied access rules
`entitlements.json` is part of the pack and defines `default_rule: deny`, the classification rules and the overrides. Using only one field is not implementing the given policy, and an assessor can test it with a modified fixture.

### 5. Policy changes do not scale
If the company changes who may read `INTERNAL` documents, the classification design changes one rule. With allowed_groups only, every document must be edited. At 60,000 documents, some will be missed, and the lists drift over time.

### 6. The quest treats any leak as a critical failure
"Unauthorized information affects answers, references, diagnostics, or operational records" is listed as a critical failure trigger. Depending on one field that anyone can mis-set is not a "system guarantee".

## What we gain by dropping the classification check
- One less array overlap in the SQL filter. Negligible: `classificationGroups` is resolved once at ingest and stored on each chunk, so the query cost is the same kind of check as `allowed_groups`.
- Simpler to explain. But "defense in depth: owner list AND company rule AND explicit deny" is also easy to explain, and it is a stronger answer in the technical review.

## Recommendation
- Keep all three checks in the pre-filter, inside the vector search query.
- Resolve the classification rule at ingest. Unknown label means an empty list, so nobody can see it.
- To add: at ingest, warn when `allowed_groups` and the classification rule disagree (for example an INTERNAL-level list on a RESTRICTED label). The strictest result wins.
- To add: contract test with a tampered fixture: set HR-CASE-778 `allowed_groups` to `all_employees` and assert u-eng-104 still cannot retrieve it.

## Need more info
- `document_overrides` for HR-CASE-778 also has its own `allow_groups`. The pack does not say whether it replaces the document's `allowed_groups` or adds to them. In the pack both are `hr_investigations`, so the result is the same today.
