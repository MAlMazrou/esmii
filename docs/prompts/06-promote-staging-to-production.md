# Prompt 06 — Promote the staging-tested release to production

## Objective

Promote the exact release already proven in staging to production on the same Netcup VPS, without rebuilding it and without disrupting or weakening staging isolation. Configure production auth, mail, backup, monitoring, and public-launch controls through separate approval gates. Advance `main` only after production is verified.

## Inputs

Prompt 06 may begin with read-only planning. Every external or remote mutation remains separately gated.

- A healthy Prompt 05 staging deployment with release ID, protected `dev` source SHA, exact web/server image digests, immutable staging-application and shared-infrastructure payload digests/SHA-256/provenance, staging activation-manifest digest/signature, pre-activation CI evidence, exact successful off-Netcup staging checkpoint/acceptance-record digest with post-activation outcome evidence, resource evidence, and rollback target.
- The current independently protected deployment epoch/high-water checkpoint and proof it matches the active host; production receives the next approved sequence and cannot reuse a prior epoch/request.
- Proof that the candidate's source SHA is still reachable from protected `dev` and that no image or application payload will be rebuilt.
- A production promotion manifest that preserves the complete active staging block, keeps the shared-infrastructure payload unchanged, adds base+staging+production, copies the current staging application payload/images into production, directly carries every approved non-secret render value (including domains, certificate/mail identity, prelaunch CIDRs, and the collision-checked production mail-admin subnet/IP), selects the restricted production Caddy fragment, records the expected rendered-Compose digest, and references the prior host manifest.
- `<PRODUCTION_APP_DOMAIN>`, `<MAIL_DOMAIN>`, `<MAIL_HOSTNAME>`, `<BOUNCE_DOMAIN>`, `<PRELAUNCH_TEST_CIDRS>`, Cloudflare DNS access, and exact production OAuth callback origins. The tester CIDRs must be fixed public or approved VPN egress addresses capable of completing browser callbacks.
- After current Docker/VPN network discovery, an approved collision-free `<PRODUCTION_EDGE_SUBNET>` and fixed `<PRODUCTION_CADDY_IP>`; production Fastify trusts only that peer while the staging edge settings remain unchanged.
- Separate production Better Auth secret/cookie, Google client, database roles, Valkey ACL users, worker-only versioned action-link derivation keyring, API-only operations-health token, other signing keys, media paths, webhook secret, and Stalwart credentials.
- Production sender identities and only the named operational mailboxes: postmaster, abuse, support, or another explicitly approved operational address.
- Netcup SCP/CCP access, current firewall and `netcup Mail block` state, confirmed inbound/outbound TCP 25 capability after block removal, PTR control, assigned-IP reputation checks, and written Netcup clarification when required by `docs/decisions.md`.
- A reviewed transactional-only sending policy, low launch quotas, rate limits, abuse handling, bounce handling, and suppression behavior. No marketing, newsletter, campaign, bulk-mail, or end-user mailbox requirement is permitted.
- An approved Restic repository physically and administratively outside Netcup, append-only/object-lock/versioning controls where practical, a non-deleting VPS write credential, a separate off-VPS retention/prune identity and recovery custodian/channel, retention policy, and restore-test destination.
- An approved encrypted append-only security-tombstone journal outside Netcup (it may use a separately isolated prefix/account at the offsite storage provider), a production API create-only/no-read/no-delete credential, a separate operator recovery/decrypt identity, and monitoring destination.
- External production monitoring/alert destination.
- Protected GitHub production Environment with manual approval and the pull-based deployment path established in Prompt 05.
- A separate protected production-promotion workflow/identity with narrowly scoped `contents: write`, permission to update `main` only with force disabled after the exact GitHub Deployment succeeds, and no access to VPS secrets. The VPS reconciler itself cannot write repository refs.
- Explicit production activation and, later, public-launch approvers.

## Allowed actions

Only after the matching approval gate:

- Verify the staging release, test evidence, source SHA, immutable digests, current host health, capacity, and rollback readiness.
- Configure the protected GitHub production Environment and create a manual production Deployment request that references the unchanged shared-infrastructure payload and exact staging-tested application-payload/image digests plus a new signed production activation-manifest digest. Its deployment policy must permit that exact protected-`dev` SHA because `main` advances only afterward.
- Install distinct production secrets through the approved root-readable channel.
- Configure the production security-tombstone journal only under its separate approval and prove prepare/commit/fail-closed recovery behavior before permitting access-lowering operations.
- Add the Cloudflare production application record in DNS-only mode and exact production OAuth callbacks. Start with the reviewed restricted production fragment and `<PRELAUNCH_TEST_CIDRS>`; do not enable Cloudflare proxying because Caddy must see the real source address for this gate.
- Seal a release whose active overlay list is base+staging+production, whose staging block remains byte-for-byte or canonically identical to the active staging release, and whose shared-infrastructure digest is unchanged.
- Acquire the global host-operation lock with a bounded wait for every install/activation/migration/rollback/public-edge mutation, then re-read the active predecessor and approval while locked. Backups additionally follow the fixed host-operation-then-backup lock order.
- Privately bootstrap Stalwart with the Netcup Mail block and public SMTP still closed; validate its non-delivering configuration and remove temporary bootstrap access before application activation. Do not invoke production webhooks or external delivery during this phase.
- Initialize isolated production PostgreSQL, Valkey, media, app, worker, and web services; run the one-shot production migration; then activate production through the outbound reconciler.
- After the dedicated mail preflight, obtain written policy clarification where required and then, under the matching approvals, remove the Netcup Mail block in SCP, apply the minimum Netcup firewall changes, set PTR, configure Cloudflare MX/SPF/DKIM/DMARC, activate Stalwart, and send controlled transactional tests.
- Before external mail activation, build and seal a new next-sequence `production-mail` manifest from the current restricted-production predecessor. It changes only the locked mail-transition fields in `docs/deployment.md`, sets `mail_mode: external`, independently recomputes rendered/config digests, and preserves staging plus every non-mail production/shared/edge field.
- Initialize Restic against the approved off-Netcup repository, enforce/test the non-deleting VPS credential, run the measured restore-capacity preflight, and perform a disposable non-public/no-production-egress restore test with production OAuth/webhook/SMTP/DNS credentials absent and workers/schedulers disabled or capture-only. If the dump plus restored database/media/mail and temporary overhead would cross 70% disk use, approach 80%, or violate the 20% free reserve, use only the separately approved isolated external restore destination; do not consume emergency headroom. Enable backup/restore-check timers only after the test passes. Configure retention/prune only under the separate off-VPS operator identity.
- Configure external monitoring and run production smoke, authorization, tenant-isolation, TLS, mail, backup, rollback, resource, and cross-environment tests.
- After restricted production, transactional mail, offsite backup/isolated restore, monitoring, reboot, rollback, security, isolation, and capacity gates all pass and the release record is durable, let only the separate protected promotion identity fast-forward `main` to the staged source SHA with force disabled, then verify the remote ref. If a later rollback restores an older code tree, record that live tree with a reviewed forward rollback/revert commit; never force-move `main`. The root-sealed release manifest remains authoritative for runtime digests.
- Open production publicly only after a final, separate approval. Re-read the currently active host manifest immediately before signing: preserve its current staging block/shared-infrastructure payload byte-for-byte, require its restricted production non-edge block to match a completed verification record, and create a new manifest whose only changes are the public-launch fields defined in `docs/deployment.md`. Preserve all production application/image/domain/mail/schema/config/evidence fields.

## Prohibited actions

- Do not rebuild, retag as identity, or substitute any image/application payload after staging testing; do not change the shared-infrastructure payload during ordinary promotion.
- Do not deploy a source SHA that is not the recorded staging candidate or advance `main` before verified production success.
- Do not force-push or reset `main`, create `staging`/`production` branches, or treat branch names as deployment state.
- Do not stop, recreate, reconfigure, or change staging during production promotion. If automatic staging advances before public launch, do not reuse the stale restricted-release manifest; build the edge-only launch transition from the new current predecessor while preserving that current staging block. A shared-Caddy/Compose payload change is a separate host-wide transition and is not part of ordinary production promotion.
- Do not share database, Valkey, media, secret, cookie, OAuth, mail, network, or backup credentials across environments.
- Do not expose PostgreSQL, Valkey, Docker, Stalwart administration, Mailpit, private media, reconciler, or internal health details publicly.
- Do not remove the Netcup Mail block before the mail gate; do not send marketing, newsletters, campaigns, bulk mail, or host general end-user mailboxes.
- Do not claim deliverability merely because SMTP accepted a message.
- Do not use Netcup snapshots as the only backup or place the production Restic repository inside the same Netcup account/provider failure domain.
- Do not copy staging/test data into production or production data into staging.
- Do not enable deferred systems solely because the VPS has 8 GB.

## Deliverables

- A recorded pre-promotion host/staging baseline and capacity check.
- GitHub production Environment approval evidence and a Deployment request referencing the exact staging-tested source SHA, staging-application payload, unchanged shared-infrastructure payload, web/server digests, and the new signed production activation-manifest digest.
- A root-sealed base+staging+production manifest preserving the staging block, copying its current application payload/images into production, keeping shared infrastructure unchanged, selecting restricted production edge mode, and independently matching its expected rendered-Compose/config digests with no unresolved or cross-environment token.
- Global host-operation/backup-lock evidence showing bounded waits, correct lock order, killed-process recovery, serialized release/mail/backup/restore/maintenance operations, and predecessor revalidation while locked.
- Isolated production PostgreSQL, Valkey, migration, API, worker, web, media, credentials, volumes, and networks using immutable digests.
- Successful migration plus proof that runtime database roles and API Valkey user cannot perform worker/migration-only actions.
- Valid restricted production HTTPS with DNS-only Cloudflare resolution, an external 403 from outside the allowlist, successful access/OAuth from a reviewed tester/VPN CIDR, host-only cookies, health routing, websocket core, and public/private media boundaries.
- Transactional-only Stalwart with private administration, internal hostname TLS/SNI validation, signed/idempotent feedback ingestion, low quotas, and only approved operational mailboxes.
- A distinct active `production-mail` release/checkpoint proving the private predecessor had no host SMTP listener and the external variant added only approved TCP 25 plus loopback IMAPS publication; documented next-sequence private-mode rollback.
- Netcup Mail-block change, firewall, PTR, assigned-IP reputation, provider-policy evidence, and Cloudflare mail DNS documented with approvals.
- Off-Netcup Restic backup, a complete canonical recovery-set manifest/completion marker, measured restore-capacity decision, isolated no-production-egress restore test on a safe local or separately approved external target, append-only/versioning evidence, proof the VPS credential cannot delete/prune history, separate retention-identity evidence, lock/retention evidence, exact cleanup record, and recovery instructions. Prove partial/mixed sets are rejected and restored sessions/action-link intents cannot reopen as valid after the recovery policy. Netcup snapshots, if used, are labeled supplemental.
- Append-only security-tombstone journal evidence, unresolved/gap alerts, high-water inclusion, and restore proof that disabled/deleted accounts, unlinked providers, removed/demoted members, ownership changes, and deleted organizations do not regain access.
- External monitoring from outside the VPS.
- Proof that staging cannot access production and production activation did not change staging's state or tested digests.
- A tested production rollback using a newly signed manifest that preserves current staging and shared infrastructure. The first production release replaces only production with restricted/no-production-app state without deleting production data; later releases replace only production with a prior compatible production block. Never reactivate an old whole-host manifest.
- Protected `main` advanced only after verified production, or left unchanged after failure/rollback until an approved forward rollback record matches the live tree.
- Evidence that the branch-update actor was separate from the VPS reconciler, checked the successful Deployment ID and expected old/new refs, used force-disabled update semantics, and left the remote `main` ref equal to the verified source.
- A final launch decision: remain restricted, or activate a separately signed manifest satisfying the public-launch invariant in `docs/deployment.md` and prove access from a previously disallowed source.

## Verification commands

Use exact hostnames and sanitized output. Execute only after the associated approvals.

Before activation:

```bash
git fetch --prune origin
git merge-base --is-ancestor origin/main <STAGED_SOURCE_SHA>
git merge-base --is-ancestor <STAGED_SOURCE_SHA> origin/dev
git ls-remote --exit-code --refs origin refs/heads/main
sudo /usr/local/sbin/<app-slug>-install-release <release-id> /srv/myapp/release-inbox/<activation-manifest-digest>.yaml
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> verify
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> config --quiet
free -h
df -h
```

Immediately before the approved branch update, the workflow re-reads the remote `main` ref and compares it to the expected old SHA used by the force-disabled update. After production succeeds, the separate gate is approved, and the update completes, verify:

```bash
test "$(git ls-remote --refs origin refs/heads/main | cut -f1)" = "<STAGED_SOURCE_SHA>"
```

After separate production activation approval:

```bash
sudo /usr/local/sbin/<app-slug>-activate-release <release-id> --target production
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> verify
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> ps
```

After the independent mail and backup approvals:

```bash
sudo /usr/local/sbin/<app-slug>-activate-release <mail-release-id> --target production-mail
sudo /usr/local/sbin/<app-slug>-backup check
sudo /usr/local/sbin/<app-slug>-backup run
sudo /usr/local/sbin/<app-slug>-backup restore-test --isolated --deny-production-egress --mail-sink capture
sudo /usr/local/sbin/<app-slug>-backup credential-test --expect-delete-denied
```

From approved external probes:

```bash
curl --fail --silent --show-error https://<PRODUCTION_APP_DOMAIN>/api/health/live
curl --fail --silent --show-error https://<PRODUCTION_APP_DOMAIN>/api/health/ready
openssl s_client -connect <MAIL_HOSTNAME>:25 -starttls smtp -servername <MAIL_HOSTNAME>
corepack pnpm test:environment-isolation
corepack pnpm test:e2e:production
```

Before public launch, run the HTTPS checks once from an address outside `<PRELAUNCH_TEST_CIDRS>` and require HTTP 403, then from an approved tester/VPN egress and require the expected successful response and OAuth callback. After the separately approved signed switch to `production_edge_mode: public`, require a successful HTTPS response from the formerly disallowed source. Record the restricted/public fragment digests and activation-manifest digests.

Also prove: `/api/health/dependencies` returns 404 outside the administrator/VPN CIDRs, rejects an allowed source without the production operations token, and succeeds only with both controls; exact OAuth origins work; magic links/invitations are delivered and feedback is authenticated/idempotent; SPF/DKIM/DMARC/PTR and TLS are correct; private/admin ports remain closed; workers lack public egress; Caddy exposes only public variants; production and staging credentials fail against the other environment; staging has no production SMTP/Restic credential; production activation leaves staging container IDs/digests/state unchanged; the shared Caddy process may reload but its staging fragment/digest and behavior remain unchanged; competing host operations serialize with bounded timeout and recheck the predecessor; the isolated restore cannot reach real users/providers and invalidates restored sessions/unexpired action-link intents before any reopen; the release can roll back; and the live release record, deployment status, and `main` state follow the branch rule.

## Approval gates

1. Approval to configure/change the GitHub production Environment and create the exact-digest production Deployment request.
2. Approval for Cloudflare production application DNS and production OAuth-console changes.
3. Approval to create/install production application, database, Valkey, auth, signing, and deployment secrets.
4. Narrow release-install approval naming host, release ID, epoch/sequence, source SHA, unchanged shared-infrastructure and staging-application payload digests/checksums, new production activation-manifest digest/checksum, expected rendered-Compose/config digests, active overlays, preserved staging block, every concrete non-secret render input, restricted edge-fragment/CIDR-set digests, exact image digests, and off-VPS checkpoint target; sealing only.
5. Separate production activation approval naming migration, services, backup readiness, capacity evidence, and rollback plan.
6. Independent mail-policy/provider approval covering Netcup clarification, IP reputation, TCP 25, Netcup Mail-block removal, firewall, PTR, Cloudflare mail DNS, Stalwart secrets, quotas, mailbox list, the exact next-sequence `production-mail` manifest/release/render/config/evidence digests and rollback, and one controlled external test.
7. Approval to create/write the off-Netcup Restic repository with the non-deleting VPS identity, test delete denial, run the exact isolated no-production-egress restore fixture and cleanup, and separately configure the off-VPS retention/prune identity and policy.
8. Separate approval for the encrypted append-only security-tombstone journal, production API create-only credential, operator recovery identity, and controlled failure/replay tests.
9. Approval to create/change external monitoring and alerts.
10. Approval for the separate protected promotion workflow/identity to advance `main` after verified production success. It must verify the successful Deployment ID and expected old ref, use force-disabled update semantics, and set the remote ref to the exact staged source SHA; rollback reconciliation uses a separately reviewed forward commit.
11. Separate approval for the exact new activation manifest based on the current active predecessor, preserving its current staging block and verified restricted production non-edge block, with only the allowed public-launch fields changed as defined in `docs/deployment.md`; then activate and verify externally. Cloudflare proxying, if ever desired, remains a different reviewed change.

An approval applies only to its described target and reviewed change set.

## Stop conditions

- Stop if staging is unhealthy, the candidate evidence is incomplete/stale, the source SHA/digests differ, provenance fails, or a rebuild would be required.
- Stop if the promotion manifest drops or mutates staging, changes shared infrastructure unexpectedly, has a missing/extra/mismatched referenced payload, introduces cross-environment access, or fails root-sealing checks.
- Stop on migration failure, failed health/readiness, authorization/isolation failure, OOM kill, sustained swap, unsafe disk pressure, or rollback failure.
- Stop on lock bypass/reverse order/unbounded wait, predecessor drift after lock acquisition, insufficient safe restore capacity without an approved isolated external target, a restore fixture with production credentials/egress, any security-tombstone replay gap/unresolved prepared event, or any restored session/action link/removed authorization that can become valid again.
- Stop mail activation if Netcup policy/clarification, Mail-block removal, TCP 25, PTR, DNS, reputation, TLS, abuse, feedback, or quota prerequisites fail. Keep production restricted and preserve alternate admin access.
- Stop before advancing `main` unless production is verified at the exact staged source/digests. On activation failure or rollback, leave `main` unchanged until the live state is reconciled by the documented forward-only rule.
- Stop if the restricted source-CIDR gate does not deny an unapproved source or blocks the reviewed tester/VPN OAuth flow.
- Stop before public launch until explicit approval and backup restore, monitoring, mail, security, and smoke gates all pass. Stop on predecessor drift; re-read the current manifest and regenerate/reapprove rather than freezing or rolling staging backward. The launch manifest must preserve current staging and every non-edge production/payload/image field.

## Final report format

```text
Outcome: PRODUCTION DEPLOYED AND RESTRICTED | APPROVED FOR PUBLIC LAUNCH | ROLLED BACK | BLOCKED
Approvals received:
Staging evidence reused:
Production release ID, source SHA, and exact digests:
Active host manifest and preserved staging evidence:
Migration/runtime-role evidence:
Health, auth, security, and isolation evidence:
Netcup mail-policy/firewall/PTR evidence:
Cloudflare DNS and OAuth evidence:
Mail delivery/feedback evidence:
Off-Netcup backup and restore evidence:
Resource and monitoring evidence:
Rollback evidence:
main status and rationale:
External changes performed:
Commands actually run:
Open risks or manual follow-ups:
Public launch status and next approval:
```
