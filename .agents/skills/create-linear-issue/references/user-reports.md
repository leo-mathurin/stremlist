# User report and data fix

Use this format when the expected result is about the data of one account,
one list, one provider link, or a set of records: a watchlist that does not
refresh, a missing or wrong title in a catalog, a provider link that stops
working, or a wrong watched mark. A user report alone does not prove a
software bug. If several reports show the same cause, link the work on the
system to the source cases and keep their identifiers.

```markdown
## Report

Useful text of the report, with its source and the date received.
Keep the original text when it helps to understand the problem.

## Data concerned

Useful identifiers of the account, list, provider, title, or report. Do not
copy secrets or more personal data than the work needs.
For a batch, define the exact scope and its exclusions.

## Check

Current value, expected value, and the source that proves it.
Give the date of the check and the information that is still uncertain.

## Expected result

Fix, removal, restore, or triage conclusion to get.
Say if the work is on the data, on the software cause, or on two separate
linked deliverables.

## Done criteria

- [ ] The report has a conclusion that the checked sources prove.
- [ ] If a fix is necessary and allowed, the data concerned shows the
      expected result.
- [ ] A recurring cause, if there is one, is linked to its fix issue.
```

A remote data fix also uses the
[operation](operations.md#operation-or-follow-up-after-release) format: give
the environment and the conditions. To create or triage the issue does not
give permission to change the data.
