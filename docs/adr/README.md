# Architecture decision records

Status: `APPROVED`

Owner: Repository maintainers

Last updated: 29 August 2026

Scope: Format and lifecycle for focused future architecture decisions.

Use an ADR when a material technical choice has meaningful alternatives, security/operational consequences, or a migration cost. Small code details do not need ADRs. `docs/decisions.md` remains the launch decision register; an ADR explains context and consequences and must link back to the applicable decision entry.

## File naming

Use zero-padded sequential names:

```text
0001-short-decision-title.md
0002-next-decision.md
```

Do not reuse a number or rewrite an accepted ADR to hide history. Supersede it with a new ADR and reciprocal links.

## Status values

- `PROPOSED` — under discussion; not implementation authority.
- `ACCEPTED` — explicitly approved and active.
- `SUPERSEDED` — replaced by a named later ADR.
- `REJECTED` — considered but not selected.

## ADR template

```markdown
# ADR NNNN — Decision title

Status: `PROPOSED`

Date: `YYYY-MM-DD`

Decision owners: `TBD`

Related decisions/requirements: `TBD`

## Context

TBD

## Decision

TBD

## Alternatives considered

TBD

## Consequences

TBD

## Security, operations, and migration impact

TBD

## Validation and revisit trigger

TBD
```
