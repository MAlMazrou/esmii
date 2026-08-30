# Automatic dev-to-staging pull

This runbook covers only the active Prompt 05 staging exception recorded in `DEC-INPUT-023`. It never deploys `main` or creates production state.

## Normal flow

1. Push or merge a change to `dev`.
2. GitHub Actions runs quality, policy, integration, migration, Compose, infrastructure, image, vulnerability, SBOM, runtime, and browser checks.
3. A successful run publishes full-SHA GHCR images and advances only their `:dev` pointers.
4. `esmii-staging-pull.timer` notices the new `dev` SHA within about two minutes. It requires the matching push-triggered CI run to have completed successfully.
5. The host prefers GHCR digest references. If GHCR requires authentication, it builds the exact successful public SHA on the VPS and verifies the source/revision image labels.
6. The host runs the staging migration, replaces the staging web/API/worker services, verifies `https://staging.esmii.app/api/health/live`, and records the active SHA and image references.

The timer keeps the existing staging release when CI is pending or failed. A failed activation restores the preceding staging Compose overlay; on the first activation it restores the temporary Caddy demo.

Canonical staging credentials remain root-owned mode `0600` below `/etc/myapp/secrets/staging`. Before Compose starts, the root-owned pull service refreshes mode-`0444` copies below a root-only mode-`0700` directory at `/etc/myapp/runtime-secrets/staging`. Docker mounts only each service's explicitly declared files, which lets non-root containers read their own credentials without exposing the canonical set to host users or unrelated services.

## Read-only status

```bash
systemctl status esmii-staging-pull.timer --no-pager
systemctl status esmii-staging-pull.service --no-pager
journalctl -u esmii-staging-pull.service -n 100 --no-pager
cat /var/lib/esmii/staging-pull/current.env
docker compose --project-name esmii \
  -f /srv/myapp/staging-runtime/compose.yaml \
  -f /srv/myapp/staging-runtime/compose.staging.yaml ps
curl --fail --silent --show-error https://staging.esmii.app/api/health/live
```

The state file contains only the public Git SHA and image references, never credentials.

## Emergency disable

```bash
sudo systemctl disable --now esmii-staging-pull.timer
```

Disabling the timer does not stop the currently healthy staging application. Do not delete its volumes or secret directory during diagnosis. Re-enable only after the workflow, current `dev` SHA, service logs, and active image labels are reviewed.

## Reuse

For another repository or VPS, change the non-secret values in `infra/staging-pull/staging-pull.conf`, create that project's root-only staging secrets, install the bundle, and keep its GitHub repository, domain, Docker project, networks, state paths, and OAuth application separate. Do not reuse Esmii secrets or production state.
