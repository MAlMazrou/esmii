# Infrastructure architecture

**Baseline date:** 29 August 2026  
**Host:** Netcup RS 1000 G12, Ubuntu 26.04 LTS, 4 dedicated x86-64 AMD EPYC cores, 8 GB ECC RAM, 256 GB NVMe, static IPv4, routed `/64` IPv6  
**Constraint:** one VPS; further capacity may require an in-place compatible upgrade or a new-server migration, so retained IPs and zero-downtime resizing are never assumed  
**Goal:** self-host the important application services while keeping the first production system understandable, portable, and able to grow.

## 1. The final recommendation

**Current production gates (30 August–1 September 2026):** the user authorized public `esmii.app` immediately and CI-gated outbound pull behavior for both branch environments. A `dev` candidate may build directly for staging; every accepted `main` change must first receive its bot-owned semantic release commit and immutable `vX.Y.Z` tag before production CI is dispatched. Production uses separate PostgreSQL, Valkey, media, credentials, networks, and mail state. On 31 August the user separately required a self-hosted mail server; Stalwart was activated and a real magic-link canary was delivered. Staging has its own sender, credential, and internal submission network for exactly two user-selected testers while retaining private Mailpit for operator capture. Production Google OAuth, offsite-backup/restore acceptance, external monitoring acceptance, and final hardened-production acceptance remain later gates. These current delivery decisions supersede older manual/restricted or capture-only wording below where they conflict; the isolation and eventual hardened-service requirements remain.

Start with one pnpm monorepo containing the frontend, modular-monolith backend, worker/migration entrypoints, shared packages, infrastructure, tests, CI/CD, and runbooks. Deploy with Docker Compose. The first remote release runs reduced staging; the next approved release adds production while retaining staging. The full 8 GB composition has one shared Caddy plus six staging services and six production services:

1. shared Caddy;
2. staging web, API, worker, PostgreSQL, Valkey, retained private Mailpit, and the separately credentialed Stalwart submission path used for allowlisted testers;
3. production web, API, worker, PostgreSQL, Valkey, and Stalwart.

Migration entrypoints are one-shot jobs, not long-running containers. If a media feature is later approved, files live in environment-specific host filesystem roots with physically separate public and private trees. PostgreSQL stores metadata and ownership, not ordinary media bytes. SeaweedFS or another S3-compatible service remains deferred until measured product need and an approved resource plan; starting with 8 GB is not permission to enable it.

This is the important distinction:

- It is **scalable within one host**, because the VPS can be enlarged and stateless containers can be replicated.
- It is **not highly available**, because the one VPS, one NVMe disk, one network, and one public IP remain a single failure domain.

The architecture deliberately does not include Kubernetes, Kong, APISIX, RabbitMQ, Kafka, a separate realtime server, a separate identity server, Elasticsearch, or a heavyweight monitoring stack. None solves a current problem in a small, single-host application.

### Conservative launch profile for the 8 GB VPS

- Prompt 05 runs shared Caddy plus reduced staging. Prompt 06 adds production with the exact staging-tested artifacts.
- Run Next.js standalone SSR without ISR, on-server image optimization, or routes that rely on a writable Next.js cache.
- Run one API and one queue-concurrency-1 worker per environment.
- Use physically separate staging and production media roots; Caddy reads only each environment's public prepared variants.
- Staging captures mail in private Mailpit and can never use production SMTP.
- Production Stalwart sends only low-volume transactional/account mail and hosts named operational mailboxes. Netcup bulk-mail policy excludes marketing, newsletters, campaigns, broadcasts, and general end-user mailbox hosting.
- Keep PostgreSQL pools and Valkey memory small, and apply conservative Sharp/libvips limits.
- Add modest emergency swap, but treat normal-load swapping as a capacity incident.
- Send encrypted production backups to a repository outside Netcup and monitor externally.
- Keep SeaweedFS, ClamAV, Prometheus/Grafana, video transcoding, API replicas, public mailbox mode, Kubernetes, and additional brokers disabled until measured need and separate approval.
- Preserve at least 20% disk space and enough RAM/page-cache headroom for migrations, backup/restore, and media bursts.

Before public launch, run representative combined staging+production load covering SSR, auth, both PostgreSQL/Valkey pairs, outbox/workers, Caddy, and transactional mail. Investigate sustained RAM above 70%; sustained 75%+, normal-load swap, or any OOM kill is an immediate resize/optimization gate. Do not weaken isolation or security to fit the host.

If the application becomes serious enough to require availability, no amount of vertical resizing changes the one-host failure domain. The first future split should usually be mail, followed by PostgreSQL or object storage according to the measured bottleneck.

## 2. Architecture

~~~mermaid
flowchart TB
    Users[Browsers and API clients]
    Admin[Operator over SSH tunnel or private management network]
    RemoteMail[Other mail servers]
    Monitor[External uptime monitor]
    BackupTarget[Encrypted Restic repository outside Netcup]
    GitHub[GitHub Actions, Deployments, and GHCR]
    Cloudflare[Cloudflare authoritative DNS]

    subgraph Netcup[Netcup SCP firewall and network]
      subgraph VPS[One Ubuntu 26.04 VPS, 8 GB]
        HostPolicy[Docker-aware host firewall]
        Caddy[Shared Caddy: TLS, HTTP gateway, WebSocket proxy]
        Reconciler[Root-owned outbound deployment reconciler]
        Timers[systemd timers: backup and maintenance]

        subgraph Staging[Isolated staging]
          SWeb[staging-web]
          SAPI[staging-api: Better Auth and Socket.IO]
          SWorker[staging-worker]
          SPG[(staging-postgres)]
          SValkey[(staging-valkey)]
          SMail[staging-mailpit]
          SMedia[(staging media: public/private)]
        end

        subgraph Production[Isolated production]
          PWeb[production-web]
          PAPI[production-api: Better Auth and Socket.IO]
          PWorker[production-worker]
          PPG[(production-postgres)]
          PValkey[(production-valkey)]
          PMail[production-stalwart]
          PMedia[(production media: public/private)]
        end

        HostPolicy --> Caddy
        Caddy --> SWeb
        Caddy --> SAPI
        Caddy --> PWeb
        Caddy --> PAPI
        Admin -->|private listener; never Caddy| PMail

        SAPI --> SPG
        SAPI --> SValkey
        SAPI --> SMedia
        SWorker --> SPG
        SWorker --> SValkey
        SWorker --> SMedia
        SWorker --> SMail

        PAPI --> PPG
        PAPI --> PValkey
        PAPI --> PMedia
        PWorker --> PPG
        PWorker --> PValkey
        PWorker --> PMedia
        PWorker -->|TLS/SNI mail hostname| PMail
        PMail -->|signed idempotent feedback| PAPI

        Timers --> PPG
        Timers --> PMedia
        Timers --> PMail
      end
    end

    Cloudflare --> Users
    Users --> HostPolicy
    RemoteMail <-->|SMTP after Prompt 06 mail gate| HostPolicy
    Monitor --> Caddy
    Timers --> BackupTarget
    Reconciler -->|outbound HTTPS only| GitHub
~~~

### Request flow

1. Caddy is the only public HTTP entry point.
2. Requests for the application UI go to the web service.
3. Requests under /api and /socket.io go to Fastify.
4. Better Auth is mounted inside Fastify under /api/auth.
5. Fastify validates input, authenticates the session, authorizes the resource, and performs the business transaction.
6. Durable state and an application-owned outbox row are committed in one PostgreSQL transaction.
7. A worker-side outbox dispatcher reads those rows, creates deterministic pg-boss jobs, and records dispatch idempotently. The API has no access to the pg-boss schema.
8. pg-boss handles retries, schedules, and worker claims using a schema owned and migrated only by the migration role.
9. Valkey holds disposable cache/rate-limit state and the narrow worker-to-API invalidation channel; it later coordinates Socket.IO replicas.
10. The worker submits email to Stalwart and processes media.
11. Socket.IO tells clients that something changed; clients refetch authoritative data from the API.

## 3. Technology stack

The version numbers below are a dated implementation baseline, not permission to auto-upgrade. Recheck patch releases when implementation begins, test them, and pin every production image by patch and OCI digest. Never deploy a moving latest tag.

| Layer | Recommended choice | Starting baseline | Reason |
|---|---|---:|---|
| Operating system | Ubuntu LTS | 26.04 | Broad Docker support, documentation, packages, and a straightforward upgrade path |
| Container runtime | Docker Engine + Compose v2 | supported release with Compose >= 2.33.1 | Required for explicit default-gateway selection with `gw_priority`; best fit for one host |
| JavaScript runtime | Node.js LTS | 24.20.0 LTS | Production LTS; Node 26 is Current, not the LTS default |
| Package workspace | pnpm workspaces | pinned lockfile | One repository without adding Nx or Turborepo initially |
| Frontend | Next.js App Router, standalone SSR | 16.3.3 | One predictable runtime image; launch with ISR and the built-in image optimizer disabled so the read-only container has no hidden persistent cache |
| API | Fastify + TypeScript | Fastify 5.12.1 | Low overhead, schema-based validation, strong plugin model |
| Schema/contracts | TypeBox + JSON Schema | pinned | One schema can validate requests and generate OpenAPI |
| Database access | Drizzle ORM | pinned | Typed SQL with explicit migrations and little runtime weight |
| Database | PostgreSQL | 18.6 baseline | The source of truth for business data, sessions, audit records, and jobs |
| Authentication | Better Auth | 1.7.2 baseline | Lives inside the application, supports PostgreSQL sessions, and avoids a separate identity service |
| Cache | Valkey | 9.1.1 baseline | Redis-protocol compatible, small, and appropriate for disposable cache/rate-limit state |
| Queue and scheduler | application outbox + pg-boss | 12.28.0 / schema 38 | The API writes only its own outbox; the worker owns queue runtime access and a separate migration command owns pg-boss DDL |
| Realtime | Socket.IO | current supported 4.x patch | Runs in Fastify now; Valkey adapter can be added before API replica 2 |
| HTTP edge | Caddy | 2.11.4 baseline | Automatic TLS, HTTP reverse proxy, WebSocket proxy, headers, compression, and logs |
| Mail | Stalwart | 0.16.19 | Low-volume transactional/account mail plus named operational mailboxes only; staging uses a separate sender/credential for allowlisted testers, development uses Mailpit, and Netcup bulk/marketing mail is excluded |
| Media processing | Sharp/libvips | pinned | Streaming image validation, re-encoding, metadata stripping, and variants |
| Object storage | Local filesystem first; SeaweedFS optional | pin tested release | Local storage saves RAM now; SeaweedFS supplies an S3 endpoint later |
| Tests | Vitest, Fastify inject, Playwright | pinned | Unit, integration, and end-to-end coverage |
| CI/CD | GitHub Actions + GHCR + outbound host timers | semantic `vX.Y.Z`, immutable Git SHA, and OCI digest | Version before build, build once away from the VPS, then let the host pull successful candidates over outbound HTTPS |
| Backups | pg_dump + Restic first; PITR later | pinned | Encrypted recovery to a repository outside Netcup without an always-on backup service |

Current upstream references:

- [Docker supports Ubuntu 26.04 and documents the official apt installation](https://docs.docker.com/engine/install/ubuntu/).
- [Docker Compose documents a single-server production workflow](https://docs.docker.com/compose/how-tos/production/).
- [Node.js 24.20.0 release](https://nodejs.org/en/blog/release/v24.20.0) and [release status](https://nodejs.org/en/about/previous-releases).
- [Next.js 16.3.3 security release](https://nextjs.org/blog/august-2026-security-release) and [support policy](https://nextjs.org/support-policy).
- [Fastify 5.12.1 release](https://github.com/fastify/fastify/releases/tag/v5.12.1).
- [Better Auth 1.7.2 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.2).
- [PostgreSQL 18.6 release](https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/).
- [Valkey 9.1.1 release](https://github.com/valkey-io/valkey/releases/tag/9.1.1).
- [Caddy 2.11.4 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4).
- [Stalwart 0.16.19 release](https://github.com/stalwartlabs/stalwart/releases/tag/v0.16.19) and [Docker guidance](https://stalw.art/docs/install/platform/docker/).
- [pg-boss 12.28.0 release](https://github.com/timgit/pg-boss/releases/tag/12.28.0).

### Why Docker Compose, not Kubernetes or Podman

Kubernetes gives the most value when there are several machines, a team operating a cluster, and a need for scheduling, automated rescheduling, service discovery, and multi-node failure handling. On one VPS, k3s still adds a control plane, ingress, storage abstractions, more networking, and more upgrade work while it cannot survive loss of the host.

Podman is a respectable alternative, especially for teams already standardized on rootless Podman and SELinux. It is not a benefit by itself here. Docker Compose has the simpler path, wider examples, and fewer compatibility decisions for this exact stack.

The portable asset is not Kubernetes YAML. It is:

- immutable application images;
- a Compose file committed to the repository;
- explicit networks and persistent data;
- a storage interface rather than provider-specific calls;
- database migrations;
- encrypted backups and a tested restore procedure;
- DNS and secrets inventories.

### Why Caddy, not Kong or APISIX

Caddy is the network gateway. Fastify is the application gateway.

Caddy handles:

- HTTPS certificates and renewal;
- HTTP to HTTPS redirection;
- routing to web, API, realtime, public media, optional storage, and—only in the deferred mailbox profile—a non-administrative mail HTTP listener;
- WebSocket upgrades;
- compression;
- bounded access logs;
- basic request-size and response-header policy.

Fastify handles:

- authentication and authorization;
- request/response validation;
- user and tenant rate limits;
- idempotency keys;
- API versioning;
- OpenAPI;
- business quotas;
- consistent errors and request IDs.

Kong or APISIX becomes useful when there are multiple independently deployed public APIs, several teams need centrally governed policies, or many external API consumers require keys, plans, analytics, and transformations. One modular API does not meet that threshold.

## 4. Repository and application shape

Keep the frontend, backend, workers, database migrations, shared packages, infrastructure, tests, CI/CD, and runbooks in **one monorepo**. The monorepo is the complete reproducible recipe for the system.

One repository does not mean one container. Production still uses separate service containers and trust boundaries. The repository builds two application images:

- a web image;
- one server image reused by API, worker, and migration services.

Caddy, PostgreSQL, Valkey, Stalwart, and optional SeaweedFS continue to use their separately pinned upstream images.

### Recommended monorepo

~~~text
myapp/
├── apps/
│   ├── web/
│   │   ├── app/                         # Next.js routes and layouts
│   │   ├── components/
│   │   ├── lib/                         # Browser-safe clients and utilities
│   │   ├── public/
│   │   ├── next.config.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── server/
│       ├── src/
│       │   ├── entrypoints/
│       │   │   ├── http.ts              # Fastify + Better Auth + Socket.IO
│       │   │   ├── worker.ts            # pg-boss consumers
│       │   │   └── migrate.ts           # One-shot migrations
│       │   ├── app.ts                    # Fastify composition root
│       │   ├── plugins/
│       │   ├── modules/
│       │   │   ├── identity/
│       │   │   ├── users/
│       │   │   ├── media/
│       │   │   ├── notifications/
│       │   │   └── audit/               # Product modules wait for separate requirements
│       │   ├── jobs/
│       │   ├── realtime/
│       │   ├── mail/
│       │   ├── storage/
│       │   └── observability/
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── contracts/                       # Shared HTTP/socket schemas and types
│   ├── database/
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   ├── queries/
│   │   │   └── client.ts
│   │   └── migrations/                  # Committed Drizzle migrations
│   ├── config/                          # Typed public/server environment parsing
│   ├── email/                           # Templates and message contracts
│   ├── storage/                         # Filesystem and S3 adapter interfaces
│   └── testing/                         # Shared fixtures and test helpers
│
├── infra/
│   ├── compose.yaml                     # Shared Caddy and host topology
│   ├── compose.development.yaml         # Local builds, hot reload, dev ports
│   ├── compose.staging.yaml             # Isolated staging domains, state, and safe mail sink
│   ├── compose.production.yaml          # Digests, limits, secrets, production mounts
│   ├── compose.mailbox.yaml             # Deferred public mailbox/JMAP overlay; separate approval
│   ├── compose.s3.yaml                  # Optional SeaweedFS overlay; measured need and approval
│   ├── caddy/
│   │   └── Caddyfile
│   ├── postgres/
│   │   ├── development.conf
│   │   ├── templates/
│   │   │   ├── staging.conf
│   │   │   └── production.conf
│   │   └── roles.template.sql            # Reviewed role/grant shape; no passwords
│   ├── valkey/
│   │   ├── development.conf
│   │   └── templates/
│   │       ├── staging.conf
│   │       └── production.conf
│   ├── stalwart/
│   │   └── bootstrap/                   # Non-secret starter configuration only
│   ├── ansible/
│   │   ├── ansible.cfg
│   │   ├── inventories/
│   │   │   └── netcup/
│   │   │       ├── hosts.example.yml    # Committed schema/example; no real hosts
│   │   │       ├── hosts.yml            # Ignored local reviewed target inventory
│   │   │       └── group_vars/          # Non-secret host variables only
│   │   ├── playbooks/
│   │   │   └── vps.yaml                 # Ubuntu, Docker, paths, firewall, swap, reviewed units
│   │   └── roles/                       # Idempotent host roles; no application data
│   ├── systemd/
│   │   ├── <app-slug>-deployment-reconciler.service
│   │   ├── <app-slug>-deployment-reconciler.timer
│   │   ├── <app-slug>-database-backup.service
│   │   ├── <app-slug>-database-backup.timer
│   │   ├── <app-slug>-state-backup.service
│   │   ├── <app-slug>-state-backup.timer
│   │   ├── <app-slug>-restore-check.service
│   │   ├── <app-slug>-restore-check.timer
│   │   ├── <app-slug>-health-check.service
│   │   ├── <app-slug>-health-check.timer
│   │   ├── <app-slug>-host-prune.service     # Docker image/build-cache/log cleanup only
│   │   ├── <app-slug>-host-prune.timer       # Never Restic forget/prune
│   │   ├── <app-slug>-maintenance.service
│   │   └── <app-slug>-maintenance.timer
│   └── scripts/
│       ├── install-release.sh           # Seals signed manifest + all referenced immutable payloads
│       ├── activate-release.sh          # One journaled transaction; staging/production/mail/edge/rollback
│       ├── host-compose.sh              # Enforces the active host-overlay manifest
│       ├── reconcile-deployment.sh
│       ├── rollback.sh
│       ├── backup.sh
│       ├── restore-test.sh
│       └── smoke-test.sh
│
├── tests/
│   ├── integration/
│   └── e2e/
│
├── docs/
│   ├── requirements.md                  # Generic identity and organization behavior
│   ├── infrastructure.md                # This architecture and operations contract
│   ├── environments.md                  # Environment differences and isolation
│   ├── vps-setup.md                     # Host preparation and approval gates
│   ├── deployment.md                    # Release, promotion, rollback, and recovery
│   ├── versioning.md                    # Conventional commits, releases, build version, future version page
│   ├── decisions.md                     # Locked choices and external input register
│   ├── prompts/                         # Numbered prompts, one at a time
│   └── runbooks/                        # Created by the relevant implementation prompt
│       ├── deployment.md
│       ├── rollback.md
│       ├── backup-restore.md
│       ├── mail-deliverability.md
│       └── incident.md
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yaml
│   │   └── release.yaml                 # Version/tag protected main before CI dispatch
│
├── .dockerignore
├── .env.example                         # Names and safe examples, no secrets
├── .gitignore
├── package.json                         # Root commands
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
~~~

The workspace declaration stays deliberately small:

~~~yaml
packages:
  - "apps/*"
  - "packages/*"
~~~

The root package.json must be private, pin the packageManager field, and provide the documented cross-workspace commands. Commit one pnpm-lock.yaml for the complete repository.

### Package boundaries

| Path | Responsibility | May be imported by |
|---|---|---|
| apps/web | Next.js UI and browser/server rendering | web only |
| apps/server | HTTP API, auth, jobs, realtime, mail orchestration | server image only |
| packages/contracts | Browser-safe TypeBox/JSON schemas and shared API/socket types | web and server |
| packages/database | Drizzle schema, queries, transactions, and migrations | server and migration entrypoint only |
| packages/config | Separate validated public and server configuration | both, without leaking server fields |
| packages/email | Renderable templates and typed email inputs | worker; preview tooling in development |
| packages/storage | Storage interface plus filesystem/S3 implementations | API, worker, and tests |
| packages/testing | Factories, fixtures, and integration helpers | tests only |
| infra | Compose, proxy, datastore, mail bootstrap, and operations | deployment tooling |

Keep contracts browser-safe. They must not import database clients, Node-only modules, or secrets. Database, SMTP, filesystem, and privileged configuration packages must never enter the frontend bundle.

### One server image, three entrypoints

Build apps/server once and run the same immutable image with different commands:

~~~text
http
  node dist/entrypoints/http.js
  Fastify + Better Auth + Socket.IO

worker
  node dist/entrypoints/worker.js
  pg-boss + media processing + SMTP submission

migrate
  node dist/entrypoints/migrate.js
  one-shot schema and grant changes with the migration role
~~~

The API and worker use different database and service credentials even though they share an image. The migration command receives its elevated credential only for the one-shot run. This prevents code drift without collapsing process or permission boundaries.

### Docker build contract for the monorepo

Use the repository root as the Docker build context so each application can consume the root lockfile and approved shared packages:

~~~bash
docker build -f apps/web/Dockerfile -t <app-slug>-web:<git-sha> .
docker build -f apps/server/Dockerfile -t <app-slug>-server:<git-sha> .
~~~

Because the Compose files live under infra, their development build blocks should use context: .. and the appropriate apps/.../Dockerfile path.

Both Dockerfiles should be multi-stage:

1. a pinned Node 24.20.0 LTS base;
2. a dependency stage using the frozen pnpm lockfile;
3. a build/test stage;
4. a minimal non-root runtime stage.

The web runtime contains only the Next.js standalone output and required public assets. Configure Next.js with `output: "standalone"` and `images.unoptimized: true`; do not use route `revalidate`, ISR, or a framework data cache that requires runtime disk writes in this launch profile. Dynamic application data comes from the API and is fetched without a hidden persistent Next.js cache. Every route must render without writing persistent framework state. The server runtime contains compiled server code and production dependencies used by API, worker, and migrate. Neither runtime image should contain Git metadata, production environment files, tests, coverage, local media, backup files, package-manager caches, or unrelated workspace source.

Both application images are environment-neutral. CI supplies no staging/production domain, OAuth client ID, cookie name, mail host, API origin, feature secret, or other environment-specific build argument/`NEXT_PUBLIC_*` value. The sole exception is the public, environment-neutral `NEXT_PUBLIC_APP_VERSION`, derived from the root package and passed before `next build`; the same value labels both OCI images. Browser code uses same-origin relative `/api`, `/socket.io`, and `/media` paths. If the browser later needs any other public environment metadata, Next SSR/API returns it through one typed allowlisted runtime payload with no server-only values; it is not baked into the client bundle. CI scans standalone output, source maps, and browser chunks for staging/production sentinels and proves the exact same web/server image digests operate with separate staging and production runtime configuration.

The production web container is read-only. `/tmp` may be a bounded tmpfs for unavoidable temporary files, but it is not an ISR or image cache. If a future feature requires ISR or on-server image optimization, add a specifically sized writable cache and a cache invalidation/backup decision rather than silently making the whole root filesystem writable.

Keep Docker layer caching safe: lockfile/package manifests may be copied before source for dependency caching, but secrets must never be build arguments or copied into a layer. Production configuration arrives only at container runtime.

### Base, development, staging, production, and deferred Compose overlays

Use Compose layering rather than maintaining unrelated files:

**infra/compose.yaml**

- the one shared `caddy` service and shared host-level conventions; environment networks remain declared in their overlays;
- Caddy has no host port, environment network, or environment media bind in the base file;
- no environment database, cache, media, credentials, or application service;
- no production plaintext secrets.

**infra/compose.development.yaml**

- `development-web`, `development-api`, `development-worker`, `development-postgres`, `development-valkey`, and `development-mailpit` services;
- local build contexts;
- source mounts and hot reload where useful;
- development-only values;
- ports bound to 127.0.0.1;
- an additive Caddy extension using Compose `!override` for loopback-only unprivileged development ports and a disposable development media mount; it references no `/srv/myapp/staging` or `/srv/myapp/production` path;
- disposable PostgreSQL/Valkey state;
- Mailpit as the safe local email sink;
- lower resource limits;
- no production domain, DKIM key, backup credential, or customer data.

**infra/compose.staging.yaml**

- `staging-web`, `staging-api`, `staging-worker`, `staging-migrate`, `staging-postgres`, `staging-valkey`, and `staging-mailpit` services;
- immutable candidate images and staging-only secrets;
- staging-only domains, PostgreSQL volume, Valkey state, networks, credentials, and media roots;
- an additive extension of the base `caddy` service that joins only `staging-edge` and mounts only `/srv/myapp/staging/media/public/variants` at `/srv/staging-public-media` read-only;
- mounts/enables only the staging Caddy site fragment; the Prompt 05 render contains no production hostname, upstream, media mount, or certificate request;
- the first remote public Caddy ports (80/443 and optional 443/udp), declared once with `!override` so array merging cannot duplicate or retain development bindings;
- no production bind mounts, databases, Valkey ACLs, worker SMTP credential, DKIM keys, or backup repository;
- no public SMTP/IMAP ports and no direct internet delivery;
- a staging-only Mailpit instance retained privately for operator capture/debugging;
- a separately scoped staging sender/credential attached to the internal Stalwart submission network for allowlisted account/auth mail;
- smaller test quotas and data that may be destroyed without affecting production.

**infra/compose.production.yaml**

- `production-web`, `production-api`, `production-worker`, `production-migrate`, `production-postgres`, `production-valkey`, and `production-stalwart`, plus an additive extension of the base Caddy service for `production-edge` and the public production variants mount;
- mounts/enables the production Caddy site fragment only in Prompt 06 through the full base+staging+production manifest;
- no Caddy `ports` entry: production is added only while the active staging overlay continues to own the one remote port list;
- immutable registry images and OCI digests;
- production domains and read-only configuration;
- Compose secret mounts sourced from `/etc/myapp/secrets/production`;
- /srv/myapp persistent paths;
- restart, health, stop-grace, memory, CPU, PID, and logging policy;
- no source-code bind mounts;
- no internal datastore host ports.

All overlays require Docker Compose 2.33.1 or later for `gw_priority` and the `!override` merge tag. Set `gw_priority: 1` on each API edge and on `production-mail-egress` for Stalwart; internal networks remain priority 0. Render tests prove base+development publishes only loopback ports and references no remote `/srv/myapp` paths, base+staging publishes the remote Caddy ports once, and base+staging+production preserves that single list while adding only production's edge/mount. See Docker's [`gw_priority` contract](https://docs.docker.com/reference/compose-file/services/#gw_priority) and [Compose merge tags](https://docs.docker.com/reference/compose-file/merge/).

**infra/compose.s3.yaml**

- optional SeaweedFS service and S3-specific mounts, networks, and secrets;
- composed only after measured product need, a reviewed resource budget, and explicit approval;
- never enabled by default in development, staging, or production.

**infra/compose.mailbox.yaml**

- deferred production-only mailbox ports and optional public JMAP/account listener;
- never exposes the Stalwart administrator listener or management API through Caddy;
- excluded from this Netcup blueprint unless a later provider-policy, security, capacity, and product decision explicitly authorizes it; general end-user mailbox hosting is not part of launch.

Use explicit environment-prefixed service keys. Production names are `production-web`, `production-api`, `production-worker`, `production-migrate`, `production-postgres`, `production-valkey`, and `production-stalwart`. Staging uses the same suffixes with `staging-` and uses `staging-mailpit`; development uses `development-`. The only unprefixed host service is shared `caddy`. Add `seaweedfs` only through the S3 overlay. Do not set `container_name`, because it prevents normal Compose service scaling and safe replacement.

Use two explicit project names:

~~~text
<app-slug>-development
<app-slug>-host
~~~

Development is a separate disposable project. On the VPS, staging and production share one host project only so they can share one `caddy` service. Isolation comes from explicit service keys, different networks, named volumes, bind paths, credentials, cookie names, OAuth applications, and mail paths. CI must reject an environment that references the other environment's state or credentials.

Every immutable VPS host release combines three artifact classes:

- one immutable **shared-infrastructure payload** containing the reviewed Compose, Caddy, and non-secret host configuration from Prompt 04;
- one immutable, environment-neutral **application payload per active environment**, containing the source/image/migration/provenance/evidence metadata built for that candidate; and
- one separately signed **activation manifest** (`release.yaml`) describing the complete intended host state and referencing every payload by digest.

The activation manifest records the ordered `active_compose_files`, `change_targets`, one shared-infrastructure-payload digest, and a separate application-payload digest inside each active environment block. Its own digest/signature live in the external GitHub Deployment/root-approval/sealed-release envelope, never inside the self-hashed YAML. Prompt 05 activates base+staging with `production: null`. Prompt 06 creates a new base+staging+production manifest, preserves the staging block, copies the currently active staging application payload into the production block, and keeps shared infrastructure unchanged. Later automatic staging releases may change only the staging application block while preserving production. Shared Caddy/Compose changes name `shared-infrastructure`, record old/new digests, and require an explicit host-wide gate.

`active_compose_files` identifies source templates inside the shared-infrastructure payload, not runnable files. Those templates use a small allowlisted token grammar for exact environment image references and approved non-secret settings. The root-owned Prompt 04 renderer independently verifies each application-payload inventory against its activation-manifest block, substitutes values only into same-environment service keys, emits sealed files beneath `rendered/`, and verifies their canonical combined SHA-256 against `rendered_compose_digest`. It rejects unresolved/extra tokens, mutable references, cross-environment mappings, unsafe YAML/Compose features, caller env files, and path traversal. Secret values are never rendering inputs; templates contain only fixed root-owned secret-file paths.

Prompt 04 creates root-owned trusted programs. `/usr/local/sbin/<app-slug>-install-release` accepts only an approved signed activation manifest, resolves its referenced shared/application payloads from fixed digest-addressed inbox paths, verifies all digests against a root-only record, rejects unsafe archives/Compose, and seals a non-writable release. The outbound reconciler code is root-owned but runs as a dedicated unprivileged user. A separate minimal root policy controller may derive a staging-only approval record when an immutable root-owned automatic-staging policy independently validates the signed Deployment request; it cannot modify that policy or derive production/out-of-policy records. Initial staging and all production records remain manual approval gates.

`/usr/local/sbin/<app-slug>-host-compose` accepts only a sealed release ID. On every invocation it resolves paths without following symlinks; verifies every ancestor, seal, referenced payload, activation manifest, `rendered_compose_digest`, and recorded hash; maps the logical template list to the exact sealed `rendered/` Compose files; fixes the project and local Docker socket/context; and clears caller-controlled Docker/Compose variables. It permits only reviewed subcommands/services and rejects path/mode/hash drift, placeholders, unknown overlays, caller env files, `down`, routine `--remove-orphans`, privileged/host namespace/device/Docker-socket access, unapproved binds, or partial shared-Caddy updates. Treat every payload and the activation manifest as root-equivalent input; a path/service allowlist alone is not a trust boundary.

A root-owned-code, unprivileged systemd reconciler polls GitHub Deployments/GHCR over outbound HTTPS. It accepts only expected signed requests/digests, rejects replay/unsafe transitions, downloads with read-only package access, calls fixed policy/installer/wrapper entrypoints, performs host-local smoke checks, and reports status using a GitHub App credential that cannot write repository contents. GitHub-hosted runners never receive inbound SSH or Docker access.

Every host-state mutation is serialized by the root-owned kernel lock `/run/lock/<app-slug>/host-operation.lock`. Release install/activation/rollback, migrations, public-edge switching, restore, Docker daemon/network maintenance, and destructive pruning must acquire it with a bounded timeout, then re-read the active predecessor and approval record while holding it. Backup/restore tooling also uses `/run/lock/<app-slug>/backup.lock`; when both locks are needed the only valid order is `host-operation` then `backup`, never the reverse. A consistent backup capture holds the global lock only for the minimum database/Stalwart snapshot window, then releases it before offsite transfer. The reconciler defers rather than bypassing a busy lock. Use `flock` file descriptors so process death releases ownership; the lock file is root-owned metadata, not proof that a lock is held. Tests cover contention, timeout, killed-process recovery, lock ordering, and predecessor revalidation.

Ansible installs a root-owned tmpfiles.d rule that recreates `/run/lock/<app-slug>` as mode `0700` on every boot. Mutating units order after `systemd-tmpfiles-setup.service` and wrappers reject missing, symlinked, wrong-owner, or wrong-mode lock paths. Reboot tests prove the ephemeral directory is recreated before reconciler/timers can request a mutation; the durable recovery-inhibit state remains in `/var/lib/<app-slug>/operations`.

Because an advisory lock cannot describe a half-finished operation, every mutating root wrapper atomically writes/fsyncs a persistent journal and recovery-inhibit marker under `/var/lib/<app-slug>/operations/` before the first mutation, then records each phase. Only a verified commit or verified rollback archives it and clears the marker. A new wrapper invocation acquires the lock, checks the marker, and refuses to continue or reconcile automatically when an interrupted operation remains. Test SIGKILL/power loss at every phase.

`/usr/local/sbin/<app-slug>-activate-release <release-id> --target <staging|production|production-mail|public-edge|rollback>` is the only release-mutation entrypoint. It holds the global lock across active predecessor/epoch re-read, pulls, state startup, one-shot migration or approved mail transition, app/Caddy transition, health/isolation checks, atomic active-pointer/status commit, off-VPS replay-checkpoint update, and verified rollback on failure. `production-mail` starts/enables only the already sealed Stalwart host state after the separate provider/DNS/firewall approvals; it cannot perform provider-console or DNS mutations. The Compose wrapper's direct interface is read-only (`verify`, `config`, `ps`) unless called internally by this locked transaction.

Run local development from the repository root:

~~~bash
docker compose \
  --project-name <app-slug>-development \
  -f infra/compose.yaml \
  -f infra/compose.development.yaml \
  up --build
~~~

Validate the staging host templates without executing repository source files:

~~~bash
corepack pnpm infra:validate-templates
corepack pnpm infra:test-render -- --fixture staging
~~~

Validate the full later production composition locally during Prompt 04:

~~~bash
corepack pnpm infra:test-render -- --fixture production-restricted
corepack pnpm infra:test-render -- --fixture production-public
~~~

The render-fixture harness independently validates the activation-manifest schema, renders into a disposable sealed-fixture directory, verifies the expected canonical `rendered_compose_digest`, clears caller Docker/Compose variables, and runs `docker compose config --quiet` only against those rendered outputs. Never run a host source template directly or use repository-local Compose commands to start/update the VPS. Host operations use the immutable release manifest and root-owned wrapper described above.

Root package scripts can wrap these commands so normal development uses short, documented commands such as pnpm dev, pnpm test, pnpm infra:up, pnpm infra:down, pnpm db:migrate, and pnpm test:e2e. The scripts must still expose the underlying Compose command in the README and logs.

### What belongs in Git

- frontend, backend, worker, and migration source;
- Dockerfiles and .dockerignore;
- Compose files;
- Caddyfile;
- PostgreSQL and Valkey non-secret configuration;
- the non-secret PostgreSQL role/grant template; passwords remain external;
- Drizzle migrations;
- Stalwart non-secret bootstrap examples;
- Ansible roles/playbooks with inventory examples containing no hosts or credentials;
- systemd unit templates for backup and maintenance timers;
- shared contracts, templates, and adapters;
- CI/CD workflows;
- deployment, backup, restore, and smoke-test scripts;
- tests and fixtures containing no production data;
- architecture, operations, and incident runbooks;
- .env.example with variable names and clearly fake values.

### What must remain outside Git

- production .env files and all real credentials;
- Better Auth secrets and rotation keys;
- PostgreSQL, Valkey, SMTP, S3, backup, and deployment credentials;
- DKIM private keys;
- live PostgreSQL data;
- Stalwart configuration containing secrets, mailboxes, queues, and mail data;
- uploaded media;
- Caddy certificate state;
- backup archives and database dumps;
- production logs;
- generated local build output.

Runtime state remains in environment-specific locations defined by this document:

~~~text
/etc/myapp/deployment-policies/        root-owned staging automation policy
/etc/myapp/approved-releases/          root-only exact release approvals
/etc/myapp/secrets/                    root-protected runtime secret files
/var/lib/<app-slug>/operations/        root:root 0700 persistent operation journal/inhibit state
/srv/myapp/operation-recovery/         bounded archived operation evidence only
/srv/myapp/production/media/           production public/private media
/srv/myapp/production/stalwart/        live production mail configuration and data
/srv/myapp/production/backup-staging/  bounded temporary production backup workspace
/srv/myapp/staging/                    isolated staging state, created during Prompt 05
Docker named volumes       PostgreSQL and Caddy-managed state
~~~

Development state remains under Docker-managed development volumes or an ignored repository-local development path. Staging and production must never share an application bind directory, named volume/key, secret file, domain, cookie, OAuth client, backup repository path, or mail identity. They intentionally share the physical host, Docker daemon/host Compose project, root-owned release control plane/reconciler, and Caddy; these host-level components never receive environment application credentials.

The repository tells a new VPS how to reconstruct the services. Encrypted off-host backups restore the state that Git intentionally does not contain.

### Minimum ignore policy

The real .gitignore and .dockerignore should cover at least:

~~~gitignore
node_modules/
.next/
dist/
coverage/
playwright-report/
test-results/

.env
.env.*
!.env.example

data/
media/
backups/
environments/
*.dump
*.sql.gz

infra/stalwart/data/
infra/stalwart/config/
infra/caddy/data/
infra/caddy/config/
infra/ansible/inventories/**/hosts.yml
~~~

Commit `hosts.example.yml`, never a real target address. Prompt 05 copies it to the ignored local `hosts.yml` (or uses an explicitly approved external inventory path), validates the one exact Netcup host and `--limit`, and refuses to run if the real inventory is tracked by Git.

Do not ignore packages/database/migrations. Database migrations are source code and must be reviewed and committed.

### Developer onboarding contract

README.md should provide a new contributor with one deterministic path:

1. install the pinned Node LTS and enable Corepack/pnpm;
2. copy .env.example to a local ignored environment file;
3. start the development Compose stack;
4. run migrations and development seeds;
5. start or rebuild web/API/worker;
6. run unit, integration, and end-to-end tests;
7. stop the stack without deleting data by default;
8. explicitly reset disposable development data when desired.

Include the expected local URLs, ports, seeded test identities, magic-link/mail-sink workflow, mocked social-provider flow, media fixture limits, and the command that completely resets development state. The reset command must be clearly labeled destructive and must never target `/srv/myapp` or production.

### Modular-monolith rule

Each backend module owns its routes, schemas, service logic, database queries, authorization rules, jobs, and realtime event names. Modules communicate through typed application interfaces or durable outbox events, not HTTP calls to one another.

Do not create separate repositories or services merely because modules have different names. Split a service later only when it needs independent scaling, deployment, security ownership, or reliability—not simply because the codebase grew.

## 5. Container topology and isolation

| Service | Public host ports | Networks | Persistent state | Suggested 8 GB cap |
|---|---|---|---|---:|
| shared caddy | 80/tcp, 443/tcp, optional 443/udp | both environment edge networks only | certificate/config state | 96 MB |
| staging web | none | staging-edge | none | 256 MB |
| staging API | none | staging edge/data/storage | none | 256 MB |
| staging worker | none | staging data/storage/mail-sink; no public gateway | none | 192 MB |
| staging PostgreSQL | none | staging-data | staging PostgreSQL volume | 384 MB |
| staging Valkey | none | staging-data | disposable staging state | 128 MB |
| staging Mailpit | none publicly | staging-mail | disposable messages | 128 MB |
| production web | none | production-edge | none | 384 MB |
| production API | none | production edge/data/storage/mail-events | none | 384 MB |
| production worker | none | production data/storage/mail-submit; no public gateway | none | 256 MB |
| production PostgreSQL | none | production-data | production PostgreSQL volume | 768 MB |
| production Valkey | none | production-data | disposable cache state | 256 MB |
| production Stalwart | SMTP only after Prompt 06 mail gate | production mail networks | config and operational mail data | 512 MB |
| SeaweedFS | none unless separately approved | deferred isolated storage networks | object data | disabled |

These limits total roughly 3.9 GB and are starting caps, not universal truth. PostgreSQL and Valkey internal settings must fit their container caps. Preserve the remaining memory for Ubuntu, Docker, page cache, migrations, backup/restore, media bursts, and safety headroom. Stalwart is limited by Netcup policy and this design to low-volume transactional/account traffic and named operational mailboxes, never bulk/marketing delivery. See [Stalwart system requirements](https://stalw.art/docs/install/requirements/).

### Networks

- **environment edge:** production uses `production-edge`; staging uses `staging-edge`. Each contains Caddy plus only that environment's web and API. Caddy is the sole container joining both; production and staging application containers never share an edge network. Only Caddy publishes HTTP ports.
- **data:** API, worker, PostgreSQL, and Valkey. PostgreSQL and Valkey never publish host ports.
- **storage:** API, worker, and the optional object store. With local storage, it is primarily a conceptual trust boundary plus explicit volume mounts.
- **mail-submit:** worker and Stalwart. Only the worker receives SMTP credentials; the Stalwart alias matches `<MAIL_HOSTNAME>` for TLS/SNI.
- **mail-events:** Stalwart and API for signed delivery feedback; never Caddy.
- **mail-admin:** Stalwart plus explicitly invoked administration tooling; never Caddy and never public.
- **mail-egress:** Stalwart-only outbound internet access for SMTP, DNS, ACME, and reviewed updates.
- **worker-egress:** absent at launch. Add a narrowly controlled worker-only egress network only when a separately approved integration requires direct outbound access.
- **mailbox-public/storage-edge:** absent at launch; optional overlays expose only their intended data listeners to Caddy.

Caddy must not join data, storage-internal, mail-events, mail-admin, or mail-submit networks and must never mount the Docker socket. The web container must never receive database, Valkey, SMTP, object-admin, backup, or migration credentials. The worker has no public listener. A service attached to multiple networks **and requiring internet egress** must declare its intended non-internal default gateway with `gw_priority`; verify the resulting route from the running container rather than relying on network-name or attachment order. Production and staging workers are deliberately attached only to their own internal data/storage/mail-submit networks, have no non-internal gateway, and must fail direct external DNS/HTTP/SMTP reachability; each submits only to Stalwart with its own credential.

### Persistent paths

Use explicit, environment-specific host paths for things that need operational visibility and named volumes where image-managed ownership is safer:

~~~text
/srv/myapp/
  release-inbox/                       # deploy-owned upload area; never executed directly
  releases/
  production/
    media/
      public/
        variants/                    # content-hashed files; Caddy read-only
      private/
        incoming/
        originals/
        variants/
        trash/
    backup-staging/
    stalwart/
      config/
      data/
  staging/                           # created during initial approved host preparation
    media/
      public/
      private/
    mail-sink/                       # Mailpit only; never an internet relay

/etc/myapp/
  deployment-policies/
    staging.yaml                     # installed only after its explicit policy gate
  approved-releases/
  secrets/
    production/
    staging/
~~~

Use one disposable development Compose project and one VPS host project. Within the host project, PostgreSQL, Valkey, application services, state volumes, credentials, and networks are explicitly prefixed `production-` or `staging-`. The physical host, Docker daemon, root-owned release tooling/reconciler, and Caddy are shared control-plane components; only Caddy joins both edge networks and it receives no application credentials. The production file must contain only production paths; the staging overlay must contain only staging paths except for its additive reviewed Caddy extension. CI fails if staging references `/srv/myapp/production` or `/etc/myapp/secrets/production`.

For PostgreSQL 18, the official image changed its default data layout. If using a named volume, mount it at /var/lib/postgresql, not the old PostgreSQL 17 path. The [official PostgreSQL image documentation](https://hub.docker.com/_/postgres) explains the version-specific PGDATA change.

Stalwart bind mounts must be writable by UID 2000. Its persistent paths are /etc/stalwart and /var/lib/stalwart. Do not mount either path into the application containers.

## 6. Storage boundary and future media design

The current generic core implements only the filesystem/S3 adapter interface, separate environment roots, permissions, and public/private delivery boundary. The schema, upload flow, transformations, deletion lifecycle, and S3 service below are a conditional future design: do not implement them until product media types, quotas, retention, and user flows are separately approved.

### Do not put ordinary media in PostgreSQL

PostgreSQL can store binary data with bytea and its Large Object facility. That does not make it the right default for images, video, PDFs, or user uploads.

Keeping normal media bytes in PostgreSQL causes:

- much larger database dumps, WAL streams, and restore times;
- media traffic to compete with transactional queries for memory and disk I/O;
- more database bloat and maintenance;
- awkward streaming and range requests;
- a more complicated lifecycle for large objects;
- loss of the clean migration path to a CDN or object-storage provider.

PostgreSQL should store the ownership, metadata, status, checksum, and storage key. See the official [Large Object introduction](https://www.postgresql.org/docs/current/lo-intro.html) and [PostgreSQL data type limits](https://www.postgresql.org/docs/current/datatype.html).

Small binary values that must be committed atomically with a row can be reasonable. Normal product media is not that case.

### Launch storage: local filesystem

Use `/srv/myapp/production/media` and `/srv/myapp/staging/media` as the durable environment roots. Public and private delivery are physical storage boundaries, not only a database flag:

~~~text
public/variants/          dedicated publisher write; API/worker/Caddy read-only
private/incoming/         API write; worker read/write; never served
private/originals/        worker write; API read; never mounted into Caddy
private/variants/         worker write; API read; never mounted into Caddy
private/trash/            worker read/write; never mounted into API, web, or Caddy
~~~

The API gets write access only to `private/incoming` and read-only access to the public/private delivery trees. The worker receives narrow read/write mounts only for private processing subtrees and a read-only public mount; it cannot write the tree Caddy serves. In the initial core `public/variants` is empty/root-owned because no product upload flow is authorized.

Before a public-media feature launches, add a dedicated no-network publisher identity/service. It accepts only a prepared private-spool file, opens source/destination with no-follow/beneath semantics, requires a regular file, verifies size/type/dimensions and SHA-256 against the canonical destination key, creates only root/publisher-owned non-writable regular files, fsyncs, and atomically publishes without overwrite. It rejects symlinks, hard links with unexpected link count, devices/FIFOs/sockets, traversal, and wrong hash/shard. Caddy receives a read-only mount of that publisher-owned tree. A regex alone is not considered symlink protection; deployment scans and response-body tests prove every served entry is an approved regular file contained under the mount.

The application must use a storage adapter with operations equivalent to:

~~~text
put(scope, stream, key, metadata)
openReadStream(scope, key, range)
head(scope, key)
delete(scope, key)
promote(sourceScope, sourceKey, destinationScope, destinationKey)
createTemporaryDownload(scope, key, expiresAt)
~~~

The first approved media implementation would write to the filesystem. Private-to-private `promote` is an atomic rename only when the adapter verifies both paths are on the same filesystem. A public destination must go through the dedicated publisher boundary above; the worker never renames directly into Caddy's tree. An S3 adapter implements promotion as copy, verify, then delete and must not claim atomic rename semantics. A later S3 implementation uses the AWS SDK with a configurable endpoint. Business modules never construct disk paths or S3 URLs directly.

Use application-generated content-hash-sharded public variant keys such as:

~~~text
ab/cd/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789-v1-1280x720.webp
ef/01/ef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab-v1-320x180.webp
~~~

The two shard components equal the first four hexadecimal characters of that file's full SHA-256; the 64-hex basename equals the SHA-256 of the exact variant bytes. Verify content against the key before atomic promotion, never overwrite a published key, and create a new key when bytes change. Private incoming/original keys may use internal opaque IDs because Caddy never mounts them. Never use a user-supplied filename as any storage key.

### Conditional future metadata model

~~~text
media_objects
  id
  owner_id
  visibility              public | private
  original_scope          private
  original_filename
  storage_key
  detected_mime
  byte_size
  sha256
  width
  height
  duration_ms
  status                  pending | processing | ready | failed | deleted
  created_at
  ready_at
  deleted_at
  retention_until

media_variants
  id
  media_id
  kind                    thumbnail | display | original
  delivery_scope          public | private
  storage_key
  mime
  byte_size
  width
  height
  sha256
~~~

Business records reference media_objects through explicit foreign keys or join tables. PostgreSQL is authoritative for ownership and lifecycle; a filesystem directory listing is not. Database and application constraints must reject a public path for a private variant. Originals remain private even when a processed display variant is public.

### Conditional future secure upload flow

1. The authenticated client requests an upload intent.
2. The API checks ownership, user quota, declared type, maximum size, and product policy.
3. The API creates a pending media row with a random identifier.
4. The body is streamed to incoming as a partial file. Do not buffer a complete upload in Node memory.
5. While streaming, enforce a byte limit and timeout and calculate SHA-256.
6. Validate the detected magic bytes as well as the claimed type. Do not trust the filename or Content-Type header.
7. Commit a processing job only after the media row is durable.
8. A worker with concurrency 1 decodes and re-encodes images, applies pixel/decompression limits, auto-orients them, strips EXIF/GPS, and creates only the variants the UI needs.
9. Write results to temporary paths, then atomically rename them into the correct public or private tree on the same filesystem.
10. Mark the row ready and publish a realtime invalidation event.
11. A reconciliation job removes abandoned partial uploads and repairs missing-row/orphan-file cases.

Follow the [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html): allowlist types, validate signatures, generate names, limit size, require authorization, keep files outside the webroot, and use least privilege.

Do not add ClamAV to the launch profile by default. If arbitrary Office documents, archives, or PDFs become a core feature, keep them quarantined and approve a measured scanning/capacity design before enabling an asynchronous scanner. Image-only products can begin with strict type allowlisting and decode/re-encode processing.

### Conditional future public and private delivery

- Public variants use `/media/<hash-sharded-key>` URLs and long immutable cache headers. Caddy maps only that URL prefix to the read-only public variants mount.
- Private originals and private variants require application authorization on every download.
- In filesystem mode, the API streams private files with range support.
- Serve untrusted documents as attachments and set X-Content-Type-Options: nosniff.
- Disable directory listing.
- Restrict CORS to the application origin.
- Never expose incoming or trash paths.

Changing an item from private to public creates a new public variant key. Changing public to private creates a new private key and removes the public object, but a previously public immutable response may remain in browser or intermediary caches until its declared lifetime ends. Product policy must therefore treat publication as potentially irreversible for that cache lifetime and must never reuse a public key for private data.

### Optional S3 mode after measured need and approval

If direct browser uploads, multipart upload, presigned URLs, or an S3 API becomes important, add a single-node SeaweedFS container. Its documented weed mini mode exposes an S3 endpoint on port 8333 and is designed for single-node use: [SeaweedFS quick start](https://github.com/seaweedfs/seaweedfs#quick-start).

Use environment-qualified logical buckets:

- `<app-slug>-production-public`
- `<app-slug>-production-private`
- `<app-slug>-production-quarantine`

Staging uses different bucket names and credentials and can never access the production buckets. Give each application identity bucket-scoped keys, keep the admin interface private, and expose only the S3 data endpoint through Caddy. Use short-lived presigned URLs; AWS documents the security model and time-limited access of [presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

Do not interpret a bucket on the same NVMe disk as redundancy. It provides an API and lifecycle model, not durability against host loss.

MinIO is not the default recommendation for a new deployment because its community repository was archived in April 2026 and describes itself as no longer maintained: [archived MinIO repository](https://github.com/minio/minio). If choosing any S3-compatible server, validate the exact features the application uses with integration tests.

### Deletion and reconciliation

1. Mark a media row deleted and remove user-visible references in a transaction.
2. Enqueue an idempotent purge job after a 7–30 day grace period.
3. Delete the original and every variant, then record the purge result.
4. Remove abandoned partial uploads after 24 hours.
5. Run a scheduled reconciliation between database keys and stored objects.

Variants can be regenerated. Originals plus PostgreSQL metadata receive the strongest backup policy.

## 7. PostgreSQL design

PostgreSQL is the only durable application source of truth. It contains:

- business data;
- Better Auth users, sessions, accounts, verification tokens, and authenticators;
- media metadata;
- audit events;
- application outbox rows for every durable asynchronous side effect;
- pg-boss job state;
- application configuration that must be transactional.

It does not contain the normal media bytes, cache entries, mail queues, or logs.

### Separate database roles

Create at least these roles:

| Role | Used by | Permissions |
|---|---|---|
| postgres bootstrap role | manual break-glass only | superuser; never used by the app |
| app_owner | one-shot migration command | owns the application and pg-boss schemas; can run reviewed DDL |
| app_api | API container | required table-specific application DML, including outbox/audit inserts; tenant-scoped audit SELECT where authorized; no audit UPDATE/DELETE and no pg-boss schema access |
| app_worker | worker container | required table-specific application/outbox DML plus explicitly granted pg-boss runtime operations; audit INSERT only where required, no audit UPDATE/DELETE, schema ownership, or DDL |
| backup_reader | backup task | only the permissions required by the chosen backup method |

The runtime roles must not own either schema, create extensions, create roles, or run migrations. Migration credentials are mounted only into the one-shot migrate service. Revoke default `PUBLIC` schema creation where appropriate, set explicit default privileges for future migration-created objects, and grant audit tables explicitly rather than through generic schema-wide DML. Use ownership/trigger rules where necessary to make audit rows append-only even if a future grant drifts. Test that API/worker cannot update/delete audit history while authorized tenant reads, required inserts, and migration-owner maintenance still work.

The API never calls pg-boss. In the same transaction as a domain mutation, it inserts a row into an application-owned `outbox_events` table with a unique event ID, event type, aggregate ID/version, bounded payload, creation time, and dispatch state. The worker-side dispatcher claims undispatched rows with bounded batches, creates a pg-boss job using the outbox event ID as its deterministic singleton/idempotency key, and marks the row dispatched. A crash between those operations may produce a duplicate attempt, so both dispatch and every handler remain idempotent.

The migration entrypoint installs or upgrades the pinned pg-boss schema with `app_owner`. Every runtime pg-boss instance is created with schema creation and migration disabled (`createSchema: false`, `migrate: false`) and must fail readiness if the installed schema version differs from the pinned package. The exact runtime grants are generated and integration-tested against that pinned pg-boss release; never solve an upgrade failure by granting the worker `CREATE` or schema ownership.

Use SCRAM-SHA-256 password authentication and limit pg_hba.conf to the Compose data network. PostgreSQL must not publish port 5432 to the VPS.

### Conservative launch configuration

Use environment-specific rendered PostgreSQL files; do not mount one production-sized file into staging. Conservative starting values are:

| Setting | Staging (384 MB cgroup) | Production (768 MB cgroup) |
|---|---:|---:|
| `max_connections` | 20 | 40 |
| `shared_buffers` | 64 MB | 128 MB |
| `effective_cache_size` | 192 MB | 512 MB |
| `work_mem` | 2 MB | 2 MB |
| `maintenance_work_mem` | 32 MB | 64 MB |

These are launch values, not guarantees. CI and Prompt 05/06 runtime probes must model the full approved API/worker/pg-boss/migration/backup/admin connection budget and worst approved per-query/maintenance allocations under each cgroup cap, then lower pools/settings if headroom is insufficient.

Enable pg_stat_statements, normal autovacuum, slow-query logging at a useful threshold, checksums if selected during initialization, and UTC timestamps. Be conservative with work_mem because it can be allocated multiple times per query and session; see [PostgreSQL resource consumption settings](https://www.postgresql.org/docs/current/runtime-config-resource.html).

Start with a complete connection budget, including library-owned pools:

- API application pool: maximum 5 connections;
- worker application/outbox pool: maximum 2 connections;
- pg-boss worker/supervisor pool: maximum 3 connections, configured explicitly rather than accepting a library default;
- migration: 1 connection;
- backup and monitoring: at most 2 concurrent connections;
- administrative and failure reserve: the rest.

Do not add PgBouncer at launch. Add it only when measured connection churn, waits, or additional API replicas approach the database connection budget. Migrations and any LISTEN/NOTIFY connection must remain on a session-safe direct connection.

### Migrations

- Migrations run once as a deployment step, never automatically in every API process.
- The migration step covers Drizzle/application schema, Better Auth tables, required extensions, default grants, and the pinned pg-boss schema before runtime containers are updated.
- CI must test migrations against an empty database and the previous production schema.
- Use expand–migrate–contract changes so the previous and next application images can overlap.
- Make backups before destructive schema changes.
- Rolling back application code does not automatically reverse a database migration.
- Keep seed data separate from schema migrations and never run development seeds in production.

## 8. Backend, API, and authentication

### Fastify API responsibilities

Every public route should have:

- a request and response schema;
- an explicit authentication decision;
- a server-side authorization check against the requested resource;
- input and output size limits;
- a stable error shape;
- a request ID;
- rate-limit policy;
- idempotency protection where a retry could duplicate a payment, email, upload, or state transition;
- an audit event for security-sensitive changes.

Protect or disable production OpenAPI documentation. Do not expose internal administration routes merely because the UI hides them.

Run the API and web application on the same public origin:

~~~text
https://<PRODUCTION_APP_DOMAIN>/             -> web
https://<PRODUCTION_APP_DOMAIN>/api/*        -> Fastify
https://<PRODUCTION_APP_DOMAIN>/api/auth/*   -> Better Auth inside Fastify
https://<PRODUCTION_APP_DOMAIN>/socket.io/*  -> Socket.IO inside Fastify
~~~

Same-origin routing keeps secure cookies simple and removes most CORS complexity.

### Better Auth

Use Better Auth inside the Fastify server with the official PostgreSQL adapter, [Fastify integration](https://better-auth.com/docs/integrations/fastify), [magic-link plugin](https://better-auth.com/docs/plugins/magic-link), and [organization plugin](https://better-auth.com/docs/plugins/organization). Follow the [Better Auth security guidance](https://better-auth.com/docs/reference/security).

Recommended policy:

- PostgreSQL-backed sessions, not browser localStorage bearer tokens;
- Secure, HttpOnly, host-only session cookies;
- SameSite=Lax unless the product has a tested reason for another value;
- one exact production base URL and exact trusted origins;
- built-in CSRF/origin protections left enabled;
- auth route rate limits backed by Valkey;
- passwordless email magic-link sign-in delivered through the outbox, worker, and Stalwart; the public request response is identical whether or not the account exists;
- Google OAuth/OIDC with an exact callback URL and server-only provider secret;
- email/password sign-up, password sign-in, password storage, and password-reset routes disabled;
- account linking only after Better Auth verifies the provider identity and verified email according to an explicit anti-takeover policy;
- application membership roles limited to `owner`, `editor`, and `member`, checked server-side against the requested workspace/resource;
- no generic application `admin` role; infrastructure/mail operators are separate operational identities, not product users;
- recent-authentication checks for sensitive owner actions, using a new magic link or provider reauthentication when required;
- session revocation on email, linked-provider, ownership, or critical membership changes;
- stable secret rotation with a documented overlap process.

Magic-link tokens are high entropy, single-use, stored only as a cryptographic hash, bound to the normalized email and intended callback/purpose, and expire after 10 minutes. Token creation, supersession, and consumption must be atomic enough to reject concurrent reuse; raw tokens are never logged. OAuth state/PKCE/nonce protections remain enabled. Production and staging have different provider applications and redirect URLs; localhost callbacks never appear in a production provider allowlist.

Async action-link delivery uses an application-owned issuance-intent state machine rather than putting a bearer token in the outbox:

1. The API transaction inserts a random issuance-intent ID/version, normalized recipient or recipient reference, purpose, approved callback identifier, request time, supersession state, and an outbox row containing only that intent ID.
2. The worker loads the current intent and derives a 256-bit raw token in memory with HMAC-SHA-256 from a dedicated environment-specific, purpose-separated, versioned derivation key and the canonical intent ID/purpose/email tuple. The key is worker-only and separate from Better Auth/session secrets.
3. In one database transaction, the worker locks the intent, confirms it is still latest/current and inside its dispatch window, stores only `SHA-256(raw_token)` plus issued/purpose-specific-expiry/key-version metadata, and records the stable mail event/Message-ID. Magic links expire after ten minutes; invitation acceptance expires after seven days and still requires the matching authenticated verified email. It then renders the complete URL and email only in process memory.
4. A crash before commit retries normally. A crash after commit or SMTP acceptance rederives the same token and reuses the stable message/event ID; duplicate emails contain the same single-use link. Before each retry, consumed, expired, or superseded intents are skipped.
5. A newer request transaction supersedes earlier pending/issued intents. Delivery reordering can expose an older email, but that link is already invalid.

Keep old derivation-key versions only through the maximum purpose-specific issue/expiry/retry overlap and retain them in the encrypted recovery inventory; retire them only after no usable intent can reference them. Invitation notification links use the same versioned intent mechanism, but acceptance still requires an authenticated verified account with the matching normalized email and role authorization. Outbox rows, pg-boss payloads, application database columns, logs, audit events, traces, and application-backup fixtures must contain no plaintext token, complete action URL, email body, or derivation key. SMTP delivery necessarily gives Stalwart and the recipient a rendered message copy; protect Stalwart data and encrypted backups with strict host permissions, bound queue/message retention, never journal message bodies, and rely on the purpose-specific single-use/supersession controls. If the pinned Better Auth interfaces cannot support the application-side issuance model without weakening its verification semantics, Prompt 03 stops for a documented integration decision rather than persisting raw plugin tokens.

The Google local callback is an optional development convenience. Staging and production use separate Google clients with exact HTTPS callbacks; providers outside the active Google-only scope remain disabled and unconfigured.

Never put database credentials, mail credentials, server secrets, or privileged API keys into NEXT_PUBLIC variables.

Fastify proxy trust accepts forwarded client information only when the immediate peer equals that environment's fixed Caddy IP. Each edge network has a collision-checked manifest subnet and Caddy address rendered into Compose; Caddy uses the fixed address on recreation. Do not trust the whole edge subnet (the web container also joins it), configure `trustProxy: true`, or use forwarded headers as authorization facts. Tests send forged forwarding headers from web/other containers and prove they are ignored. See the [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/).

### Authorization model

Authentication answers “who is this?” Authorization answers “may this user perform this action on this specific resource?”

The product-level membership model is `owner`, `editor`, and `member`. It is separate from PostgreSQL roles, Unix users, and Stalwart operators. For every resource query:

- select or mutate by resource ID and authorized owner/tenant scope together;
- do not load by ID and rely on a later UI check;
- define the three membership roles centrally but keep object-level checks in the relevant module;
- audit membership, permission, linked-provider, email, and ownership changes;
- deny by default.

Use the exact capability matrix in `docs/requirements.md`: a verified user may create and own multiple organizations; an owner has full organization and membership control; an editor may list members and create, resend, or revoke invitations only for `editor` and `member`; a member cannot administer membership. Editors cannot create owners, transfer ownership, delete the organization, remove members, or change an existing member role. Every invitation is single-use, expires after seven days, and can be accepted only by an authenticated verified account whose normalized email matches it. A transaction must prevent removal of the final owner, and every organization/membership/invitation/ownership change creates an audit event.

Access-lowering changes additionally use the recovery-safe security-tombstone protocol in `docs/requirements.md`. Production API receives a dedicated create-only credential for one encrypted append-only off-Netcup journal prefix; it cannot list, read, overwrite, or delete objects and it has no Restic/retention authority. A minimal encrypted/signed `prepared` record is durable before the local mutation, the database applies the same event ID, and a distinct `committed`/`cancelled` record resolves it. Recovery operators use a separate read/decrypt identity. Staging/development use only a local capture/fault-injection adapter. Alert on write failure, unresolved prepared age, sequence gap, and recovery-set high-water lag.

## 9. Cache and rate limiting

Valkey is a good Redis-compatible choice. Redis itself is also technically capable, but Valkey provides the same protocol family with a permissive open-source project and is a clean default for a new self-hosted stack.

Use Valkey for:

- cached read models;
- short-lived API results;
- rate-limit counters;
- login and abuse throttles;
- short coordination locks where loss is safe;
- a narrow worker-to-API invalidation channel;
- Socket.IO adapter coordination after API replica 2.

Do not use it for:

- primary sessions in the launch profile;
- business records;
- the only copy of a job;
- media metadata;
- values that cannot be rebuilt.

Use separate rendered configurations whose internal cache limit leaves allocator/process headroom below the container cap:

| Setting | Staging (128 MB cgroup) | Production (256 MB cgroup) |
|---|---:|---:|
| `maxmemory` | 72 MB | 160 MB |
| `maxmemory-policy` | `allkeys-lru` | `allkeys-lru` |
| `appendonly` | `no` | `no` |
| `save` | `""` | `""` |

Validate cgroup usage plus Valkey `INFO memory` under eviction/load fixtures; a `maxmemory` equal to the container cap is forbidden because allocator and server overhead would OOM before safe eviction.

Use separate ACL users and long unique credentials even on the internal network:

| ACL identity | Consumer | Scope |
|---|---|---|
| api | API | application cache/rate-limit key prefixes; subscribe to the production invalidation channel |
| worker | worker | its own ephemeral key prefix; publish only to the production invalidation channel |
| health | Valkey health check | `PING` only |
| socket-adapter | future API replicas | absent at launch; add only the exact stream/pub-sub commands and prefixes required by the chosen adapter |

Development, staging, and production use different ACL files, usernames, passwords, and key/channel prefixes. Never give API and worker the same Valkey URL. Never publish port 6379. Require TTLs for cache entries, record hit/miss/eviction metrics, and design every caller to tolerate a flushed cache.

If durable Valkey state is introduced later, revisit persistence, backup, and recovery instead of silently relying on the cache profile. See [Valkey security](https://valkey.io/topics/security/) and [Valkey persistence](https://valkey.io/topics/persistence/).

## 10. Queue, scheduled work, and reliable notifications

Use an application-owned transactional outbox followed by worker-owned pg-boss rather than RabbitMQ, NATS, Kafka, or a Redis queue at this stage.

The API writes the domain change and outbox event in the same transaction. This avoids the “database committed but broker publish failed” gap while keeping the API role completely outside the pg-boss schema:

~~~text
business transaction
  -> domain record
  -> application outbox event
  -> commit

worker outbox dispatcher
  -> claims outbox row
  -> creates deterministic pg-boss job
  -> marks row dispatched idempotently

worker job handler
  -> claims pg-boss job
  -> performs idempotent side effect
  -> records provider/result state
  -> acknowledges job
~~~

Queue categories may include:

- transactional email;
- image processing;
- media deletion and reconciliation;
- webhook delivery;
- scheduled cleanup;
- report generation;
- cache warming;
- audit export.

Every dispatcher and handler needs:

- a stable business idempotency key;
- bounded exponential retry;
- a maximum attempt count;
- a dead-letter or exhausted state;
- a timeout;
- structured logs with job and request correlation IDs;
- an operator-visible queue-lag and failure count;
- graceful shutdown and draining.

Start worker concurrency at 1, especially for image work. Use separate pg-boss queues and per-queue policies so a slow media job cannot starve authentication email. Scheduled jobs belong in pg-boss; do not add a second scheduler service.

For Sharp/libvips on the shared 8 GB host:

- set Sharp concurrency to 1;
- use a small bounded Sharp cache or disable it after load testing;
- enforce launch safety ceilings of 10 MiB encoded input, 25 million decoded pixels, one page/frame, and a 30-second job timeout; a later product policy may be stricter but never silently looser;
- reject input above those ceilings before expensive decoding and reject animated/multi-page inputs unless a separate requirement and resource test approves them;
- leave the container memory limit active;
- process one image job at a time and never perform video transcoding;
- treat an OOM-killed media job as a capacity failure requiring resize or stricter limits, not an infinite retry.

## 11. Realtime and live data

Run Socket.IO inside the API process.

For an API-handled mutation, the durable sequence is:

1. Commit the database transaction.
2. Publish an event containing the resource ID and new version or event ID.
3. The client receives the event.
4. The client refetches authoritative data.

Do not treat a WebSocket event as the only copy of a state change. Clients disconnect, reconnect, sleep, and miss events.

For a worker-handled job, the worker first commits the authoritative database result, then publishes a minimal resource-ID/version invalidation on its Valkey-authorized channel. The API subscribes with its separate ACL identity and emits the authorized Socket.IO event to the appropriate room. The invalidation contains no private record body. If Valkey is flushed or the notification is lost, the database result remains correct and clients recover by refetching on reconnect or normal polling.

With one API process, use Socket.IO’s in-memory adapter. Before starting a second API process:

1. add the [Socket.IO Redis Streams adapter](https://socket.io/docs/v4/redis-streams-adapter/), which documents Valkey compatibility;
2. share Better Auth secrets and Valkey-backed rate limits;
3. configure Caddy load balancing;
4. use sticky routing if HTTP long-polling remains enabled, as documented by [Socket.IO multiple-node guidance](https://socket.io/docs/v4/using-multiple-nodes/);
5. load-test reconnect and rolling-deploy behavior.

Two API containers on one VPS improve throughput and permit safer replacement, but they do not create host availability.

## 12. Stalwart mail architecture

Run Stalwart in its own container with its own embedded RocksDB data, not the application PostgreSQL. Stalwart recommends RocksDB for a single-node deployment: [Stalwart RocksDB backend](https://stalw.art/docs/storage/backends/rocksdb/).

Mount:

~~~text
/srv/myapp/production/stalwart/config -> /etc/stalwart
/srv/myapp/production/stalwart/data   -> /var/lib/stalwart
~~~

The official container runs as UID 2000. Pin v0.16.19 by version and tested OCI digest rather than using `latest`, and follow the [Stalwart Docker guide](https://stalw.art/docs/install/platform/docker/).

### Choose the mail mode

**Netcup launch mode: low-volume transactional/account mail only**

- Leave the Netcup `netcup Mail block` enabled through staging. Publish TCP 25 only in Prompt 06 after the dedicated provider/policy/firewall/PTR/DNS approval gate.
- Use internal authenticated submission from the worker.
- Keep public IMAP, POP3, ManageSieve, and client-submission ports closed.
- Create only named operational addresses such as postmaster, abuse, support, bounce handling, and DMARC reporting.
- Make the few operational mailboxes retrievable through IMAPS on container port 993 mapped only to host loopback port 1993, then reached through an approved SSH tunnel or private VPN. The mail client must validate `<MAIL_HOSTNAME>` as the TLS server name; do not disable certificate checks to make a tunnel work.
- Do not send marketing, newsletters, campaigns, broadcasts, or bulk mail and do not host general end-user mailboxes. These are excluded by this blueprint, not merely delayed by RAM.
- Record written Netcup clarification before launch when the intended volume or classification could approach the provider's bulk-mail restriction.

Stalwart's HTTP management surface is private. It is never joined to Caddy's network and is never routed by Caddy. Any future public mailbox/JMAP mode requires a new provider-policy, product, security, and capacity decision and is not included here.

The management listener must bind only to the fixed Stalwart address on `production-mail-admin`, never `0.0.0.0` or an address on submit/events/egress networks. Give that network a reviewed non-conflicting private subnet and fixed Stalwart address, and enforce a listener-level source policy that denies every source outside the admin subnet. Bootstrap through a one-shot administration tool on `production-mail-admin`, or through an approved loopback/SSH bridge that joins only that network. Tests from the API and worker networks must fail even though they share the Stalwart container for other listeners. An IP allowlist on a public Caddy route is not the administration boundary because the WebUI and management APIs use more than one path.

The pinned Stalwart image's default health check probes loopback HTTP endpoints. That conflicts with the private listener rule above, so the production overlay must override it: probe `/healthz/live` on the fixed `production-mail-admin` address from inside the Stalwart container, without adding a loopback or public management listener. Integration-test the exact pinned image and source policy; Docker health must become healthy while the same endpoint remains unreachable from API, worker, Caddy, and the public internet. Recheck the override whenever the pinned image changes against Stalwart's [image health-check definition](https://github.com/stalwartlabs/stalwart/blob/main/Dockerfile.build).

In transactional-only mode, Caddy does not proxy `<MAIL_HOSTNAME>` at all.

Because Caddy owns 443, let Stalwart obtain the certificate used by SMTP/IMAP through an ACME DNS-01 challenge with a narrowly scoped DNS token. Do not copy files from Caddy’s private certificate storage on a timer. See [Stalwart ACME challenge types](https://stalw.art/docs/server/tls/acme/challenges/).

The worker submits internally using the public mail hostname as the TLS identity. Give `production-stalwart` the exact `<MAIL_HOSTNAME>` alias on `production-mail-submit`, connect Nodemailer to that name, require STARTTLS on internal port 587 (or use tested implicit TLS on 465), set TLS `servername` to the same hostname, and keep certificate verification enabled. Do not connect to `production-stalwart:587` while presenting a certificate valid only for `<MAIL_HOSTNAME>`.

### Provider prerequisites

Do not commit to self-hosted delivery until all Netcup prerequisites pass:

- `IPv4 + IPv6 Connectivity` and the assigned static IPv4 are recorded;
- the default `netcup Mail block` remains enabled until its separately approved removal in SCP;
- inbound and outbound TCP 25 are tested independently after removal;
- IPv4 PTR is editable in SCP and set to `<MAIL_HOSTNAME>`;
- assigned IPv4 reputation is checked before launch;
- the transactional-only interpretation is documented and written Netcup clarification is retained when classification/volume is uncertain;
- rate limits, suppression, bounce handling, abuse response ownership, and queue monitoring are ready.

If outbound TCP 25 or PTR cannot be provided, the server may work locally but will not be a dependable internet mail server.

### DNS checklist

Publish semantic record templates in Cloudflare, using reviewed values generated by Stalwart. Mail records are DNS-only:

~~~text
<MAIL_HOSTNAME>.                         A       <VPS_IPV4>
<MAIL_DOMAIN>.                           MX 10   <MAIL_HOSTNAME>.
<BOUNCE_DOMAIN>.                         MX 10   <MAIL_HOSTNAME>.
<MAIL_DOMAIN>.                           TXT     "v=spf1 ip4:<VPS_IPV4> -all"
<BOUNCE_DOMAIN>.                         TXT     "v=spf1 ip4:<VPS_IPV4> -all"
<DKIM_SELECTOR>._domainkey.<MAIL_DOMAIN>. TXT     <STALWART_GENERATED_DKIM_PUBLIC_KEY>
_dmarc.<MAIL_DOMAIN>.                    TXT     "v=DMARC1; p=none; rua=mailto:<DMARC_REPORT_ADDRESS>"
~~~

Netcup SCP reverse DNS:

~~~text
<VPS_IPV4> -> <MAIL_HOSTNAME>
~~~

The forward A record, reverse PTR, and SMTP EHLO hostname must agree. Do not publish an AAAA record until IPv6, IPv6 firewalling, delivery, and IPv6 PTR are all correct.

Start DMARC at monitoring policy p=none. Confirm that every legitimate sender aligns, then progress to quarantine and finally reject. Add MTA-STS, TLS-RPT, SRV, and client-autoconfiguration records after the base mail flow works. Stalwart can generate the required records in its [DNS setup guide](https://stalw.art/docs/install/dns/).

### Application email flow

~~~text
application transaction
  -> durable notification outbox/job
  -> worker
  -> authenticated SMTP submission
  -> Stalwart delivery queue
  -> recipient mail server
~~~

Use a dedicated SMTP account/app password and restrict its sender identities. Never allow anonymous relay. Persist a stable Message-ID and application event ID. SMTP acceptance means queued, not delivered.

Use the dedicated `<BOUNCE_SENDER_ADDRESS>`, configure `<BOUNCE_DOMAIN>` as accepted in Stalwart, and publish its MX/SPF records. Process signed delivery events and delivery-status notifications into:

- hard-bounce suppression;
- soft-bounce backoff;
- complaint suppression;
- delivery state visible to operators.

Promotional and bulk mail are prohibited on this server. Warm a new IP gradually for the permitted transactional flow, monitor reputation, and maintain postmaster and abuse mailboxes. Google’s current [sender guidelines](https://support.google.com/mail/answer/81126) require appropriate authentication, reverse DNS, and TLS.

### Signed delivery-feedback ingestion

Configure Stalwart to send only the required delivery/queue events to an internal API endpoint such as `POST /internal/mail/stalwart-events` over `production-mail-events`. That path is not under `/api`, is not matched by Caddy, and has no public DNS route.

Use a separate high-entropy webhook key mounted from a production secret file into both Stalwart and the API. Stalwart signs the current recovery epoch, creation time, event ID, and raw request body; the API requires that exact epoch, verifies the signature in constant time before parsing, validates time against the replay window, and inserts each Stalwart event ID into a table with a unique constraint in the same transaction as the delivery-state update. Repeated deliveries return success without repeating the transition. Enforce an explicit monotonic per-message/recipient transition state machine so an older accepted/deferred event cannot undo a later permanent failure, suppression, or other terminal state merely because the unique-event ledger was restored backward. Disaster recovery keeps mail events/egress disabled, rotates the webhook key/epoch, and reconciles restored queue/message IDs before reopening. Configure the webhook as non-lossy with a reviewed discard window and alert before that window can expire. See Stalwart’s [signed webhook configuration](https://stalw.art/docs/telemetry/webhooks/) and [delivery event catalog](https://stalw.art/docs/telemetry/events/).

Subscribe only to the events needed to distinguish accepted, delivered, temporarily deferred, and permanently failed recipients. Correlate them through the stable application event ID, SMTP Message-ID, envelope ID, and recipient. A permanent failure updates suppression state idempotently; a temporary failure records backoff without hard suppression. Webhook loss must be visible through queue/feedback reconciliation and alerting.

`production-mail-events` contains only `production-stalwart` and `production-api`. The worker has SMTP credentials but no webhook credential; Caddy and web join neither `production-mail-events` nor `production-mail-admin`.

### Mail operational limits

- No catch-all unless there is a verified product reason.
- The launch defaults are 512 MiB per operational mailbox, 4 GiB for the operational-mail domain in aggregate, and 25 MiB per accepted message. Alert at 70% and 85% of each quota. Do not silently delete operational mail: archive or delete it through the reviewed operator process before the hard quota is reached. Any different retention or quota policy must be approved before the Prompt 06 mail gate.
- Remove STALWART_RECOVERY_ADMIN after bootstrap.
- Use a separate Stalwart operator identity that is not a normal mailbox or application user.
- Keep Stalwart auto-ban/rate-limit protection enabled; do not stack several ban agents without evidence.
- Alert on deferred queue age, repeated delivery failures, outbound volume, authentication failures, and mail disk use.
- Back up configuration, data, DKIM private keys, and the DNS inventory.

## 13. Caddy routing and the API-gateway boundary

Use one application origin per environment. The base Caddyfile imports `/etc/caddy/sites-enabled/*.caddy` but contains no environment site. Each overlay mounts only its own reviewed fragment, so Prompt 05 cannot request a production certificate or route to nonexistent production services. These structural fragments are shown together only for documentation:

~~~caddyfile
{
    email @@CERTIFICATE_CONTACT@@
}

# Base Caddyfile:
import /etc/caddy/sites-enabled/*.caddy

# infra/caddy/sites/production-restricted.caddy — selected for prelaunch
@@PRODUCTION_APP_DOMAIN@@ {
    encode zstd gzip

    # During prelaunch the DNS record remains DNS-only/direct to Caddy. Testers
    # must use a reviewed fixed CIDR or approved VPN egress address.
    @prelaunch_denied not remote_ip @@PRODUCTION_PRELAUNCH_TEST_CIDRS@@
    respond @prelaunch_denied 403

    header {
        -Server
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    # Keep this matcher synchronized with every magic-link, OAuth callback,
    # and invitation-acceptance route implemented by the application.
    @action_routes path /api/auth/* /accept-invitation /accept-invitation/*
    header @action_routes {
        Referrer-Policy "no-referrer"
        Cache-Control "no-store"
        X-Robots-Tag "noindex, nofollow, noarchive"
    }
    log_skip @action_routes

    handle /api/health/dependencies {
        @health_admin remote_ip @@PRODUCTION_ADMIN_HEALTH_CIDRS@@
        handle @health_admin {
            reverse_proxy production-api:3000
        }
        respond 404
    }

    handle /media/* {
        @hidden_media path_regexp hidden_media `(?i)(^|/)\.`
        respond @hidden_media 404
        @valid_media path_regexp valid_media `^/media/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}-v1-[0-9]{1,5}x[0-9]{1,5}\.(avif|webp|jpe?g|png)$`
        handle @valid_media {
            uri strip_prefix /media
            root * /srv/production-public-media
            header Cache-Control "public, max-age=31536000, immutable"
            file_server
        }
        respond 404
    }

    @backend path /api /api/* /socket.io /socket.io/*
    reverse_proxy @backend production-api:3000
    reverse_proxy production-web:3000
}

# infra/caddy/sites/production-public.caddy contains the same reviewed routes
# but omits @prelaunch_denied. A new signed activation manifest selects exactly
# one production fragment after the separate public-launch approval.

# infra/caddy/sites/staging.caddy — mounted only by staging overlay
@@STAGING_APP_DOMAIN@@ {
    encode zstd gzip

    header {
        -Server
        X-Robots-Tag "noindex, nofollow, noarchive"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    @action_routes path /api/auth/* /accept-invitation /accept-invitation/*
    header @action_routes {
        Referrer-Policy "no-referrer"
        Cache-Control "no-store"
        X-Robots-Tag "noindex, nofollow, noarchive"
    }
    log_skip @action_routes

    handle /api/health/dependencies {
        @health_admin remote_ip @@STAGING_ADMIN_HEALTH_CIDRS@@
        handle @health_admin {
            reverse_proxy staging-api:3000
        }
        respond 404
    }

    handle /media/* {
        @hidden_media path_regexp hidden_media `(?i)(^|/)\.`
        respond @hidden_media 404
        @valid_media path_regexp valid_media `^/media/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}-v1-[0-9]{1,5}x[0-9]{1,5}\.(avif|webp|jpe?g|png)$`
        handle @valid_media {
            uri strip_prefix /media
            root * /srv/staging-public-media
            header Cache-Control "public, max-age=31536000, immutable"
            file_server
        }
        respond 404
    }

    @backend path /api /api/* /socket.io /socket.io/*
    reverse_proxy @backend staging-api:3000
    reverse_proxy staging-web:3000
}

# infra/caddy/sites/storage.caddy — a separate disabled fragment mounted only by the approved S3 overlay
@@STORAGE_HOSTNAME@@ {
    reverse_proxy production-seaweedfs:8333
}
~~~

The site fragments are not mounted together automatically: base+staging enables exactly staging; Prompt 06 adds exactly one of the production restricted/public fragments; the S3 fragment stays absent unless separately approved. Both production variants live in the reviewed shared-infrastructure payload, but the signed activation manifest selects only one and records its digest. Production starts with the restricted variant. Its Cloudflare application record remains DNS-only so Caddy sees the real tester/VPN source address; do not trust forwarded client-IP headers unless Cloudflare proxying and trusted proxies are separately reviewed. After final launch approval, a new signed activation manifest switches only the production edge mode to the public fragment while preserving staging, payloads, and images. The example deliberately omits a default access-log block because raw URIs/queries can contain magic-link tokens or OAuth codes. The implementation must use a tested Caddy filter encoder or sensitive-route log exclusion so query strings, `Cookie`, `Authorization`, OAuth state/code, and magic-link tokens never reach logs while method, redacted path, status, duration, request ID, and safe client metadata remain observable. Pino applies equivalent redaction. Send unique sentinel values through auth routes and prove they appear in neither Caddy nor application logs.

The public-media mount contains only generated public variants. The `handle /media/*` block first rejects hidden/nonconforming paths, accepts only the reviewed SHA-256 shard/basename/variant grammar, then strips `/media` before static resolution. Add status-and-body tests proving a correctly hashed object succeeds only when its bytes match the key and every wrong-shard/hash, incoming, private, trash, dotfile, symlink, non-hash, and traversal attempt fails.

The actual application must define a tested Content Security Policy; a generic Caddy policy can break Next.js or permit more than intended. Add HSTS only after HTTPS and the subdomain plan are stable. Set route-specific request-body limits so ordinary JSON routes remain small while the controlled media upload path can accept its explicit maximum. Caddy documents [request body limits](https://caddyserver.com/docs/caddyfile/directives/request_body), [access logs](https://caddyserver.com/docs/caddyfile/directives/log), and [reverse proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

There is deliberately no `<MAIL_HOSTNAME>` Caddy site in the transactional-only profile. The Stalwart management listener is private and never routed by Caddy. Public mailbox/JMAP hosting is outside this blueprint.

Stock Caddy handles HTTP and WebSocket traffic. Stalwart's approved SMTP listener is published directly by Docker only after the mail gate; operational IMAPS is loopback-only. Do not install a custom layer-4 Caddy build merely to proxy mail.

## 14. Public ports and DNS names

### Host ports

| Port | Publish? | Owner | Rule |
|---:|---|---|---|
| 22/tcp | yes, restricted | SSH | fixed admin IP or WireGuard/VPN only if possible |
| 51820/udp | yes | WireGuard | authenticated administrator VPN endpoint; first tunnel uses server `10.77.0.1` and administrator `10.77.0.2` |
| 80/tcp | yes | Caddy | certificate issuance and HTTPS redirect |
| 443/tcp | yes | Caddy | web, API, and WebSocket; no Stalwart management/mailbox route |
| 443/udp | optional | Caddy | HTTP/3 |
| 25/tcp | Prompt 06 mail gate only | Stalwart | server-to-server SMTP after Netcup Mail-block/policy/DNS/PTR approval |
| 1993/tcp on 127.0.0.1 only | yes, loopback | Stalwart IMAPS tunnel | private operational-mailbox retrieval; TLS server name remains `<MAIL_HOSTNAME>` |
| 465/tcp | no public bind | Stalwart | internal submission only if explicitly selected/tested |
| 587/tcp | no public bind | Stalwart | internal worker submission |
| 993/tcp | no public bind | Stalwart | use loopback 1993 for named operational mailboxes |
| 4190/tcp | no | Stalwart | ManageSieve excluded at launch |
| 3000, 5432, 6379, 8080, 8333 and admin/metrics ports | no | internal services | Docker networks only |

Use both the Netcup SCP firewall and explicit Docker-aware host filtering. Docker warns that published container ports can bypass the normal UFW path, so do not assume an uncomplicated UFW rule protects a published port. Keep Docker's firewall integration enabled, publish only explicit ports, and validate `DOCKER-USER`/nftables policy from an external machine. Netcup's Mail block remains a separate SMTP control. See [Docker packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/) and [Netcup firewall documentation](https://www.netcup.com/en/helpcenter/documentation/server/firewall).

### Names

~~~text
<STAGING_APP_DOMAIN>      tester-only web, API, auth, Socket.IO, and public variants
<PRODUCTION_APP_DOMAIN>   web, API, auth, Socket.IO, and public /media variants
<MAIL_HOSTNAME>           DNS-only SMTP/TLS identity; no Caddy site
<STORAGE_HOSTNAME>        optional S3 data endpoint only after separate approval
~~~

Keep `<MAIL_HOSTNAME>` DNS-only if a CDN or HTTP proxy service is introduced later. Normal HTTP proxies do not proxy internet SMTP.

## 15. Compose topology template

The large YAML below is a **production-overlay fragment**, not a complete host composition and not the definition used for staging first. The base owns Caddy's image/security/config volumes but no host ports, environment networks, or environment media mounts. Development adds loopback-only ports; staging adds the one remote 80/443 list plus its network/media; production later adds only its network/media. The active host always renders base+staging before production is added.

Conceptual Caddy layering:

~~~yaml
# infra/compose.yaml
services:
  caddy:
    image: caddy:2.11.4-alpine@sha256:<caddy-image-digest>
    restart: unless-stopped
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    mem_limit: 96m

# infra/compose.development.yaml
services:
  caddy:
    ports: !override
      - "127.0.0.1:8080:80"
      - "127.0.0.1:8443:443"
    networks: [development-edge]
    volumes:
      - ./caddy/sites/development.caddy:/etc/caddy/sites-enabled/development.caddy:ro
      - development-public-media:/srv/development-public-media:ro

# infra/compose.staging.yaml
services:
  caddy:
    ports: !override
      - "80:80"
      - "443:443"
      - "443:443/udp"
    networks:
      staging-edge:
        ipv4_address: "@@STAGING_CADDY_IP@@"
    volumes:
      - ./caddy/sites/staging.caddy:/etc/caddy/sites-enabled/staging.caddy:ro
      - /srv/myapp/staging/media/public/variants:/srv/staging-public-media:ro

# infra/compose.production.yaml (added only with staging still active)
services:
  caddy:
    networks:
      production-edge:
        ipv4_address: "@@PRODUCTION_CADDY_IP@@"
    volumes:
      # The sealed release resolves this fixed path to exactly one reviewed
      # restricted/public production fragment selected by its manifest.
      - ./rendered/sites/production.caddy:/etc/caddy/sites-enabled/production.caddy:ro
      - /srv/myapp/production/media/public/variants:/srv/production-public-media:ro
~~~

Render/installer tests must prove that development has exactly the development site, base+staging has exactly the staging site, and base+staging+production has staging plus exactly one production site. No composition may mount both production edge variants or the disabled storage site unintentionally.

It is intentionally not copy-and-paste deployable: Prompt 04 converts the documented image markers into the strict renderer token schema, resolves domains through approved non-secret inputs, implements the server-side FILE secret loader, reviews optional mail ports, and pins tested OCI digests. An unresolved `@@...@@`, `${...}`, or semantic `<...>` marker makes sealing fail.

~~~yaml
name: <app-slug>-host

x-server-common: &server-common
  image: "@@PRODUCTION_SERVER_IMAGE@@"
  restart: unless-stopped
  init: true
  read_only: true
  tmpfs:
    - /tmp:size=64m,noexec,nosuid,nodev
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL

services:
  caddy:
    # Production overlay extension of the base Caddy service.
    volumes:
      - ./rendered/sites/production.caddy:/etc/caddy/sites-enabled/production.caddy:ro
      - /srv/myapp/production/media/public/variants:/srv/production-public-media:ro
    networks:
      production-edge:
        ipv4_address: "@@PRODUCTION_CADDY_IP@@"

  production-web:
    image: "@@PRODUCTION_WEB_IMAGE@@"
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=64m,noexec,nosuid,nodev
    environment:
      NODE_ENV: production
      NEXT_TELEMETRY_DISABLED: "1"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    expose:
      - "3000"
    networks:
      production-edge:
    mem_limit: 384m
    pids_limit: 128

  production-postgres:
    image: postgres:18.6-bookworm@sha256:<digest>
    restart: unless-stopped
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_bootstrap_password
    secrets:
      - postgres_bootstrap_password
    volumes:
      - production-postgres-data:/var/lib/postgresql
      - ./rendered/postgres/production.conf:/etc/postgresql/postgresql.conf:ro
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
    networks:
      - production-data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
      interval: 10s
      timeout: 5s
      retries: 10
    stop_grace_period: 60s
    mem_limit: 768m
    pids_limit: 256

  production-valkey:
    image: valkey/valkey:9.1.1-alpine@sha256:<digest>
    restart: unless-stopped
    command: ["valkey-server", "/etc/valkey/valkey.conf"]
    volumes:
      - ./rendered/valkey/production.conf:/etc/valkey/valkey.conf:ro
    secrets:
      - valkey_users_acl
      - valkey_health_password
    networks:
      - production-data
    healthcheck:
      test: ["CMD-SHELL", "VALKEYCLI_AUTH=\"$$(cat /run/secrets/valkey_health_password)\" valkey-cli --user health ping | grep -q PONG"]
      interval: 10s
      timeout: 3s
      retries: 10
    mem_limit: 256m
    pids_limit: 128

  production-migrate:
    <<: *server-common
    restart: "no"
    command: ["node", "dist/entrypoints/migrate.js"]
    environment:
      APP_DATABASE_URL_FILE: /run/secrets/migration_database_url
    secrets:
      - migration_database_url
    networks:
      - production-data
    depends_on:
      production-postgres:
        condition: service_healthy
    profiles:
      - tools

  production-api:
    <<: *server-common
    command: ["node", "dist/entrypoints/http.js"]
    environment:
      NODE_ENV: production
      PORT: "3000"
      TRUSTED_PROXY_IP: "@@PRODUCTION_CADDY_IP@@"
      APP_DATABASE_URL_FILE: /run/secrets/api_database_url
      APP_VALKEY_URL_FILE: /run/secrets/api_valkey_url
      SECURITY_TOMBSTONE_JOURNAL_FILE: /run/secrets/security_tombstone_journal
      OPERATIONS_HEALTH_TOKEN_FILE: /run/secrets/operations_health_token
      BETTER_AUTH_SECRET_FILE: /run/secrets/better_auth_secret
      AUTH_GOOGLE_CLIENT_ID_FILE: /run/secrets/auth_google_client_id
      AUTH_GOOGLE_CLIENT_SECRET_FILE: /run/secrets/auth_google_client_secret
      STALWART_WEBHOOK_SECRET_FILE: /run/secrets/stalwart_webhook_secret
      MEDIA_ROOT: /srv/media
      MEDIA_MAX_UPLOAD_BYTES: "10485760"
    secrets:
      - api_database_url
      - api_valkey_url
      - security_tombstone_journal
      - operations_health_token
      - better_auth_secret
      - auth_google_client_id
      - auth_google_client_secret
      - stalwart_webhook_secret
    volumes:
      - /srv/myapp/production/media/private/incoming:/srv/media/private/incoming
      - /srv/myapp/production/media/public/variants:/srv/media/public/variants:ro
      - /srv/myapp/production/media/private/originals:/srv/media/private/originals:ro
      - /srv/myapp/production/media/private/variants:/srv/media/private/variants:ro
    expose:
      - "3000"
    networks:
      production-edge:
        gw_priority: 1
      production-data:
      production-storage:
      production-mail-events:
    depends_on:
      production-postgres:
        condition: service_healthy
      production-valkey:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 15s
      timeout: 5s
      retries: 5
    stop_grace_period: 30s
    mem_limit: 384m
    pids_limit: 256

  production-worker:
    <<: *server-common
    command: ["node", "dist/entrypoints/worker.js"]
    environment:
      NODE_ENV: production
      APP_DATABASE_URL_FILE: /run/secrets/worker_database_url
      APP_VALKEY_URL_FILE: /run/secrets/worker_valkey_url
      SMTP_URL_FILE: /run/secrets/stalwart_smtp_url
      ACTION_LINK_DERIVATION_KEYRING_FILE: /run/secrets/action_link_derivation_keyring
      MEDIA_ROOT: /srv/media
      JOB_CONCURRENCY: "1"
      PGBOSS_CREATE_SCHEMA: "false"
      PGBOSS_MIGRATE: "false"
      SHARP_CONCURRENCY: "1"
      SHARP_CACHE_MEMORY_MB: "32"
      MEDIA_MAX_UPLOAD_BYTES: "10485760"
      MEDIA_MAX_DECODED_PIXELS: "25000000"
      MEDIA_MAX_PAGES: "1"
      MEDIA_JOB_TIMEOUT_MS: "30000"
    secrets:
      - worker_database_url
      - worker_valkey_url
      - stalwart_smtp_url
      - action_link_derivation_keyring
    volumes:
      - /srv/myapp/production/media/private:/srv/media/private
      - /srv/myapp/production/media/public/variants:/srv/media/public/variants:ro
    networks:
      - production-data
      - production-storage
      - production-mail-submit
    depends_on:
      production-postgres:
        condition: service_healthy
      production-valkey:
        condition: service_healthy
    stop_grace_period: 120s
    mem_limit: 256m
    pids_limit: 256

  production-stalwart:
    image: stalwartlabs/stalwart:v0.16.19@sha256:<digest>
    restart: unless-stopped
    environment:
      STALWART_PUBLIC_URL: "https://@@MAIL_HOSTNAME@@"
      STALWART_HEALTHCHECK_URL: "http://@@STALWART_MAIL_ADMIN_IP@@:8080/healthz/live"
    # The initial `mail_mode: private` rendered variant has no host ports.
    # The separately signed production-mail transition selects the reviewed
    # structural variant that adds only TCP 25 plus loopback-only 1993:993.
    expose:
      - "587"
    secrets:
      - stalwart_webhook_secret
      - stalwart_dns_api_token
    volumes:
      - /srv/myapp/production/stalwart/config:/etc/stalwart
      - /srv/myapp/production/stalwart/data:/var/lib/stalwart
    networks:
      production-mail-submit:
        aliases:
          - "@@MAIL_HOSTNAME@@"
      production-mail-events:
      production-mail-admin:
        ipv4_address: "@@STALWART_MAIL_ADMIN_IP@@"
      production-mail-egress:
        gw_priority: 1
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS --max-time 4 http://@@STALWART_MAIL_ADMIN_IP@@:8080/healthz/live || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
    stop_grace_period: 60s
    mem_limit: 512m
    pids_limit: 512

networks:
  production-edge:
    ipam:
      config:
        - subnet: "@@PRODUCTION_EDGE_SUBNET@@"
  production-data:
    internal: true
  production-storage:
    internal: true
  production-mail-submit:
    internal: true
  production-mail-events:
    internal: true
  production-mail-admin:
    internal: true
    ipam:
      config:
        - subnet: "@@PRODUCTION_MAIL_ADMIN_SUBNET@@"
  production-mail-egress:

volumes:
  production-postgres-data:

secrets:
  postgres_bootstrap_password:
    file: /etc/myapp/secrets/production/postgres_bootstrap_password
  migration_database_url:
    file: /etc/myapp/secrets/production/migration_database_url
  api_database_url:
    file: /etc/myapp/secrets/production/api_database_url
  worker_database_url:
    file: /etc/myapp/secrets/production/worker_database_url
  api_valkey_url:
    file: /etc/myapp/secrets/production/api_valkey_url
  security_tombstone_journal:
    file: /etc/myapp/secrets/production/security_tombstone_journal
  operations_health_token:
    file: /etc/myapp/secrets/production/operations_health_token
  worker_valkey_url:
    file: /etc/myapp/secrets/production/worker_valkey_url
  action_link_derivation_keyring:
    file: /etc/myapp/secrets/production/action_link_derivation_keyring
  valkey_users_acl:
    file: /etc/myapp/secrets/production/valkey_users_acl
  valkey_health_password:
    file: /etc/myapp/secrets/production/valkey_health_password
  better_auth_secret:
    file: /etc/myapp/secrets/production/better_auth_secret
  auth_google_client_id:
    file: /etc/myapp/secrets/production/auth_google_client_id
  auth_google_client_secret:
    file: /etc/myapp/secrets/production/auth_google_client_secret
  stalwart_smtp_url:
    file: /etc/myapp/secrets/production/stalwart_smtp_url
  stalwart_webhook_secret:
    file: /etc/myapp/secrets/production/stalwart_webhook_secret
  stalwart_dns_api_token:
    file: /etc/myapp/secrets/production/stalwart_dns_api_token
~~~

Important template notes:

- An image reference containing `<digest>` is a placeholder and will not work until replaced.
- The web image is Next.js standalone SSR. ISR and the built-in image optimizer are disabled; the read-only runtime must pass SSR and restart tests without writing outside bounded `/tmp`.
- Configure valkey.conf with aclfile /run/secrets/valkey_users_acl. The rendered production ACL disables the default user, gives API and worker different users/credentials and exact key/channel permissions, and allows the health user to run only PING. Its password must match valkey_health_password.
- The worker SMTP URL uses `<MAIL_HOSTNAME>`, not the Compose service name, and TLS verification/SNI use that same hostname. The `production-mail-submit` alias must match the production certificate name.
- `action_link_derivation_keyring` is an environment-specific, versioned, purpose-separated HMAC keyring mounted only into the worker. API, web, migrate, Stalwart, and the other environment cannot read it. Development and staging implement the same secret schema with independent keys. Recovery inventory preserves required old versions only for planned expiry/retry overlap; cross-environment and retired-version probes must fail.
- `security_tombstone_journal` is production API-only and contains the approved create-only journal endpoint/prefix/signing/encryption material. It grants no read/list/overwrite/delete/Restic access. Staging/development configure the capture adapter instead and cannot reach the production journal.
- `operations_health_token` is independently generated per environment and mounted only into that API. Caddy also restricts `/api/health/dependencies` to the manifest's explicit administrator/VPN CIDRs. It is infrastructure authorization, not a product role, and must not appear in browser code, web/worker/migrate containers, Caddy logs, or reports.
- `production.mail_mode` is `private` in the initial production manifest. The deterministic renderer selects a fully reviewed no-host-port production template. A separate next-sequence `production-mail` manifest may select the external structural variant, changing the expected rendered/config digests and adding only `25:25` plus `127.0.0.1:1993:993`; arbitrary YAML/token injection is rejected. No raw Compose command may publish those ports.
- Stalwart reads the DNS-01 token and webhook key from mounted secret files through its secret-file configuration. Its signed webhook target is `production-api` on `production-mail-events`; neither the target nor the management listener is routed by Caddy.
- Stalwart's management listener binds only to `<STALWART_MAIL_ADMIN_IP>` on `<PRODUCTION_MAIL_ADMIN_SUBNET>` and denies every non-admin source. Prompt 04 defines only the renderer fields, placeholder schema, and local collision tests. After the live host/VPN/Docker network baseline, Prompt 06 selects and approves the concrete non-conflicting values, records them directly in the signed activation manifest, renders them into the sealed configuration, and proves that API/worker attempts fail while the one-shot admin path succeeds.
- Sharp values are conservative infrastructure safety ceilings, not authorization to add an upload API. A future product media policy may lower them; raising them requires measured memory/decode tests and approval. CI rejects a production configuration that removes these ceilings.
- Do not apply one blanket hardening anchor to every stateful image. Stalwart uses a file capability for privileged mail ports, and PostgreSQL initialization needs its documented filesystem behavior. Test each restriction.
- Compose secrets are files, not an encrypted vault. The host remains the trust boundary. See [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).
- health checks help with startup ordering, but every application process must still retry dependency connections with backoff. See [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).
- Use the Docker local logging driver or bounded per-service logging. Docker documents [logging configuration](https://docs.docker.com/engine/logging/configure/) and recommends the [local driver](https://docs.docker.com/engine/logging/drivers/local/) for automatic rotation.

## 16. Host setup guide

### Step 0: collect prerequisites before touching Netcup

Prepare:

- verified Netcup account/order, RS 1000 G12 server ID/location, x86 platform, SCP/CCP recovery, and confirmed-empty status;
- `IPv4 + IPv6 Connectivity`, assigned static IPv4, routed `/64`, and recorded gateways;
- Cloudflare zone authority and narrowly scoped DNS-token reference;
- current Netcup firewall and `netcup Mail block` state, SCP PTR control, assigned-IP reputation, and transactional-only policy evidence;
- the staging, production, mail, and bounce domains;
- the Git repository and image registry;
- an encrypted Restic destination outside Netcup;
- an external uptime-monitor location;
- the public SSH key for the named host operator;
- SCP console/rescue recovery and an abuse-notice response owner;
- initial RPO and RTO targets.

A sensible MVP starting target is an RPO of six hours for PostgreSQL and 24 hours for media/mail, with an RTO of four hours. Tighten it before accepting irreplaceable data or money.

### Step 0A: install the required operating system

Check Netcup's SCP images for Ubuntu 26.04 LTS. If unavailable, verify the official Ubuntu ISO checksum/signature and use the SCP custom-ISO workflow. Reimaging is destructive: target only the reviewed confirmed-empty server and require explicit approval. Record the installed OS, `x86_64` architecture, disk, IPv4/IPv6 routes, and SCP server identity before Ansible.

### Step 1: update and secure Ubuntu

1. Apply all security updates and reboot if required.
2. Create one named sudo host operator. For the dedicated keyed `esmii-administrator`, install the explicitly approved, `visudo`-validated `NOPASSWD: ALL` policy without Docker-group membership.
3. Install an Ed25519 SSH key.
4. Open a second SSH session and verify sudo and SCP console/rescue access.
5. Only then disable root SSH, password authentication, and keyboard-interactive authentication.
6. Validate sshd configuration before reload.
7. Enable Ubuntu unattended security updates with a planned reboot policy.
8. Confirm time synchronization and UTC server/application timestamps.

Use Ubuntu’s current guides for [OpenSSH server security](https://ubuntu.com/server/docs/how-to/security/openssh-server/) and [automatic updates](https://ubuntu.com/server/docs/how-to/software/automatic-updates/). Do not lock the only working session before testing a second path.

### Step 2: configure the network boundary

At the Netcup SCP firewall:

- review the complete stateful ruleset; new servers may initially allow traffic except SMTP, and adding the first rule can change the direction's implicit action;
- allow the authenticated WireGuard endpoint on UDP 51820 and then allow SSH only through the verified VPN;
- allow 80 and 443;
- keep the `netcup Mail block` enabled through Prompt 05; add only the selected Stalwart ports in the separate Prompt 06 mail gate;
- do not create rules for internal application ports.

Install host firewall policy, but account for Docker’s packet path. Keep Docker firewall management enabled. After containers start, scan the public IP from another network and confirm that only intended ports answer.

### Step 3: install Docker correctly

Follow the current [official Docker Engine Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/):

1. remove conflicting unofficial Docker packages if present;
2. install from Docker’s signed apt repository;
3. install Engine, containerd, Buildx, and the Compose plugin;
4. verify with the official hello-world check;
5. enable Docker at boot.

Do not use Docker’s convenience script for production. Membership of the docker group is effectively root access; prefer sudo or a narrowly controlled deploy wrapper rather than giving broad Docker access to ordinary accounts.

Before starting production containers, configure bounded Docker logs. A reasonable /etc/docker/daemon.json baseline is:

~~~json
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
~~~

Restarting Docker can interrupt running containers, so establish this before launch and schedule later daemon changes.

The planned `infra/ansible/playbooks/vps.yaml` should make the repeatable parts of Steps 1–6 idempotent: required packages, Docker repository/daemon policy, swap, directory skeleton, firewall prerequisites, and installation of reviewed systemd unit templates. Inventory examples contain no production address or credential. Keep SSH lockout-sensitive changes behind explicit variables and a second-session safety check; do not let an unattended playbook remove the only working access path.

### Step 4: add emergency swap

Create a 2 GB swap file with mode 0600, enable it, add the exact path to /etc/fstab, and choose a low swappiness such as 10. Verify with swapon --show.

Swap prevents a short spike from immediately invoking the OOM killer. It is not extra application capacity. Alert on sustained use and resize rather than accepting persistent swap activity.

### Step 5: create isolated environment directories and ownership

Illustrative production paths are shown below; the Ansible role creates the equivalent separate staging tree during Prompt 05 and reserves the production tree without activating production:

~~~bash
sudo install -d -m 0755 -o root -g root /srv/myapp
sudo install -d -m 0750 -o deploy -g deploy /srv/myapp/release-inbox
sudo install -d -m 0755 -o root -g root /srv/myapp/releases
sudo install -d -m 0755 -o root -g root /etc/myapp
sudo install -d -m 0750 -o root -g "${APP_RECONCILER_GROUP:?required}" /etc/myapp/deployment-policies
sudo install -d -m 0700 -o root -g root /etc/myapp/approved-releases
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/public
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/private
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/public/variants
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/private/incoming
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/private/originals
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/private/variants
sudo install -d -m 0750 -o "${APP_MEDIA_WORKER_UID:?required}" -g "${APP_MEDIA_WORKER_GID:?required}" /srv/myapp/production/media/private/trash
sudo setfacl -m "u:${APP_MEDIA_API_UID:?required}:rwx,d:u:${APP_MEDIA_API_UID}:rwx,d:u:${APP_MEDIA_WORKER_UID}:rwx" /srv/myapp/production/media/private/incoming
sudo setfacl -m "u:${APP_MEDIA_API_UID:?required}:r-x,d:u:${APP_MEDIA_API_UID}:r-x" /srv/myapp/production/media/private/originals /srv/myapp/production/media/private/variants
sudo setfacl -m "u:${APP_MEDIA_API_UID:?required}:r-x,u:${APP_CADDY_UID:?required}:r-x,d:u:${APP_MEDIA_API_UID}:r-x,d:u:${APP_CADDY_UID}:r-x" /srv/myapp/production/media/public/variants
sudo install -d -m 0700 -o root -g root /srv/myapp/production/backup-staging
sudo install -d -m 0750 -o 2000 -g 2000 /srv/myapp/production/stalwart/config
sudo install -d -m 0750 -o 2000 -g 2000 /srv/myapp/production/stalwart/data
sudo install -d -m 0700 -o root -g root /etc/myapp/secrets/production
~~~

Create `/srv/myapp/staging/media/public`, `/srv/myapp/staging/media/private`, and staging-only state/secrets during Prompt 05. Production paths may be reserved empty, but production secrets/data/services are not initialized until Prompt 06. Use different numeric identities/ACLs where necessary and prove neither environment can read the other.

The commands are templates and intentionally fail when the task-specific UID/GID variables are unresolved. Prompt 04 must derive those numeric identities from the pinned images, install the host `acl` tooling, and render the equivalent state idempotently through Ansible. The worker owns the whole media tree; the API has write access only to incoming and read access only to delivery trees; Caddy has read access only to public variants; trash remains worker-only. The root-owned backup job alone uses `backup-staging`. The adapter creates directories with mode `0750` and files with mode `0640`, so inherited default ACLs do not make files executable. Verify effective access from the actual containers and deny every extra path. Do not make the media root world-readable. Staging identities and ACLs never grant access to production paths.

The unprivileged reconciler may write only to `release-inbox`; it cannot write releases, policy files, or approval records. Initial staging and production records are manually installed after their gates. For later qualifying staging-only requests, the minimal root policy controller may derive the exact record from the immutable policy and logs its policy digest, Deployment ID, predecessor, every payload/manifest/image digest, checks, and outcome. The installer validates the complete referenced artifact set in a root-private temporary directory and seals it under `releases`. Never execute Compose from the inbox.

### Step 6: create secrets

Generate unique high-entropy values only for the environment authorized by the current prompt. Prompt 05 creates staging and reconciler values; Prompt 06 creates production/mail/backup values:

- PostgreSQL bootstrap, migration, API, worker, and backup roles;
- Better Auth;
- Google provider credentials for separate staging and production applications;
- Valkey ACL users;
- Stalwart administration, SMTP submission, signed webhook, and scoped DNS-01 credentials;
- DKIM private material;
- optional S3 app and admin users only after separate approval;
- off-Netcup Restic repository only in Prompt 06;
- deployment access.

Store the plaintext runtime files under `/etc/myapp/secrets/<environment>` with the minimum owner and mode required by the consuming container. Production and staging values must be independently generated; copying production OAuth, cookie, SMTP, webhook, Valkey, or database credentials into staging is prohibited. Keep an encrypted offline copy using age/SOPS or another reviewed method. Never put a secret in:

- Git;
- a Dockerfile or build argument;
- an image layer;
- a committed .env file;
- logs;
- browser-visible variables;
- CI output.

The application config loader should support NAME_FILE variables and read the secret value from /run/secrets/NAME. Redact the corresponding values and URLs from configuration errors.

### Step 7: prepare DNS

Prepare Cloudflare staging application DNS for Prompt 05. Prepare but do not apply production/mail A/AAAA/MX/SPF/DKIM/DMARC/bounce records until Prompt 06. PTR and Mail-block changes belong to Netcup SCP, not Cloudflare. Stalwart-generated DKIM cannot be published until bootstrap produces it. Keep mail host records DNS-only. Publish MTA-STS, TLS-RPT, SRV, and client-autoconfiguration only after the base SMTP flow is verified. Every external change remains separately approved.

### Step 8: seal and validate the deployment files

The reconciler downloads the approved signed activation manifest and every digest-addressed shared/application payload it references into the inbox without extracting or executing them. It rejects missing payloads, unreferenced extras, digest aliasing, and any payload whose internal inventory disagrees with the manifest. After the root-only approval record exists, install and validate the exact manifest and referenced set named in that record:

~~~bash
sudo /usr/local/sbin/<app-slug>-install-release <release-id> /srv/myapp/release-inbox/<activation-manifest-digest>.yaml
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> verify
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> config --quiet
~~~

The install command is mutating and requires approval for the exact activation-manifest digest, expected `rendered_compose_digest`, and every shared/application payload and image digest it references; `verify` and post-install rendering inspection are read-only. The manifest path is the only artifact argument because the installer resolves payloads from fixed digest-addressed inbox paths, renders from the sealed templates, and independently checks the expected digest. This gate does not authorize `pull` or service mutation. Confirm the sealed hashes and review without printing secrets. The Prompt 05 activation manifest uses base+staging and `production: null`. Prompt 06 uses the unchanged shared-infrastructure payload, preserves the current staging block, and references the same staging-tested application payload/images in the new production block.

### Step 9: activate staging state and roles

Only after the separate activation approval may the wrapper pull images or start/change services.

1. Start staging PostgreSQL, Valkey, and private Mailpit.
2. Wait for healthy status.
3. Connect with the bootstrap database role through a one-shot administrative container or local socket path.
4. Create the least-privilege runtime roles and databases.
5. Remove bootstrap credentials from routine deployment access.
6. Run the one-shot staging migration role, including application/Better Auth schema, outbox, default privileges, and the pinned pg-boss migration.
7. Start a permission probe with the API credential and prove it cannot access the pg-boss schema or run DDL.
8. Start a permission probe with the worker credential and prove runtime pg-boss operations work while schema creation/migration and application ownership fail.

### Step 10: activate staging application, then stop Prompt 05

The original Prompt 05 activation verified staging HTTPS, exact OAuth callbacks, tester allowlist, noindex behavior, private Mailpit, auth/organization authorization, Socket.IO, environment isolation, resource headroom, reboot, and rollback. The user's latest 31 August 2026 instruction keeps staging in explicit allowlist mode with exactly two root-only tester addresses, retains `noindex`, and uses a separate Stalwart sender/credential for their account/auth delivery. The protected `dev` → staging outbound deployment flow remains unchanged.

### Step 11: seal production and prepare Stalwart privately in Prompt 06

1. While holding the host-operation lock, re-read the active predecessor, verify staging, and seal a base+staging+production manifest using the exact current staging application/image digests, unchanged shared-infrastructure payload, restricted production edge fragment/CIDR set, and approved production non-secret mail/network values.
2. Keep the Netcup Mail block enabled and every public SMTP listener/firewall rule closed. Start only the Stalwart bootstrap profile on private networks; external delivery remains disabled.
3. Access the source-restricted management listener only through a one-shot tool on `production-mail-admin`, or an approved temporary private bridge that joins only that network; never add it to Caddy or a public firewall rule.
4. Configure the hostname/domain, RocksDB, strict queue/message retention and quotas, DKIM material, anti-abuse rules, dedicated application SMTP identity, signed-feedback settings, and only the approved operational mailboxes. Do not issue/send public mail or invoke a production API webhook yet.
5. Validate templates, listener bindings, relay denial, account/quota policy, encrypted-backup inclusion, and management-network denial with local fixtures. Generate the exact DNS plan, but do not change DNS/PTR, remove the Mail block, or run external canaries.
6. Remove `STALWART_RECOVERY_ADMIN` and any temporary bridge after bootstrap; stop or leave the service in explicitly non-delivering private mode until Step 13.

### Step 12: deploy the restricted production application

1. Start production PostgreSQL/Valkey, run the one-shot production migration, and prove runtime-role restrictions.
2. Start production API and worker with asynchronous mail behavior; readiness must not depend synchronously on SMTP delivery. With external delivery still disabled, prove API success plus visible outbox/worker retry state.
3. Start production web and update shared Caddy through the full sealed rendered overlay set.
4. Keep the Cloudflare application record DNS-only; verify HTTPS/redirects, 403 from an unapproved source, and successful access from the reviewed tester/VPN CIDR.
5. Test same-origin cookies, exact production OAuth callbacks, account-linking safeguards, logout/session revocation, organization authorization, forbidden cross-organization/environment access, Socket.IO reconnect/refetch, and media boundaries. Prove password routes do not exist and production activation did not change staging state/digests.
6. Do not advance `main`, open production publicly, or claim email readiness at this point.

### Step 13: activate and verify production mail under its separate gate

1. Recheck written Netcup policy clarification where needed, assigned-IP reputation, Mail-block/firewall/PTR approval, Cloudflare mail-DNS approval, TLS/queue/bounce readiness, quotas, and rollback.
2. Re-read the active restricted-production predecessor and seal a new next-sequence `production-mail` manifest/release with `mail_mode: external`, the reviewed structural render/config digests, and exact mail-evidence digest; preserve staging and every non-mail production/shared/edge field.
3. Prove the current private-mail release has no host TCP 25 listener. Under the separate provider approvals, publish/verify A/AAAA/MX/PTR/SPF/DKIM/bounce/initial-DMARC records, remove the Netcup Mail block, and make the minimum firewall change.
4. Run the journaled locked `production-mail` activation transaction, which adds only the reviewed host TCP 25 and loopback IMAPS bindings, obtains/validates the approved certificate, enables external delivery, records the immutable checkpoint, and rolls back host mail mode on failure.
5. Configure the production API's non-lossy HMAC-signed delivery webhook over `production-mail-events`; prove epoch/signature, replay, timestamp, unique event-ID, and monotonic per-recipient transition behavior.
6. Verify worker submission resolves `<MAIL_HOSTNAME>`, sends matching SNI, validates the certificate, cannot anonymously relay, and never logs rendered message bodies.
7. Run magic-link/invitation consume/replay/expiry/supersession tests and only controlled transactional canaries to several providers. Verify headers, SPF/DKIM/DMARC alignment, TLS, queue state, bounce/suppression handling, and bounded message retention. Marketing/bulk delivery remains prohibited.

### Step 14: create and prove the first production backup

Do not accept production until an encrypted backup has left Netcup and an isolated restore has succeeded. The restore environment uses disposable non-public networks and paths, sanitized hostnames, no production OAuth/webhook/SMTP/DNS/Internet credentials or egress, and workers/schedulers disabled or wired only to Mailpit/capture. Clean it up by exact recorded paths after evidence is retained. A Netcup snapshot or successful backup exit code is not restore proof.

### Step 15: complete restricted-production acceptance and advance `main`

Verify external monitoring, reboot recovery, capacity, security, environment isolation, backup freshness/restore, transactional mail, and a newly signed production-only rollback that preserves current staging/shared state. Re-read the active release while holding the host-operation lock. Only after every gate passes may the separate protected promotion identity fast-forward `main` to the exact staged source SHA; the reconciler cannot update branches.

### Step 16: optionally open production publicly

Public launch is a further approval and a new signed activation manifest satisfying the edge-only invariant in `docs/deployment.md`. Base it on the current predecessor while holding the global host-operation lock, preserve current staging/shared and every non-edge production field, then verify access from a formerly disallowed source.

## 17. Security model

This design uses a small number of high-value trust boundaries rather than installing a collection of security products.

### Security invariants

The following should always be true:

1. Only Caddy and the explicitly required mail listeners are public.
2. PostgreSQL, Valkey, application ports, object-store administration, metrics, mail feedback, and Stalwart management/bootstrap interfaces are never publicly host-published.
3. The browser never receives database, cache, SMTP, backup, migration, or object-admin credentials.
4. Caddy cannot reach PostgreSQL or Valkey and never mounts /var/run/docker.sock.
5. The API cannot access pg-boss; the worker has only tested pg-boss runtime grants; neither runtime role can run DDL.
6. Every resource operation checks server-side ownership or tenant scope.
7. Private media is physically outside Caddy’s mount; temporary links are short-lived and scoped.
8. Important jobs and external side effects are idempotent.
9. A production backup exists outside Netcup and is not accepted until restore-tested.
10. Production images are pinned; latest tags and automatic Watchtower upgrades are prohibited.
11. Stalwart management is on a private listener and never routed by Caddy; other administration interfaces require a private path such as a VPN or SSH tunnel.
12. Security-sensitive changes create an append-only audit event.
13. Staging and production share only the explicitly named host-level control plane (physical host, Docker daemon/project, root-owned release tooling/reconciler) and Caddy; they share no application/data network, state path, volume, credential, cookie, OAuth application, mail identity, or backup repository.
14. Stalwart feedback is accepted only on the internal network after HMAC verification and unique event-ID insertion.
15. The host accepts deployments only through the root-owned outbound reconciler and sealed wrappers; GitHub-hosted runners receive no inbound SSH or Docker access.

### Host and container hardening

- Key-only SSH, no direct root login, and provider-console recovery.
- Provider firewall plus Docker-aware host filtering.
- App containers run as explicit non-root users.
- Read-only root filesystems and tmpfs /tmp where supported.
- no-new-privileges and dropped Linux capabilities where verified compatible.
- Default Docker seccomp and AppArmor profiles remain enabled.
- No privileged containers, host networking, host PID/IPC, devices, broad host mounts, or unconfined profiles.
- No Docker socket inside Caddy, the app, CI, monitoring, or an admin UI.
- Explicit memory, process, upload, mailbox, and disk quotas.
- Bounded logs and data retention.
- Security updates for Ubuntu, plus separate reviewed container-image updates.
- Production build in CI with minimal multi-stage images.

Docker documents its [default seccomp profile](https://docs.docker.com/engine/security/seccomp/) and [AppArmor integration](https://docs.docker.com/engine/security/apparmor/). Keep defaults unless a tested service-specific requirement proves otherwise.

### Application security

- Validate all input with allowlisted schemas.
- Encode output by context and use framework escaping.
- Use parameterized SQL through the database layer.
- Enforce request-body, upload, query-complexity, and pagination limits.
- Apply both IP and authenticated-user rate limits where appropriate.
- Do not trust X-Forwarded-For from arbitrary peers.
- Use secure cookies and CSRF/origin checks.
- Require recent magic-link or provider reauthentication for email, linked-provider, ownership, and sensitive membership changes.
- Keep magic-link values single-use, short-lived, and stored using Better Auth’s supported secure model; expose no password credential or reset flow.
- Audit authentication, linked-provider, membership, permission, and ownership events.
- Redact Authorization, Cookie, Set-Cookie, credential values, tokens, magic links, OAuth codes, email bodies, secret URLs, and personal fields from logs.
- Use a restrictive, tested Content Security Policy.
- Return generic authentication errors while keeping useful internal request IDs.
- Apply retention and deletion rules to user data, audit data, mail, logs, and backups.

### Supply-chain and update policy

In CI:

- use a frozen lockfile;
- run unit, integration, and end-to-end tests;
- scan committed secrets;
- scan dependencies and final container images;
- generate an SBOM;
- block fixable critical vulnerabilities unless a documented exception exists;
- sign or attach provenance to images when the registry supports it.

Use a monthly routine maintenance window and faster action for actively exploited or remotely reachable critical issues. Database and mail major versions are planned migrations, never unattended upgrades.

The security-hardening method shaped these boundaries: public exposure, credential reachability, least privilege, and recovery were treated as invariants; heavyweight SIEM, WAF, and cluster tooling were postponed until evidence justifies them.

## 18. Backup and disaster recovery

An extra copy on the same 256 GB NVMe disk is staging, not a backup. Netcup offline snapshots are optional short-lived pre-change aids within the same provider/account failure domain. Use Restic to encrypt production data before sending it to a repository physically and administratively outside Netcup. Restic documents [encrypted repositories](https://restic.readthedocs.io/en/latest/030_preparing_a_new_repo.html), [backup](https://restic.readthedocs.io/en/latest/040_backup.html), and [restore](https://restic.readthedocs.io/en/latest/050_restore.html).

### Lean MVP backup policy

Run backup jobs from host systemd timers, which invoke short-lived tools rather than adding another always-on scheduler container. Review the templates in `infra/systemd`, install root-owned copies under `/etc/systemd/system`, use a production-only root-readable environment/credential file, and guard each job with a lock so backups cannot overlap. The unit must use absolute production paths and send failure/freshness signals outside the VPS; staging has a different unit name or no installed timer.

The VPS backup identity is write/append-only: it may create snapshots and perform only the minimum reads/locks required by the chosen Restic backend, but it cannot delete historical objects, prune, or alter protected retention. The root-owned wrapper pins the repository, source paths, credential file, and sanitized environment and rejects ambient overrides. Keep full delete/prune authority and recovery custody outside the VPS/Netcup under a separate operator identity; run retention from that trusted location and test that the VPS credential's deletion attempt is denied. Backend versioning alone is insufficient when the same compromised credential can purge versions.

Host backup capture and restore follow the global locking protocol: acquire `host-operation` before `backup` when both are needed, hold the global lock only long enough to capture a consistent PostgreSQL/Stalwart/media boundary, and transfer/compress offsite after releasing it. Host-only Docker/image/log prune uses `host-operation` and never invokes Restic. The separate off-VPS retention identity cannot use the VPS lock; it coordinates with snapshot writers through the repository/backend lock or a reviewed external lease, uses bounded retry, and never prunes while a snapshot upload is active. Restore, host destructive cleanup, and off-VPS retention each require their own explicit approval.

**PostgreSQL**

- pg_dump custom-format backup every six hours;
- pg_dumpall --globals-only --no-role-passwords daily using a narrowly controlled operational connection;
- copy each completed dump to the encrypted off-host repository;
- do not copy the live PostgreSQL data directory as a logical backup;
- validate dumps and restore into a disposable isolated database weekly;
- restore role passwords from the separately encrypted production secret/recovery inventory, never from a broadly readable globals dump.

PostgreSQL documents that [pg_dump creates consistent exports](https://www.postgresql.org/docs/current/app-pgdump.html).

**Media**

- back up private originals, required private variants, public variants that cannot cheaply be regenerated, and the matching PostgreSQL dump from the production environment root;
- pause new uploads briefly or use a filesystem snapshot so metadata and files represent a coherent window;
- exclude incoming partial files and disposable generated variants when they can safely be rebuilt;
- verify checksums and run orphan reconciliation after a restore.

**Stalwart**

- back up /etc/stalwart, /var/lib/stalwart, DKIM keys, and the DNS inventory;
- stop Stalwart briefly or use its documented consistent snapshot/export procedure before copying embedded RocksDB data;
- test the restore in an isolated container;
- verify mail queue, accounts, domains, and certificate reissuance.

**Configuration and secrets**

- Compose and Caddy configuration live in Git without secrets;
- an encrypted copy of production secrets, recovery keys, and runbooks lives off-host;
- record image digests and the deployed Git SHA;
- preserve the Better Auth rotation history needed to validate active sessions during a planned rotation.

**Atomic recovery-set manifest**

- write every component to a bounded `.partial` path, validate/checksum/fsync it, then atomically rename it;
- record active release/activation digests, deployment epoch/sequence/checkpoint, database dump/global checksums/schema/capture time, media manifest/checksums/cutoff, Stalwart snapshot/queue cutoff, configuration/DNS inventory, key versions, security-tombstone high-water mark, and Restic snapshot/object IDs in one canonical signed/checksummed manifest;
- upload every referenced component and publish the append-only offsite completion marker last;
- permit a six-hour database set to reference the latest daily media/mail state only when all capture times are explicit and inside their stated RPO;
- reject incomplete markers, checksum/schema/release mismatch, unrecorded mixed components, or checkpoint/tombstone gaps during restore.

Before every local restore test or real restore, calculate required temporary capacity from the actual selected dump, its measured/restored database size, media/mail artifacts, and documented tool/filesystem overhead. The nominal 15 GB backup/restore workspace is only a starting quota; it does not make a 50 GB database restorable in place. Do not begin when the restore would cross the 70% disk action threshold, the 80% critical threshold, or the required 20% free reserve. Use a separately approved isolated external restore destination or temporary host instead; emergency headroom is never test workspace.

Suggested starting retention:

~~~text
7 daily
4 weekly
6 monthly
~~~

Tune it to legal requirements, available backup storage, and the product’s deletion promises.

### Business-critical upgrade

Before the system contains data that cannot tolerate six hours of loss, add PostgreSQL continuous archiving with pgBackRest or another tested PostgreSQL-native approach:

- scheduled full/differential base backups;
- continuous WAL archive to encrypted off-host storage;
- a target RPO of 5–15 minutes;
- point-in-time recovery;
- automatic freshness/failure alerts;
- quarterly full bare-VPS recovery exercises.

PostgreSQL explains that PITR requires a base backup plus the necessary WAL archive in [continuous archiving and point-in-time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html).

### Restore order

An automated restore **test** is disposable and cannot replay production effects: use non-public networks and isolated paths, sanitized hostnames, no production OAuth/webhook/SMTP/DNS/Internet credentials or egress, and workers/schedulers disabled or connected only to Mailpit/capture. Never start the restored production Stalwart queue against the Internet. Record exact resources and remove only those resources after evidence is retained.

For a real disaster recovery:

1. Provision the clean Ubuntu host in recovery mode with edge/writes closed and the deployment reconciler plus every backup/restore/prune/maintenance timer disabled. Install Docker, the root-owned lock directory, persistent operation journal, and reboot-surviving inhibit marker; then acquire `host-operation` before restoring any mutable state.
2. Restore deployment files and secrets through the reviewed recovery channel.
3. Restore PostgreSQL roles/data plus Stalwart configuration/data and media originals.
4. Start PostgreSQL privately, validate consistency, and run only migrations newer than the restored schema.
5. Before enabling reconciliation or any external effect, fetch the independently protected off-VPS deployment replay checkpoint, create a new approved recovery epoch/floor, invalidate old pending deployment requests/approvals, and install the new root-owned checkpoint. Never trust the restored local high-water mark alone.
6. Authenticate/decrypt and replay every security-tombstone journal record newer than the restored database's recorded high-water mark. Validate its epoch, monotonic sequence, signature, prepare/commit/cancel state, and affected scope. Any missing record, gap, unreadable entry, or unresolved/ambiguous prepared event fails closed: disable the affected account/organization, or all tenant access when scope cannot be proved, until explicit reconciliation. Prove that disabled/deleted accounts, unlinked providers, removed/demoted members, ownership transfers, and deleted organizations cannot regain restored access.
7. Revoke every restored session; invalidate every outstanding restored magic-link/invitation issuance intent regardless of apparent age/state; rotate session, action-link-derivation, and signed-feedback secrets; reissue still-valid pending invitations; and quarantine/reconcile restored outbox, pg-boss, and Stalwart queue events by stable ID. A link consumed before the failure must never become usable again.
8. Reconcile media and validate mail queues with outbound delivery still disabled.
9. Start API/worker against capture-only mail, then web/Caddy on a private test path; run the full smoke/security/isolation checklist.
10. Compare the recovered release/source tree with protected `main`. If recovery intentionally restores an older compatible code tree, keep the sealed manifest as runtime truth, do not force `main` backward, and follow the forward rollback/revert-record rule in `docs/deployment.md`; merge that record back into `dev` before another promotion. Treat any temporary branch/runtime mismatch as a visible incident.
11. Audit the recovery invalidations and notify affected users when warranted.
12. Under explicit approval, enable the reconciler/timers only after the new epoch/floor and branch reconciliation plan are durable off-VPS; then enable Stalwart/external effects, reopen writes, and change DNS.

Document actual measured restore time. That is the real RTO.

## 19. Logs, health, metrics, and alerts

### Day-one observability

Do not run Elasticsearch, OpenSearch, Loki, self-hosted Sentry, or a full tracing cluster in the initial 8 GB dual-environment profile.

Use:

- Fastify/Pino structured JSON logs to stdout;
- Caddy structured access logs with tested query/header/auth-token redaction or sensitive-route exclusion;
- Stalwart and PostgreSQL logs through bounded Docker logging;
- one request/correlation ID across API, jobs, mail events, and media work;
- explicit event names and durations;
- redaction at the logger, not as a manual convention;
- short, documented retention.

Implement:

~~~text
GET /api/health/live
  process is alive; does not restart merely because a dependency is briefly unavailable

GET /api/health/ready
  process can serve core traffic; checks PostgreSQL and required startup state

GET /api/health/dependencies
  protected detailed status for PostgreSQL, Valkey, media, queue, and mail
~~~

The worker should write a heartbeat and last-success timestamp. Optional dependencies can report degraded without forcing a restart storm.

### External checks

At least one monitor must run outside this VPS. Otherwise host, network, DNS, and power loss make the monitor disappear with the application.

Check:

- app HTTPS, status, and certificate expiry;
- a read-only application synthetic transaction;
- DNS resolution;
- SMTP reachability and a periodic end-to-end delivery canary;
- backup age;
- optionally the public object endpoint.

If avoiding monitoring SaaS completely, run the probe from an always-on computer or NAS at another location. An external free/low-cost monitor is a justified exception because the same VPS cannot observe its own disappearance.

### Alerts

Alert at:

- disk or inode use: warning 60%, action required 70%, critical 80%;
- any OOM kill or repeated container restart;
- sustained swap use;
- sustained CPU saturation or load queue;
- API 5xx increase and p95/p99 latency;
- PostgreSQL connection pressure, long transactions, lock waits, replication/archive failure, or slow queries;
- Valkey evictions and memory saturation;
- pg-boss queue age, exhausted jobs, and worker heartbeat;
- media failed processing, quota, or orphan growth;
- Stalwart deferred queue age, bounce/complaint rate, signed-webhook failure/discard age, feedback reconciliation lag, authentication abuse, and mail disk quota;
- backup freshness and restore-test failure;
- certificate expiry.

### Optional heavyweight monitoring profile

Only after day-one signals are insufficient, measured capacity allows it, and the change is separately approved:

- Prometheus with tight local retention;
- node_exporter;
- PostgreSQL and Valkey exporters;
- Alertmanager;
- Grafana;
- optional OpenTelemetry Collector with sampled traces.

Keep every metrics endpoint private. Local monitoring helps diagnosis but still cannot report total host loss, so the external probe remains.

## 20. CI/CD and rollback

If the Git repository is on GitHub, use GitHub Actions and GHCR. GitHub documents [publishing Docker images from Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images). Equivalent repository CI and registry services work with the same design.

### Monorepo pipeline rules

- Install the pnpm workspace once with the frozen root lockfile.
- Changes under packages/contracts can affect both web and server.
- Changes under packages/database affect server tests, migrations, and the server image but must never enter the web image.
- Changes under packages/email or packages/storage affect the server/worker image.
- Changes under infra must run Compose rendering, configuration checks, and relevant smoke tests even when application code did not change.
- Render every authorized phase: development in Prompt 02; base+staging and base+staging+production in Prompt 04; active staging in Prompt 05; exact-digest production promotion in Prompt 06; and optional overlays only after separate approval. Policy-test cross-environment references and prevent inactive overlays from activating implicitly.
- Build web and server with separate multi-stage Dockerfiles and a strict root .dockerignore.
- Label both images with the Git SHA and source repository.
- Record one deterministic host activation manifest containing a separate application-payload digest, source Git SHA, web/server digests, schema transition, and rendered-configuration digest for each active environment, plus the shared-infrastructure-payload/configuration digests and infrastructure commit. Record request/activation time in the signed external deployment envelope and immutable outcome checkpoint, not as a renderer-varying manifest input. When only one environment changes, copy the other environment block and shared payload digest unchanged from the prior manifest.
- A monorepo allows a coordinated release but does not require rebuilding an unaffected image; path-aware CI may reuse the previously tested digest.
- Never use path filtering to skip a shared-package, migration, secret-scan, or infrastructure validation that could affect the deployment.

### Pull request pipeline

1. Frozen pnpm install.
2. Formatting, lint, and TypeScript checks.
3. Unit tests.
4. Integration tests with fresh PostgreSQL and Valkey.
5. Test migrations from an empty database and a previous-schema fixture.
6. Build minimal non-root server and web images.
7. Dependency, secret, and image scan; SBOM.
8. End-to-end magic-link/session/logout test plus mocked Google callback and account-linking tests; prove password routes are absent.
9. Socket reconnect test.
10. Outbox dispatch, pg-boss runtime-permission, retry, and idempotency tests with runtime migrations disabled.
11. SMTP test against a non-delivering test server plus signed/replayed/duplicate Stalwart feedback fixtures.
12. Always test the storage adapter contract, mount permissions, and Caddy denial of private/non-variant paths. Add media upload, Sharp limit, public/private delivery, deletion, and reconciliation tests only after an approved media feature exists.
13. Start the standalone Next.js image read-only and prove SSR, restart, and navigation work without ISR or image-cache writes.

### Staging and production pipeline

1. Merge feature work by protected pull request into `dev`; build/test in CI, never on the VPS.
2. Push images tagged with the immutable Git SHA.
3. Resolve image digests and generate/attest the immutable application payload. For the first staging release, reproduce the exact deterministic Prompt 04 shared-infrastructure bytes, require the approved local checksum/inventory, independently attest and publish them as an immutable GHCR OCI artifact, then verify the registry/download digest. Later releases reference that unchanged artifact unless a separate host-wide change is approved. Sign the staging activation manifest and create a Deployment request for the protected `dev` SHA.
4. Let the root-owned VPS reconciler poll outbound, verify/signature-check, seal base+staging, migrate staging, activate, run host-local smoke checks, and report status.
5. Record staging source SHA, shared-infrastructure/application-payload/activation-manifest/image/configuration digests, schema, test evidence, resource state, and rollback target.
6. For production, require the separate protected GitHub production Environment approval, preserve the current staging block, reuse its application-payload/image digests without rebuilding in the production block, keep the shared-infrastructure payload unchanged, and create a new signed production activation manifest.
7. Seal base+staging+production, preserving the active staging block; run production migration and activate through the same fixed wrappers.
8. Complete production auth/isolation/mail/backup/monitoring/rollback checks and report deployment success.
9. Fast-forward protected `main` to the staged source SHA only after production success. A failed activation leaves it unchanged; later rollback is recorded by a reviewed forward rollback/revert commit, never a force-push.
10. Open production publicly only after separate approval.

Do not install a privileged general-purpose self-hosted CI runner, expose Docker, or open SSH to dynamic GitHub-hosted runner ranges. The reconciler uses separate least-privilege GitHub deployment-status and read-only GHCR credentials and cannot write repository contents or execute arbitrary shell.

### Rollback

- The first production release has no previous production application image, even though a staging-only host release already exists. Rehearse stopping only production web/API/worker and returning to the restricted no-production-app state without deleting initialized production data, schema, mail state, or backups.
- From the second production release onward, keep previous tested production environment blocks and image/application-payload digests. A production application rollback creates a new signed host activation manifest that preserves current staging and shared infrastructure, replaces only production with the previous compatible block, and reruns health/smoke tests. Never reactivate an old whole-host manifest.
- If the previous production block is incompatible with the current shared-infrastructure payload or schema, stop for an explicit multi-environment recovery plan.
- Do not blindly reverse database migrations.
- Use expand–migrate–contract changes so both application versions can read the transitional schema.
- Restore data from backup/PITR only for an actual data event, not as an ordinary code rollback.
- Practice the first-production-release restricted/no-production-app rollback before public launch; practice prior-production-digest rollback from the second production release onward.

## 21. Capacity plan

### Combined RAM budget for 8 GB

| Consumer | Suggested cap/budget |
|---|---:|
| Ubuntu, Docker, kernel, page cache, maintenance, safety reserve | at least 3.5–4 GB available outside service caps |
| shared Caddy | 96 MB |
| staging PostgreSQL / Valkey / web / API / worker / Mailpit | 384 / 128 / 256 / 256 / 192 / 128 MB |
| production PostgreSQL / Valkey / web / API / worker / Stalwart | 768 / 256 / 384 / 384 / 256 / 512 MB |

The service caps total roughly 3.9 GB. They are ceilings, not reservations, and database/cache internal settings must fit inside them. Measure combined staging+production load, migrations, backup/restore, and worst-approved media work.

Investigate and resize/optimize when any remains true under normal load:

- RAM above 70%, with sustained 75%+ urgent;
- swap active for sustained normal-load periods;
- any OOM or repeated restart;
- CPU above roughly 60–70% for long periods;
- queue delay or database latency violates the product target;
- fewer than 20% disk headroom.

Do not add SeaweedFS, ClamAV, Prometheus/Grafana, public mailbox mode, API replicas, or video transcoding simply because the plan begins at 8 GB.

### Disk budget for 256 GB

These are monitored quotas/growth allowances, not partitions:

| Use | Initial planning allowance |
|---|---:|
| OS, packages, bounded logs, Docker images/releases | 40 GB |
| production PostgreSQL | 50 GB |
| staging PostgreSQL and test state | 12 GB |
| production media originals/variants | 55 GB |
| staging media | 10 GB |
| Stalwart config/queues/operational mail | 12 GB |
| bounded local backup/restore workspace | 15 GB |
| emergency/growth reserve | 62 GB |

Do not preallocate these amounts or let one subsystem consume another's reserve. Alert at 60%, act at 70%, treat 80% as critical, enforce media/mail/log quotas, and keep at least 20% free. The durable Restic repository is outside Netcup.

### 16 GB profile

- Add more page cache before aggressively raising every service limit.
- Run two API replicas and separate job queues/concurrency by workload.
- Add PgBouncer only if measured connections justify it.
- Move large media to S3 mode if filesystem delivery is becoming a bottleneck.
- Keep the modular monolith unless organizational boundaries, not traffic alone, justify a service split.
- Remember that this remains one-host capacity, not availability.

## 22. Scaling path

### Stage A: small launch

~~~text
shared Caddy
reduced staging: 1 web + 1 API + 1 worker + PostgreSQL + Valkey + Mailpit
production: 1 web + 1 API + 1 worker + PostgreSQL + Valkey + Stalwart
separate local media roots
~~~

### Stage B: vertical resize

~~~text
larger compatible Netcup plan or replacement VPS
larger DB/page-cache headroom
worker queues separated by workload
optional S3/monitoring only after measured need
~~~

Do not assume every Netcup upgrade is in-place, cross-generation/location compatible, or IP-preserving. Check the current upgrade matrix; otherwise provision a new server and use the migration runbook.

### Stage C: multiple processes on the same VPS

~~~text
Caddy
  -> API replica 1
  -> API replica 2

Valkey Redis Streams adapter
shared PostgreSQL
one or more workers
~~~

This improves throughput and allows less disruptive container replacement. It does not survive host failure.

### Stage D: serious production, when another host becomes possible

A sensible first separation is:

1. move Stalwart to a dedicated IP/host to isolate reputation, public mail attack surface, queue disk, and maintenance;
2. move PostgreSQL to a dedicated host or managed service if availability and recovery demand it;
3. move object storage off the app disk;
4. run at least two app hosts behind a load balancer;
5. add database replication and a tested failover procedure;
6. consider Kubernetes only if several hosts and the operating team make its scheduler/control plane worthwhile.

The present containers, protocols, SQL migrations, S3 adapter, and backups make these moves incremental.

## 23. Migration to another VPS provider

The application stack is portable, but the state and mail IP identity require a planned cutover.

### Normal migration

1. Lower relevant DNS TTLs 24–48 hours before the cutover.
2. Provision the new Ubuntu VPS and repeat the documented host setup.
3. Install the same tested Docker/Compose generation.
4. Deploy the exact Compose files and image digests.
5. Restore secrets securely.
6. Restore PostgreSQL into the new host.
7. Copy/restore media and Stalwart through the backup mechanism.
8. Start the new stack privately and run the smoke suite.
9. Put the old application into a brief read-only/maintenance mode.
10. Take a final database dump and media/mail delta.
11. Restore the final delta and validate counts/checksums.
12. Change app/storage A records.
13. Monitor both hosts during DNS propagation.
14. Retain the old VPS, powered and isolated, until the rollback window ends.

An offline Netcup snapshot may help with a Netcup-to-Netcup maintenance rollback, but it is not the portable migration mechanism. The provider-independent path is immutable images/Compose/Ansible plus restored PostgreSQL, media, mail state, and configuration from the off-Netcup recovery set. Never assume the assigned Netcup IP can move to another provider or location.

### Mail-specific migration

Mail cannot be moved as invisibly as an HTTP container:

- the new IP needs a new PTR;
- SPF must include the new IP during overlap;
- IP reputation does not migrate;
- DKIM keys can remain if restored securely and DNS remains valid;
- the MX can have temporary old/new priorities during the planned transition;
- delivery queues must be drained or transferred;
- the new IP must be warmed and tested.

Do not cancel the old VPS until queued mail, DNS, and reputation checks are complete.

### Why the storage adapter matters

Filesystem-to-S3 migration becomes:

1. create the S3 bucket and scoped credentials;
2. copy every storage_key to the same logical key;
3. verify sizes and SHA-256;
4. switch the adapter configuration;
5. reconcile missing/orphan objects;
6. retain the old copy through the rollback window.

Business tables and URLs do not need to change when the storage key remains stable.

## 24. Other things the project needs

These are frequently missing from an “all the containers” list but matter more than another service.

### Add on day one

- database migrations and least-privilege roles;
- an audit-log model;
- request IDs and log redaction;
- liveness/readiness endpoints;
- an external uptime check;
- tested encrypted off-host backups;
- a rollback runbook;
- a storage interface and public/private mount boundary; media quotas, upload validation, deletion, and orphan reconciliation become mandatory only when a user-facing media feature is separately approved;
- job idempotency, retries, dead-letter handling, and queue-age alerts;
- mail DNS, bounce suppression, deliverability monitoring, and quotas;
- passwordless magic-link delivery, Google login, account-linking safeguards, and `owner`/`editor`/`member` authorization;
- API pagination, size limits, versioning, and consistent errors;
- dependency/image scanning and pinned releases;
- an immediate access-revoking organization deletion state with permanent purge disabled until separate lifecycle/privacy requirements exist;
- a maintenance window and incident contacts;
- an inventory of domains, DNS records, secrets, certificates, and owners.

### Use PostgreSQL features before adding services

- PostgreSQL full-text search and pg_trgm before Elasticsearch/OpenSearch;
- normal SQL aggregates before a separate analytics database;
- advisory locks and pg-boss before a distributed coordinator;
- JSONB only for genuinely flexible fields, not as a replacement for a schema;
- database-backed feature flags before a dedicated feature-flag service;
- owner-facing product management screens before any always-public database dashboard.

### Add only after evidence

| Addition | Trigger |
|---|---|
| SeaweedFS/S3 | direct presigned/multipart uploads, storage API portability, or large-file requirements |
| second API process | measured CPU/latency or rolling-deploy need |
| Socket.IO Valkey adapter | before second API process |
| PgBouncer | measured connection pressure |
| ClamAV worker | arbitrary untrusted document uploads |
| Prometheus/Grafana | simpler health/log/host signals are insufficient and measured headroom or a separate monitoring host has been approved |
| CDN/WAF | bandwidth, geography, or abuse justifies the managed edge dependency |
| dedicated search | PostgreSQL search is proven inadequate |
| second VPS | availability, reputation, recovery, or disk isolation becomes necessary |

### Deliberately omit

- Kubernetes/k3s on one host;
- Kong, APISIX, or Envoy for one API;
- RabbitMQ, NATS, Kafka, or Redis queues while pg-boss is sufficient;
- Keycloak or Authentik while Better Auth meets the product requirements;
- Centrifugo or another realtime server while Socket.IO in Fastify is sufficient;
- Redis/Valkey Sentinel or Cluster on one host;
- Elasticsearch/OpenSearch for initial search;
- self-hosted Sentry, ELK, Wazuh, or a long-retention Loki stack in the initial 8 GB dual-environment profile;
- Vault/Infisical for one host when carefully protected files and encrypted offline recovery are enough;
- Watchtower and unattended latest-tag upgrades;
- public database/mail/object/admin dashboards;
- backups that never leave the VPS.

## 25. Production acceptance checklist

The first production release is ready only when all applicable checks pass. It may have a staging-only host release as its predecessor.

### Host

- [ ] Netcup RS 1000 G12 x86 server ID/location and IPv4+IPv6 assignment match the order
- [ ] SCP/CCP, console, and rescue access tested; Ubuntu image/custom-ISO source recorded
- [ ] Ubuntu fully patched and reboot state clean
- [ ] named sudo user and key-only SSH tested
- [ ] root/password SSH disabled after second-session verification
- [ ] Netcup identity verification and, when required, DPA/account owners recorded
- [ ] time synchronization correct
- [ ] 2 GB emergency swap configured and monitored
- [ ] Docker installed from official repository
- [ ] Docker logs bounded
- [ ] Netcup SCP and Docker-aware host firewalls externally scanned
- [ ] Netcup abuse-notice response owner and account-email monitoring recorded

### Deployment

- [ ] one monorepo contains web, server, shared packages, migrations, infrastructure, tests, CI/CD, and runbooks
- [ ] base+development, base+staging, and base+staging+production render successfully
- [ ] Prompt 05 manifest activates base+staging only and records `production: null`
- [ ] Prompt 06 manifest activates base+staging+production, preserves staging, and uses the exact staging-tested production digests
- [ ] staging and production use different service keys, paths, volumes, domains, OAuth applications, mail identities, credentials, and networks; only the documented host-level release control plane/Docker project and Caddy are shared
- [ ] staging cannot reference production state/secrets and production activation does not silently change staging
- [ ] a deferred mailbox or S3 overlay renders only after its own approval and is absent from the first-release active composition
- [ ] pnpm lockfile and reviewed database migrations are committed
- [ ] real secrets, runtime data, media, mail state, certificates, logs, dumps, and backups are absent from Git
- [ ] web and server Docker build contexts exclude unrelated files and secrets
- [ ] every image pinned by tested patch and digest
- [ ] no latest tags
- [ ] Compose config validation passes
- [ ] no Docker socket mounts
- [ ] only intended host ports published
- [ ] app containers non-root/read-only where supported
- [ ] the first production release has a rehearsed restricted/no-production-app rollback; previous production image digests are retained from the second production release onward
- [ ] the rollback appropriate to the release number is practiced without destructive schema/data reversal
- [ ] protected `dev` is the staging source; protected `main` advances only after verified production and no environment branches exist
- [ ] GitHub-hosted runners have no inbound SSH; the outbound reconciler rejects unsigned/replayed/wrong-branch releases

### Database, cache, and jobs

- [ ] separate migration/API/worker/backup roles
- [ ] API can write application outbox rows but cannot access pg-boss
- [ ] worker can perform tested pg-boss runtime operations but cannot create/migrate its schema
- [ ] PostgreSQL and Valkey not public
- [ ] migrations tested from empty and previous schema
- [ ] connection pools fit the connection budget
- [ ] Valkey flush does not lose business state
- [ ] job retry/idempotency/dead-letter behavior tested
- [ ] scheduled cleanup and reconciliation tested

### Auth and API

- [ ] exact production origin and proxy trust
- [ ] Secure, HttpOnly, host-only cookies
- [ ] CSRF/origin protection enabled
- [ ] magic-link request is non-enumerating; token hash-at-rest, ten-minute expiry, single use, concurrent consume/replay rejection, and logout are tested
- [ ] Google callback and account-linking safeguards tested
- [ ] password sign-up, sign-in, storage, and reset routes are absent
- [ ] `owner`, `editor`, and `member` tests include exact editor/member invitation powers, last-owner protection, and forbidden cross-user/cross-workspace access; no generic app-admin role exists
- [ ] sensitive ownership/provider changes require recent authentication and revoke affected sessions
- [ ] request limits, rate limits, and idempotency tested
- [ ] logs contain IDs but no secrets/tokens/cookies
- [ ] sentinel magic-link/OAuth/query/cookie/authorization values are absent from both Caddy and application logs

### Media and storage boundary

- [ ] PostgreSQL stores metadata, not ordinary media bytes
- [ ] Caddy mounts and serves only each environment's `/srv/myapp/<environment>/media/public/variants` path at that hostname's `/media/*`; every file is content-hashed
- [ ] incoming, private, trash, staging, traversal, and dotfile requests fail through Caddy
- [ ] filesystem and future-S3 adapters satisfy the storage contract without exposing an application-specific upload UI
- [ ] if a user-facing media feature is later enabled, streaming, type/magic-byte/size/pixel limits, private authorization, metadata stripping, variants, deletion, orphan cleanup, quotas, and disk alerts are tested before that feature launches

### Realtime

- [ ] reconnect and missed-event refetch tested
- [ ] durable data exists before event publication
- [ ] worker-to-API invalidation uses separate Valkey ACL identities and contains no private record body
- [ ] event authorization prevents cross-user leakage
- [ ] replica-2 prerequisites documented

### Mail

- [ ] Netcup transactional-only policy evidence and assigned-IP reputation check recorded
- [ ] `netcup Mail block` stayed enabled through staging and its Prompt 06 removal was separately approved/recorded
- [ ] Netcup inbound/outbound TCP 25 and SCP PTR confirmed
- [ ] Cloudflare mail records are DNS-only
- [ ] forward/reverse DNS and EHLO agree
- [ ] SPF, DKIM, and DMARC pass
- [ ] TLS certificate valid on mail protocols
- [ ] internal SMTP uses `<MAIL_HOSTNAME>` with matching DNS alias, TLS verification, and SNI
- [ ] server is not an open relay
- [ ] recovery admin removed
- [ ] Stalwart management listener binds only to the fixed `production-mail-admin` address, has no Caddy/host route, accepts the approved admin path, and rejects API/worker-network sources
- [ ] operational mailboxes are retrievable only through the approved loopback-IMAPS SSH/VPN path with `<MAIL_HOSTNAME>` certificate validation; public 993 remains closed
- [ ] HMAC-signed internal feedback rejects bad/replayed signatures and deduplicates event IDs
- [ ] only required mail ports public
- [ ] bounce and hard-suppression flow tested
- [ ] delivery tested to several major providers
- [ ] marketing, newsletters, campaigns, broadcasts, bulk mail, and end-user mailbox hosting are absent
- [ ] launch mailbox/domain/message quotas, no-silent-deletion handling, and 70%/85% alerts are tested; any changed quota/retention policy has explicit approval

### Recovery and operations

- [ ] first encrypted backup stored outside Netcup; any Netcup snapshot is labeled supplemental
- [ ] PostgreSQL restore tested
- [ ] media restore and checksum reconciliation tested
- [ ] Stalwart restore tested
- [ ] secrets/DKIM recovery tested
- [ ] backup-age alert tested
- [ ] external uptime monitor active
- [ ] deploy, rollback, restore, mail, and incident runbooks reviewed
- [ ] RPO and measured RTO recorded

## 26. Short decision recap

- **OS:** keep Ubuntu 26.04 LTS.
- **Repository:** one pnpm monorepo for web, server, shared packages, infrastructure, tests, CI/CD, and runbooks.
- **Images:** one web image plus one server image reused by API, worker, and one-shot migration services.
- **Repository boundary:** source and deployment recipes in Git; production secrets and live state under /etc/myapp and /srv/myapp.
- **Orchestration:** Docker Engine + Compose, not Kubernetes or Podman for this one-host phase.
- **Backend:** Node 24 LTS, TypeScript, Fastify, Drizzle, modular monolith.
- **Auth:** Better Auth in Fastify with PostgreSQL sessions, passwordless magic links, Google OAuth, and `owner`/`editor`/`member` authorization; no password authentication or generic app-admin role.
- **Gateway:** Caddy at the edge; no Kong/APISIX.
- **Database:** PostgreSQL.
- **Cache:** Valkey with separate API, worker, and health ACL identities; disposable state only.
- **Queue:** application transactional outbox, worker-owned pg-boss runtime, and migration-owned pg-boss DDL.
- **Realtime:** Socket.IO in the API, a narrow worker-to-API Valkey invalidation channel, and the Valkey adapter before replica 2.
- **Host/provider:** Netcup RS 1000 G12 x86, 8 GB/256 GB, IPv4+IPv6; Cloudflare remains authoritative DNS.
- **Environments/branches:** reduced staging starts first from protected `dev`; production manually promotes the exact staged bytes; `main` advances only after verified production; no environment branches.
- **Deployment transport:** a root-owned outbound reconciler pulls approved attested releases; GitHub-hosted runners do not SSH to the VPS.
- **Mail:** Stalwart handles only low-volume transactional/account delivery plus named operational mailboxes, with private management, signed feedback, correct TLS/SNI and Netcup/Cloudflare PTR/SPF/DKIM/DMARC gates; bulk/marketing/end-user mailbox hosting is excluded.
- **Media:** per-environment public/private filesystem roots now; only public variants mounted into Caddy; metadata in PostgreSQL; optional SeaweedFS/S3 only after proven need and approved capacity.
- **Backups:** encrypted Restic repository outside Netcup, with tested restores; provider snapshots are supplemental.
- **Scaling:** vertical first; API replicas on the same VPS later; multi-host only when availability becomes a real requirement.
