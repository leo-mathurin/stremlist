---
name: create-linear-issue
description: Create a Linear issue for Stremlist. Apply it before you create any issue for this repository, including during development, diagnosis, an audit, or PR preparation, even when the user does not invoke it.
---

# Create a Stremlist Linear issue

Write an issue that a person or another agent can take without reading the
conversation: a concrete problem, the expected result, and a way to verify
that the work is done.

## 1. Find the context and the existing issues

- Collect the request, the observed facts, the links, and the limits of the
  current task. A request for templates or a draft asks for text. It does not
  ask for an issue in Linear. When the user, the requested work, or the
  repository rules already allow the issue, create it without a new
  confirmation.
- Use Composio MCP or the Composio CLI. Read the connection and the team in
  the [AGENTS.md file](../../../AGENTS.md#linear). Give the account explicitly
  in each call: `--account <connection>` with the CLI.
- Find the tools with `COMPOSIO_SEARCH_TOOLS`, then call them through
  `COMPOSIO_MULTI_EXECUTE_TOOL`. With the CLI, use `composio search`, then
  `composio execute`. Read the full schema of each tool before you call it.
- Search the existing issues with the words of the problem and the component,
  in French and in English. Include completed and canceled issues. Read the relevant matches: a similar title does not
  prove a duplicate. Read the pages that this search needs. Do not export all
  the backlog.
- If an issue already covers the same result, return its link. Add new facts
  only if the task allows this update. For a different regression, create a
  related issue and explain the difference.

## 2. Write for the type of work

Select the format from the result to deliver, then read the related reference:

| Expected work                                                                  | Reference                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Software bug, feature or improvement, technical task, investigation or audit   | [Base structures](references/structures.md)                 |
| User report about an account, a list, or a provider link; data fix             | [User reports and data](references/user-reports.md)         |
| Operation, release, data migration, or follow-up after release; QA pass only   | [Operations and QA](references/operations.md)               |
| Design, content, or documentation; parent issue that groups several work items | [Deliverables and coordination](references/coordination.md) |

Write the issue in French, unless the user asks for a different language.
Keep technical identifiers as they are. The compact format is correct for a simple
task. The type of work is different from the area: frontend, backend, a
provider, or Stremio do not each need their own structure. A parent issue
organizes the work. Each sub-issue keeps the format of its own deliverable.

- **Title**: name the concrete problem or result. Add an area prefix such
  as `Letterboxd :` only if it helps to read the title in a list.
- **Scope**: aim for a result that you can verify. Split work items that you
  can deliver and validate independently. Link the real dependencies. Keep
  the validation of a fix in the same issue. Create a separate QA issue when
  it has its own prerequisites, people, or due date.
- **Facts**: keep observation, user feedback, and hypothesis apart. A cause or
  a solution is certain only with proof. Write that useful information is
  missing. Do not invent it. Ask for more detail only if the answer changes
  the meaning or the scope of the work.
- **Done criteria**: write observable criteria. Describe a realistic
  validation scenario when it helps, and follow the test conventions of the
  repository. Keep the checks already done apart from the checks to do.
- **Useful context**: include the verified paths, the environment and version,
  the sources of the report, and the relevant links. Give implementation
  details only for constraints or leads that have evidence.
- **Proportion**: remove empty sections and repetitions. For a simple task, a
  few sentences can be sufficient. A durable architecture decision or a
  reusable procedure stays in an ADR or in `docs/`. Dated evidence and audit
  results stay in Linear.

## 3. Create and verify

- Get the team ID and the other necessary properties with Linear reads. Use
  only existing and relevant labels, projects, and states. Set the assignee,
  priority, cycle, and due date when the request or the context gives them.
  If not, keep the team defaults. Do not create a taxonomy to fill fields. The
  format names in this skill are not labels to create in Linear.
- Set the state from the real work, not from the creation of the issue or from
  an open PR. Obey the delivery flow of the repository.
- Create the issue with the title and description that you checked. The issue
  does not give permission to do the operations that it describes. Copy the
  special limits of the request into the issue when the next person needs
  them.
- Check the response, then read the issue again: team, title, description,
  and requested properties. After a partial error or a lost response after a
  write, search for the issue before you try again. If the result stays
  uncertain, report it and stop the writes to prevent a duplicate.
- Return the Markdown link with the identifier and the title. Name the
  information that is still not confirmed if it is important for the next
  steps.
