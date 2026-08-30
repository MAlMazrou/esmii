# Documentation guide

This directory contains the approved generic SaaS core, its infrastructure and operating rules, and placeholders for future product-specific documentation.

## Document status

Every product, design, engineering, or ADR document must declare one status near its title:

- `DRAFT` — incomplete discussion material. It is not permission to implement behavior.
- `APPROVED` — explicitly reviewed and approved by the user. It may guide work within its stated scope.
- `SUPERSEDED` — retained only for history. It is not an active source of truth and must link to its replacement.

Changing a file from `DRAFT` to `APPROVED` requires an explicit user decision. An agent must not approve its own proposal. `TBD` always means unresolved, even inside an otherwise approved document.

## Canonical core documents

These files already define the generic core and infrastructure:

- [`requirements.md`](requirements.md) — authentication, organizations, security, and core acceptance criteria.
- [`infrastructure.md`](infrastructure.md) — technology and infrastructure architecture.
- [`environments.md`](environments.md) — development, staging, and production isolation.
- [`deployment.md`](deployment.md) — releases, promotion, rollback, backup, and recovery.
- [`vps-setup.md`](vps-setup.md) — Netcup host preparation and hardening.
- [`decisions.md`](decisions.md) — locked choices, defaults, deferred items, and required user inputs.
- [`prompts/`](prompts/README.md) — gated implementation prompts.
- [`runbooks/README.md`](runbooks/README.md) — Prompt 04 operational procedures and the proposed Prompt 05 remote-check plan.

## Product documents

The files under [`product/`](product/) describe what the eventual application does. They are intentionally `DRAFT` placeholders until product discovery is complete:

- [`product/prd.md`](product/prd.md)
- [`product/user-flows.md`](product/user-flows.md)
- [`product/domain-model.md`](product/domain-model.md)
- [`product/permissions.md`](product/permissions.md)
- [`product/roadmap.md`](product/roadmap.md)
- [`product/glossary.md`](product/glossary.md)

## Design documents

The files under [`design/`](design/) describe presentation and interaction after approval:

- [`design/design-system.md`](design/design-system.md)
- [`design/screens.md`](design/screens.md)
- [`design/responsive-design.md`](design/responsive-design.md)
- [`design/accessibility.md`](design/accessibility.md)
- [`design/content-guidelines.md`](design/content-guidelines.md)

## Engineering specifications

The files under [`engineering/`](engineering/) translate approved product requirements into technical contracts. They are derived documents and cannot silently change the PRD, core security requirements, or infrastructure:

- [`engineering/data-model.md`](engineering/data-model.md)
- [`engineering/api-contracts.md`](engineering/api-contracts.md)
- [`engineering/realtime-events.md`](engineering/realtime-events.md)
- [`engineering/storage-policy.md`](engineering/storage-policy.md)
- [`engineering/testing-strategy.md`](engineering/testing-strategy.md)

## Architecture decision records

[`adr/README.md`](adr/README.md) defines the format for focused future architecture decisions. `docs/decisions.md` remains the launch decision register; ADRs explain larger decisions without overriding it.

## Reading and approval rules

1. Read `README.md` and `AGENTS.md` at the repository root first.
2. Read the canonical core documents required by the authorized prompt.
3. Read every `APPROVED` product/design/engineering document relevant to the task.
4. Inspect related `DRAFT` documents only for open questions; do not implement their proposals.
5. Stop on a conflict between approved documents rather than choosing a preferred interpretation.

An approved product document may define product-specific behavior, but it cannot silently weaken tenant isolation, authentication, backup, deployment, or security requirements. Such a change must update the affected canonical documents and `docs/decisions.md` under explicit approval.

## Updating these documents

- Do not put credentials, private keys, real user data, or production exports in documentation.
- Use links instead of copying the same rule into several files.
- Give each requirement a stable identifier when implementation begins.
- Keep unresolved choices visible as `TBD`; never fill them with guesses.
- Update `Last updated` and related-document links when approving a document.
- Record material architecture choices in `docs/decisions.md` and, when useful, a focused ADR.
