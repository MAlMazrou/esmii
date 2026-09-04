# Agent prompt sequence

These prompts are execution gates, not a backlog that an agent may run autonomously. Give an agent exactly one numbered prompt at a time. Review its final report and resolve every approval gate before authorizing the next prompt.

The numbered sequence implements the generic SaaS core followed by its narrowly approved operator-only infrastructure dashboard. Intentionally incomplete `DRAFT` files under `docs/product/`, `docs/design/`, and `docs/engineering/` are not prompt inputs and do not block this sequence. Even approved product content requires a later separately authorized product prompt; do not insert it into, skip, or silently expand Prompts 02–07.

## Order

1. [`01-review-documents.md`](01-review-documents.md) — read and plan only.
2. [`02-create-monorepo.md`](02-create-monorepo.md) — create and verify the local core on `dev`.
3. [`03-build-auth-and-organizations.md`](03-build-auth-and-organizations.md) — implement the generic SaaS identity core on `dev`.
4. [`04-prepare-vps.md`](04-prepare-vps.md) — prepare and locally validate both isolated VPS environments without touching Netcup.
5. [`05-provision-vps-and-deploy-staging.md`](05-provision-vps-and-deploy-staging.md) — provision the 8 GB Netcup host and deploy staging first.
6. [`06-promote-staging-to-production.md`](06-promote-staging-to-production.md) — activate the isolated public production shell and the successful-`main` outbound deployment timer; mail, production OAuth, backup acceptance, and final hardening remain later gates.
7. [`07-build-monitoring-dashboard.md`](07-build-monitoring-dashboard.md) — build and locally validate the isolated staging/production operator monitoring realms; every VPS, secret, Cloudflare, certificate, activation, soak-acceptance, and external-monitor action remains separately gated.

## Optional product planning

[`product-discovery.md`](product-discovery.md) can be used when the user explicitly wants a one-question-at-a-time product interview. It is documentation planning only, is not part of the numbered sequence, and grants no code or external-action authority.

## Rules

- Read [`../../AGENTS.md`](../../AGENTS.md) before every prompt.
- A completed prompt does not authorize the next prompt.
- A prompt must stop at its stated stop condition even when the next action looks routine.
- Prompts 02–05 operate from `dev`; Prompt 06 owns the protected `main` production path; Prompt 07 repository work returns to `dev` and cannot mutate either live environment merely because CI passes.
- Do not create `staging` or `production` branches. A branch name is not an environment boundary.
- Never put secret values in a prompt, Git, logs, command history, screenshots, or reports.
- Record commands that were actually run separately from commands merely recommended for the next phase.
- If a document conflicts with a prompt, apply the source-of-truth order in `AGENTS.md` and report the conflict instead of guessing.
