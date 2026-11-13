# Operations and QA

## Operation or follow-up after release

Use this format when the result depends on an action on an environment or on
an observation after a release: a cutover, a data backfill, a cleanup, the
removal of a service, or a check after a migration. A merged preparation PR
does not prove that the operation is done.

```markdown
## Goal and target

Concrete result, environment, and resources.
Link to the preparation issue or PR, if there is one.

## Prerequisites and conditions

Required version or SHA, dependencies, checks before the operation, and the
permissions that the repository rules and the request make necessary.
Name the person who must do an action when a human must do it.

## Execution

Link to the applicable procedure and the actions specific to this operation.
Define the scope of a batch or a retry, and how to resume it without doing
the completed effects again, when this is important for the operation.

## Validation and stop

- [ ] The checks prove that the target has the expected result.
- [ ] The dated evidence identifies the environment and the version checked.

Describe the stop conditions and the resume or rollback procedure when a
failure needs a decision. Say if a rollback is not possible.
```

For a follow-up over several days, give the real start of the period, its
duration, the metrics, and the closing conditions. Reusable steps stay in the
procedure. The issue keeps the results of this execution.

## QA or validation only

Use this format when the deliverable is a verdict on a build or a flow, with
no fix defined in advance. Keep the tests that an implementation needs in its
own issue, unless the QA pass needs independent follow-up.

```markdown
## Object to validate

Flow or contract, build or SHA, environment, and platform.

## Preconditions

Available version, install method, and the data or access necessary.

## Scenarios and expected results

- [ ] A realistic flow with its observable results.
- [ ] A related case or a session resume that is relevant for this change.

## Deliverable

Verdict for each scenario, useful evidence, and defects linked to their
issues. Say if closing needs a full success or a QA report with an explicit
decision on the blockers.
```
