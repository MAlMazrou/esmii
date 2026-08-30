# Prompt 01 — Review the project documents

## Objective

Build a decision-complete implementation plan from the repository documents. This phase is read-only: it must not change the repository or any external system.

## Instruction to the agent

Read `README.md`, `AGENTS.md`, `docs/README.md`, `docs/requirements.md`, `docs/infrastructure.md`, `docs/environments.md`, and `docs/decisions.md` in that order. Then inspect every product, design, engineering, ADR, and prompt document indexed by `docs/README.md`. Treat the canonical core/process documents and relevant lifecycle documents marked `APPROVED` as constraints; intentionally incomplete draft templates are expected scaffolding, not implementation authority or missing-document blockers. Execute only `docs/prompts/01-review-documents.md`. Do not edit files, access the VPS, create credentials, change DNS, configure mail, or deploy anything during this phase. Return the implementation plan, document-status inventory, unresolved external inputs, and any contradictions, then stop.

After those seven initial documents, also read `docs/vps-setup.md`, `docs/deployment.md`, `docs/prompts/README.md`, the optional product-discovery prompt, and Prompts 02–06 so the review covers every project document and later-phase boundary. Prompt 01 itself is the currently executing instruction.

## Inputs

- A clean or understood checkout of the repository.
- Every project Markdown document indexed by `docs/README.md`, including the current prompt, the optional discovery prompt, and Prompts 02–06.
- Read-only internet access, if available, for current-version verification against official primary documentation.
- No production secret, OAuth private key, VPS credential, or DNS credential is needed.

## Allowed actions

- Inspect repository files and Git metadata without modifying them.
- Identify existing user changes and files that must be preserved.
- Verify that the proposed runtime and dependency versions are currently supported, using official project documentation and release sources.
- Inspect existing package manifests, lockfiles, Compose files, migrations, tests, and workflows if they exist.
- Produce a plan in the response.
- Inventory canonical core/process documents by role. For product/design/engineering/ADR lifecycle documents, verify the declared status and trace requirements only from active approved sources. Draft open questions may be reported but not answered by assumption.

## Prohibited actions

- Do not create, edit, format, rename, move, or delete files.
- Do not install or update dependencies and do not generate a lockfile.
- Do not start containers or services.
- Do not connect to a VPS, registry, DNS provider, OAuth console, mail server, or backup repository.
- Do not create credentials, secrets, keys, accounts, repositories, releases, issues, or pull requests.
- Do not commit, push, deploy, migrate, seed, or reset data.
- Do not execute Prompt 02 or any later prompt.

## Deliverables

Return all of the following in the final response:

1. Repository baseline: current branch, relevant files, whether the worktree is clean, and any user changes that must be preserved.
2. Documentation inventory: canonical core/process documents grouped by role, plus every product/design/engineering/ADR document grouped as approved, draft, or superseded with missing/invalid lifecycle status called out. Intentionally empty draft templates are not blockers.
3. Requirements traceability: every approved requirement mapped to its likely application, package, migration, test, or infrastructure file.
4. A file-by-file implementation plan for Prompt 02 only, followed by a separate preview of later phases.
5. A dependency-version table containing proposed exact versions, compatibility notes, source links, and the date checked. Do not edit manifests.
6. Contradictions, ambiguities, or unsafe assumptions, each with a recommended resolution.
7. Missing external inputs grouped by the prompt that will require them. Keep unresolved product questions separate; they do not block the generic core unless Prompt 02 would otherwise invent product behavior.
8. A risk list for authentication, tenant isolation, Netcup mail deliverability/policy, storage, migration, backup, rollback, the combined 8 GB staging-plus-production resource budget, and the `dev`/`main` exact-digest promotion model.

## Verification commands

Use read-only equivalents appropriate to the repository. At minimum, report the output or result of:

```bash
pwd
git status --short --branch
git ls-files
rg -n "TODO|FIXME|PLACEHOLDER|<[^>]+>" README.md AGENTS.md docs
git ls-files | rg '(^|/)infrastructure[.]md$'
git branch --show-current
git merge-base --is-ancestor main dev
```

If the directory is not a Git checkout, report that fact and stop any Git-dependent inspection; do not initialize a repository.

## Approval gates

None. This prompt grants no write or external-action authority.

## Stop conditions

- Stop immediately if any requested read would expose a secret; report the file path without printing its value.
- Stop and report if the source documents are missing or their priority cannot resolve a contradiction.
- Do not stop merely because a product/design/engineering template is intentionally `DRAFT`, empty, or contains `TBD`.
- After returning the review and plan, stop. Wait for explicit authorization before Prompt 02.

## Final report format

```text
Outcome: PASS | PASS WITH DECISIONS REQUIRED | BLOCKED
Repository baseline:
Documentation status inventory:
Version verification:
Requirements-to-files map:
Prompt 02 implementation plan:
Later-phase preview:
Contradictions and recommended resolutions:
External inputs by phase:
Risks and mitigations:
Commands actually run:
Files changed: none
Approval needed for next action: yes — Prompt 02
```
