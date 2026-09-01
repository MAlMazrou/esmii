# Prompt 06 — Activate public production and automate `main`

## Objective

Create an isolated production runtime at `https://esmii.app` and make accepted `main` changes update it automatically through the outbound-pull pattern used by staging. Under the later 1 September 2026 versioning decision, each `main` source change must first receive its bot-owned semantic release commit and immutable `vX.Y.Z` tag; only that tagged revision may run production CI. Production is public from first activation under the user's explicit 30 August 2026 instruction.

This prompt's initial gate is deliberately an empty-application launch. It must not pretend that external mail, production Google OAuth, real-user onboarding, offsite-backup acceptance, or final hardened-production acceptance exists.

## Approved inputs

- GitHub repository `MAlMazrou/esmii` and GHCR namespace `ghcr.io/malmazrou`.
- Production domain `esmii.app`.
- Netcup host `152.53.251.34` and routed IPv6 `2a0a:4cc0:c0:a064:e463:5dff:fee8:b5c6`.
- Administrator access through `esmii-administrator@10.77.0.1` with passwordless sudo.
- Public production access immediately.
- Production edge network `172.30.20.0/24`, fixed Caddy IP `172.30.20.2`, reserved mail-admin network `172.30.30.0/24`, and reserved Stalwart admin IP `172.30.30.2`; these do not collide with the observed VPN, public, or Docker routes.
- Initial production mail mode: isolated non-delivering capture only.
- Initial production OAuth mode: Google disabled until a separate real production client exists.

## Allowed actions for this gate

- Add pre-build semantic release automation and CI publication for successful tagged `main` revisions using immutable full-SHA images and a mutable `:main` convenience pointer.
- Add and test a root-owned production pull service/timer that:
  - polls GitHub outbound;
  - accepts only the current `main` SHA after successful tag-bound release-dispatched CI;
  - resolves GHCR pointers to immutable digests or builds only the exact successful public SHA when anonymous GHCR pull is unavailable;
  - verifies OCI source, revision, and application-version labels;
  - serializes with staging through one host lock;
  - renders base+staging+production without changing staging state;
  - runs the one-shot production migration;
  - starts isolated production PostgreSQL, Valkey, capture mail, API, worker, web, and the shared Caddy edge;
  - checks public HTTPS health and restores the prior production overlay on failure.
- Generate distinct production runtime credentials on the VPS without printing or committing them.
- Create DNS-only Cloudflare A/AAAA apex records for `esmii.app` pointing to the verified VPS.
- Create a GitHub `production` Environment without VPS credentials.
- Advance the current reviewed tree from `dev` to `main` through GitHub's protected branch flow, then verify the release commit/tag, resulting versioned `main` CI, and production activation.

## Required safety boundaries

- Staging and production must have separate databases, Valkey instances, volumes, media roots, credentials, cookies, mail capture, and Docker networks.
- Shared Caddy is the only container joined to both edge networks.
- GitHub-hosted runners receive no SSH, WireGuard, Docker, database, or VPS secret.
- No mutable tag is runtime identity; record the resolved web/server digests.
- The staging timer and production timer share one lock and name only their own application services during activation/rollback.
- A production failure leaves staging unchanged and restores the preceding production runtime.
- Keep the Netcup Mail block and provider firewall unchanged.
- Do not start Stalwart or publish SMTP/IMAP ports.
- Do not install staging OAuth credentials into production or create fake production OAuth credentials.
- Keep real-user onboarding unavailable until production Google OAuth or external transactional mail is explicitly configured.
- Do not claim backup, recovery, mail, OAuth, monitoring, or fully hardened production acceptance from this gate.

## Verification

Repository checks:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:runtime-config
corepack pnpm test:policy
corepack pnpm test:infra
corepack pnpm scan:secrets
corepack pnpm build
```

Host and public checks:

```bash
sudo systemctl is-active esmii-staging-pull.timer esmii-production-pull.timer
sudo docker ps
curl --fail --silent --show-error https://staging.esmii.app/api/health/live
curl --fail --silent --show-error https://esmii.app/api/health/live
curl --fail --silent --show-error https://esmii.app/
```

Also prove that both public hosts return the intended environment, production has no Google provider configured, no host SMTP/IMAP listener exists, the Netcup provider firewall is unchanged, and the recorded production revision matches `origin/main`.

## Deferred gates

The following remain separate future work and are not required to show the empty public application:

- production Google OAuth client/credential and callback verification;
- external Stalwart mail, DNS/PTR, provider Mail-block removal, quotas, operational mailboxes, and controlled delivery tests;
- encrypted off-Netcup backup, security-tombstone journal, isolated restore testing, and retention identity;
- external monitoring and alert routing;
- final real-user/hardened-production acceptance.

## Completion report

Report:

1. outcome and exact source SHA;
2. repository and workflow changes;
3. CI run and immutable image digests;
4. DNS and GitHub Environment changes;
5. host services, staging-preservation proof, and public HTTPS evidence;
6. explicit disabled/deferred capabilities;
7. remaining risks and next gate.
