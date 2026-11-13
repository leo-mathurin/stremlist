# Deliverables and coordination

## Design, content, or documentation

Use this format when the deliverable is a mockup, a prototype, a text, a
specification, or a reusable document. Name this object in the title. The work
can be done without a code change.

```markdown
## Need and audience

Problem to solve and the people who will use the deliverable.

## Expected deliverable

Screens, flows, text, or document to produce, with its target location.
For durable repository documentation, name the ADR or the document in `docs/`
to create or change, as the existing conventions tell.

## Constraints and references

Existing components, content, behaviors, or decisions to obey.
Links to the sources that the work needs.

## Done criteria

- [ ] The deliverable covers the requested uses and is at the planned location.
- [ ] The decisions that the next work needs are available.

If the request includes a human approval, name who approves and which object.
Keep the preparation of the deliverable apart from its release or its sending.
```

## Parent issue or group

Use this structure for a goal that groups several independent deliverables,
or for a batch of feedback. This coordination role adds to the types of work.
It does not replace the format of each sub-issue.

```markdown
## Shared goal

Overall result and shared context.

## Scope

Included work and a link to the shared specification, if there is one.

## Split and dependencies

Links to the sub-issues and the distinct result of each one.
Give an order only when the dependencies make it necessary.

## Closing criteria

- [ ] The sub-issues that the shared result needs are done.
- [ ] The overall validation or the remaining operations are complete, as the
      requested delivery level tells.
```

Use the existing issues before you create new ones. Use the Linear
parent/sub-issue and dependency relations when they match the work. Keep the
implementation details in the sub-issues, and the shared context in the parent
or the specification.
