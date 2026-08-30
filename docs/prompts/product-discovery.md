# Optional product-discovery prompt

This is a planning aid, not part of the numbered infrastructure implementation sequence. Run it only when the user explicitly wants to define the product. It grants no code, Git, VPS, provider, credential, or deployment authority.

## Objective

Collect the missing product and design context without inventing requirements, then propose content for the draft documents under `docs/product/` and `docs/design/`.

## Inputs

- The user's product idea and answers supplied during the session.
- `README.md`, `AGENTS.md`, `docs/README.md`, `docs/requirements.md`, and the existing draft product/design templates.
- No credential, production data, or external-system access.

## Interview method

- Ask one decision question at a time.
- Briefly recommend an option when useful and explain its tradeoff in plain language.
- Cover the problem, target users, core workflows, MVP/non-goals, terminology, domain entities, permissions, screens/navigation, brand direction, responsive behavior, accessibility, localization, notifications, media, success measures, and deferred ideas.
- Record uncertainty as `TBD`; never turn an assumption into a requirement.
- Distinguish a user decision from an agent recommendation.

## Allowed actions

- Read repository documentation.
- Ask planning questions and summarize answers.
- Return proposed document content in the response.
- Edit the draft documents only after a separate explicit user instruction naming the files to update.

## Prohibited actions

- Do not write code, install dependencies, create schemas, or change infrastructure.
- Do not edit files during the interview unless separately authorized.
- Do not approve documents on the user's behalf.
- Do not access GitHub, Netcup, Cloudflare, OAuth consoles, mail, or other external systems.
- Do not add features, roles, entities, screens, or branding that the user did not decide.

## Deliverables

- Decision log separating approved answers, recommendations, assumptions, and unresolved questions.
- Proposed updates for `docs/product/prd.md`, `user-flows.md`, `domain-model.md`, `permissions.md`, `roadmap.md`, and `glossary.md`.
- Proposed updates for the relevant files under `docs/design/`.
- A list of engineering documents that can be derived only after product approval.
- A final request for approval before any document is marked `APPROVED` or implementation begins.

## Stop conditions

- Stop when a product owner decision is required and no safe neutral default exists.
- Stop if the requested product would conflict with the core's security or tenant-isolation rules; explain which canonical documents would require an approved change.
- Stop after delivering the proposed documentation set.

## Final report format

```text
Outcome: DISCOVERY DRAFT COMPLETE | BLOCKED
User-approved decisions:
Agent recommendations not yet approved:
Unresolved questions:
Proposed document updates:
Conflicts with current core:
Files changed: none unless separately authorized
Approval needed before writing/approving documents: yes
```
