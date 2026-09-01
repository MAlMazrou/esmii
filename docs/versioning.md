# Application versioning and releases

**Status:** active repository and deployment contract.
**Version source of truth:** the root [`package.json`](../package.json).

Esmii uses one application version for the whole monorepo. The web, API, worker, and migration entrypoints are released together as `vX.Y.Z`; private workspace-package versions are not independent releases.

## Current convention

- The initial version is `v0.1.0`.
- The project remains below `v1.0.0` until the user explicitly declares the first stable release.
- `fix:`, ordinary `feat:`, documentation, maintenance, and other non-breaking commits increment the patch: `v0.3.2` becomes `v0.3.3`.
- A header with `!`, such as `feat!:`, or a `BREAKING CHANGE:` footer increments the pre-1.0 minor: `v0.3.2` becomes `v0.4.0`.
- Existing history before [`.commitlint-baseline`](../.commitlint-baseline) is not rewritten. Conventional Commits are enforced for new branch history and pull-request titles.

Examples:

```text
fix: correct invitation link validation
feat: add organization audit history
feat!: replace the organization membership contract
```

The first two examples are patch releases under the current pre-1.0 policy. The breaking example is a minor release. Scopes are optional, so `fix(auth): ...` and `feat(organizations): ...` are also valid.

## Automatic main release flow

Every accepted push or merge to protected `main` starts [`.github/workflows/release.yaml`](../.github/workflows/release.yaml):

1. Check the new commit message and install the frozen dependency graph.
2. Run [`scripts/release-version.mjs`](../scripts/release-version.mjs), which reads commits since the latest `vX.Y.Z` tag and applies the pre-1.0 policy in [`scripts/version-policy.mjs`](../scripts/version-policy.mjs).
3. Use the pinned `commit-and-tag-version` package to update `package.json`, generate or update `CHANGELOG.md`, and create a provisional tag.
4. Push those files on a short-lived bot branch and merge a `chore(release): vX.Y.Z` pull request through protected `main` using the `github-actions[bot]` identity.
5. Attach the immutable `vX.Y.Z` tag to the resulting protected-main commit.
6. Synchronize `package.json` and `CHANGELOG.md` to `dev` so both long-lived branches start their next work from the same released version.
7. Explicitly dispatch the production build from tagged `main` and the staging build from synchronized `dev`.

The CI workflow no longer builds a direct `main` push. It accepts production only after the release commit and tag exist. This guarantees that the version bump happens before `next build` and before deployment. A failed release preparation or merge produces no tag and dispatches no deployable build.

Do not run `release:prepare` manually on `dev`. Normal work uses Conventional Commit messages and lets the protected `main` workflow own release commits and tags.

## Build-time propagation

[`scripts/app-version.mjs`](../scripts/app-version.mjs) validates the root version and exposes it as `vX.Y.Z`:

- `ESMII_APP_VERSION` identifies both OCI images and their `org.opencontainers.image.version` labels.
- `NEXT_PUBLIC_APP_VERSION` is passed to the web Docker build as a build argument before `next build`.
- [`apps/web/next.config.ts`](../apps/web/next.config.ts) derives the same value from the root package and rejects a mismatched supplied value.
- [`apps/web/lib/app-version.ts`](../apps/web/lib/app-version.ts) is the browser-safe, statically inlined application export.
- [`apps/web/components/app-version.tsx`](../apps/web/components/app-version.tsx) renders the current version in the shared footer without a runtime request or client-side JavaScript.

The image builder and VPS pullers reject mismatched or non-pre-1.0 image labels. Environment-specific domains, credentials, and other runtime values remain outside the image; the public application version is the only approved `NEXT_PUBLIC_*` build value.

## Future version page

When a version or release-history page is requested, start here and reuse these existing seams:

1. Import `APP_VERSION` from `apps/web/lib/app-version.ts` for the current build version.
2. Reuse `apps/web/components/app-version.tsx` for the compact version label or move its presentation into a shared component without changing the source of truth.
3. Use the generated root `CHANGELOG.md` as the release-history source. Transform it at build time; do not add a GitHub token, browser-side GitHub API call, database table, or VPS runtime fetch merely to display release notes.
4. Keep `package.json` as the sole current-version authority and retain the mismatch checks in `next.config.ts`, `scripts/images.mjs`, and CI.
5. Extend `tests/policy/versioning-policy.test.ts` and add rendered page coverage when that page is implemented.

The relevant files can therefore be found by searching for `APP_VERSION`, `NEXT_PUBLIC_APP_VERSION`, or this document's title.

## Operator checks

```bash
corepack pnpm version:verify
corepack pnpm commitlint
```

After a release, verify that the root package and `CHANGELOG.md` were committed by the bot, `vX.Y.Z` points to that protected-main commit, the released protected-main ancestry and metadata were synchronized back to `dev`, CI reports the same version, and the deployed footer and OCI labels agree.

`commit-and-tag-version` is used instead of the deprecated `standard-version` package because it preserves the same commit-driven workflow while remaining maintained. Changesets is intentionally not used: this repository releases one application as a unit and does not need independent workspace-package release plans.
