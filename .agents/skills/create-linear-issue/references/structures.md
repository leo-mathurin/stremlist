# Issue structures

The format by type is the default. The compact format is correct for a simple
task. The detailed format is for work that needs a shared frame. These
structures cover the base work. The other formats are in the
[skill](../SKILL.md#2-write-for-the-type-of-work). Keep only the sections that
give useful information.

## Three possible approaches

| Approach             | Structure                                                                                             | Use                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Compact              | Problem → expected result → validation                                                                | Simple task with a clear scope. These items can fit in one paragraph.                                            |
| By type, recommended | Structure for the deliverable, with done criteria                                                     | Work that another person or an agent must be able to take.                                                       |
| Detailed             | Context → goal → scope → approach and alternatives → dependencies and risks → criteria and validation | Work with several decisions or dependencies. If the deliverables are independent, split them into linked issues. |

## Bug

```markdown
## Problem

Observed behavior and its effect on the user or the system.
Environment and version, if they are known and relevant.

## Reproduction

Preconditions and exact steps, with the observed result.
If you did not reproduce the bug, give the source of the report and what
is still to confirm.

## Expected result

Correct behavior in the same situation.

## Acceptance criteria

- [ ] The scenario gives the expected result.
- [ ] The related case that a regression can really affect still works.

## Diagnosis

Links to the evidence, useful extracts, and verified paths.
Keep a proven cause apart from a hypothesis or a fix lead.
```

**Fictional example, adapt it to the facts. Issues are in French:**

**Title:** `Configuration : garder les listes choisies après la connexion d’un fournisseur`

Sur la page de configuration, l’utilisateur choisit des listes, puis connecte
un fournisseur. Au retour de la connexion, la sélection est vide.
L’utilisateur doit choisir ses listes de nouveau.

Reproduction rapportée : choisir deux listes, connecter Trakt, puis revenir à
la page de configuration. Les deux listes doivent rester sélectionnées.
Confirmer le navigateur et l’environnement avant de conclure à une régression.

- [ ] Le parcours choix des listes → connexion du fournisseur → retour garde
      la sélection.
- [ ] Une modification ensuite de la sélection met à jour le lien
      d’installation.

## Feature or product improvement

```markdown
## Need

Who has which limit, and in which situation?

## Expected behavior

Concrete flow or result. Add an example if it removes an ambiguity.

## Scope

What to deliver. Give exclusions only if they prevent a probable confusion.

## Acceptance criteria

- [ ] The user flow gives the requested result.
- [ ] The relevant edge cases have a defined behavior.

## Context

Source of the request, mockup, or known constraints. A proposed solution
stays a lead if nobody has decided it.
```

## Technical task

```markdown
## Problem

Current limit and its concrete effect on development or operation.

## Expected result

Capability, contract, or behavior to get.

## Constraints

Compatibility, dependencies, and existing decisions that change the solution.

## Validation

- [ ] A relevant scenario or check proves the result.
- [ ] The existing behavior that the change can affect stays the same.
```

**Compact fictional example:**

**Title:** `CI : retirer le commentaire de plan quand le changement disparaît`

Une PR peut revenir à un plan vide après une modification. Le commentaire
précédent reste alors visible et donne une information périmée. Retirer ce
commentaire quand le plan devient vide. Vérifier le parcours plan avec
changement → plan vide, puis plan vide → nouveau changement.

## Investigation or audit follow-up

```markdown
## Question to answer

Expected decision or concrete risk to confirm.

## Available facts

Dated observations, sources, and environment. Keep hypotheses apart.

## Investigation

Checks that let you decide, inside the limits of the task.

## Deliverable and done criteria

- [ ] A conclusion with evidence answers the question, with its limits.
- [ ] The evidence and dated results are in the issue or its comments.
- [ ] The necessary fixes are identified and linked if they need separate
      work.
```

An investigation can end with a conclusion and no code change. A measurement
gives its period, its environment, and its method. A work plan in the issue
stays separate from the allowed actions.

## Sources for the structure choices

- [Linear Method: Write issues not user stories](https://linear.app/method/write-issues-not-user-stories): direct titles, concrete tasks, and proportional context. This is why the compact format exists and why no user story is required.
- [Linear: Issue templates](https://linear.app/docs/issue-templates): templates by need and properties adapted to the team. This skill guides agents. It does not configure a remote template in Linear.
- [Next.js: bug template](https://github.com/vercel/next.js/blob/canary/.github/ISSUE_TEMPLATE/1.bug_report.yml): reproduction, current and expected behavior, environment. This is the base of the bug structure, without a public reproduction repository for an internal team.
- [Vite: feature request](https://github.com/vitejs/vite/blob/main/.github/ISSUE_TEMPLATE/feature_request.yml): problem, proposed solution, alternatives, and context. Leads and alternatives are useful when a decision is still open.

The done criteria and the investigation format are choices for this
repository. They make it easier to take over the work and to verify the
result.
