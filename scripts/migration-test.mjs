import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLocalDockerInvocation,
  formatLocalDockerCommand,
  spawnLocalDocker,
} from "./local-docker.mjs";
import { withAppVersionEnvironment } from "./app-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = `esmii-migration-test-${randomBytes(4).toString("hex")}`;
const envPath = join(root, "infra", ".env.development.local");
const composeFiles = [
  join(root, "infra", "compose.yaml"),
  join(root, "infra", "compose.development.yaml"),
];
const docker = createLocalDockerInvocation({ environment: withAppVersionEnvironment() });

const baseArguments = ["compose", "--project-name", projectName, "--env-file", envPath];
for (const file of composeFiles) baseArguments.push("-f", file);

function compose(arguments_, options = {}) {
  const commandArguments = [...baseArguments, ...arguments_];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, commandArguments)}`);
  return spawnLocalDocker(docker, commandArguments, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

function requireSuccess(label, result) {
  if (result.status !== 0) {
    const diagnostic = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    const suffix = diagnostic.length > 0 ? `\n${diagnostic}` : "";
    throw new Error(`${label} failed with status ${result.status ?? "unknown"}${suffix}`);
  }
}

function requireFailure(label, result) {
  if (result.status === 0) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
}

function requireQueryResult(label, query, expected) {
  const result = compose(
    [
      "exec",
      "-T",
      "development-postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "esmii",
      "-At",
      "--set=ON_ERROR_STOP=1",
      "-c",
      query,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  requireSuccess(label, result);
  if (result.stdout.trim() !== expected) {
    throw new Error(`${label} returned an unexpected result`);
  }
}

function requirePermissionDenied(label, arguments_) {
  const result = compose(arguments_, { encoding: "utf8", stdio: "pipe" });
  requireFailure(label, result);
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!diagnostic.includes("42501")) {
    throw new Error(`${label} failed for a reason other than PostgreSQL permission denial`);
  }
}

function postgresRoleCommand(role, secretFile, query) {
  const roleScript = String.raw`
secret_file="$1"
shift
PGPASSWORD="$(cat "$secret_file")"
export PGPASSWORD
exec psql -h 127.0.0.1 -U "${role}" -d esmii -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"
`;
  return compose(
    [
      "exec",
      "-T",
      "development-postgres",
      "sh",
      "-eu",
      "-c",
      roleScript,
      "esmii-postgres-role-test",
      `/run/secrets/${secretFile}`,
      "-c",
      query,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
}

function requireRoleQueryResult(label, role, secretFile, query, expected) {
  const result = postgresRoleCommand(role, secretFile, query);
  requireSuccess(label, result);
  const outputLines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (outputLines.at(-1) !== expected) {
    throw new Error(`${label} returned an unexpected result`);
  }
}

function requireRoleSqlState(label, role, secretFile, query, expectedSqlState) {
  const result = postgresRoleCommand(role, secretFile, query);
  requireFailure(label, result);
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!diagnostic.includes(expectedSqlState)) {
    throw new Error(`${label} did not fail with PostgreSQL SQLSTATE ${expectedSqlState}`);
  }
}

function requireAdminQuerySuccess(label, query) {
  const result = compose(
    [
      "exec",
      "-T",
      "development-postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "esmii",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-c",
      query,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  requireSuccess(label, result);
}

const valkeyCommandScript = String.raw`
role="$1"
credential_source="$2"
shift 2

case "$credential_source" in
  acl)
    password="$(awk -v requested_role="$role" '
      $1 == "user" && $2 == requested_role {
        for (field = 1; field <= NF; field += 1) {
          if (substr($field, 1, 1) == ">") {
            print substr($field, 2)
            exit
          }
        }
      }
      ' /run/secrets/valkey_users_acl)"
    ;;
  health)
    IFS= read -r password < /run/secrets/valkey_health_password
    ;;
  *)
    exit 64
    ;;
esac

if [ -z "$password" ]; then
  exit 65
fi

VALKEYCLI_AUTH="$password" valkey-cli --user "$role" --raw "$@"
`;

function runValkeyCommand(role, credentialSource, command) {
  return compose(
    [
      "exec",
      "-T",
      "development-valkey",
      "sh",
      "-eu",
      "-c",
      valkeyCommandScript,
      "esmii-valkey-acl-test",
      role,
      credentialSource,
      ...command,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
}

function requireValkeyResponse(label, role, credentialSource, command, expected) {
  const result = runValkeyCommand(role, credentialSource, command);
  requireSuccess(label, result);
  if (result.stdout.trim() !== expected || result.stderr.trim().length > 0) {
    throw new Error(`${label} returned an unexpected result`);
  }
}

function requireValkeyPermissionDenied(label, role, credentialSource, command) {
  const result = runValkeyCommand(role, credentialSource, command);
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!diagnostic.includes("NOPERM")) {
    throw new Error(`${label} did not return Valkey permission denial`);
  }
}

function requireRuntimeConnection(label, role, secretFile) {
  const result = compose(
    [
      "exec",
      "-T",
      "development-postgres",
      "sh",
      "-eu",
      "-c",
      [
        `PGPASSWORD="$(cat /run/secrets/${secretFile})"`,
        `psql -h 127.0.0.1 -U ${role} -d esmii -At --set=ON_ERROR_STOP=1`,
        `-c "SELECT current_user || ':' || has_schema_privilege(current_user, 'app', 'USAGE')::text"`,
      ].join(" "),
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  requireSuccess(label, result);
  if (result.stdout.trim() !== `${role}:true`) {
    throw new Error(`${label} returned an unexpected result`);
  }
}

const roleCannotCreateTable = (role, secretFile, tableName) => [
  "exec",
  "-T",
  "development-postgres",
  "sh",
  "-eu",
  "-c",
  [
    `PGPASSWORD="$(cat /run/secrets/${secretFile})"`,
    `psql -h 127.0.0.1 -U ${role} -d esmii -v ON_ERROR_STOP=1 -v VERBOSITY=verbose`,
    `-c 'CREATE TABLE app.${tableName} (id bigint PRIMARY KEY)'`,
  ].join(" "),
];

let failed = false;

try {
  requireSuccess(
    "isolated PostgreSQL and Valkey startup",
    compose(["up", "-d", "--wait", "development-postgres", "development-valkey"]),
  );
  requireSuccess("migration image build", compose(["build", "development-api"]));
  requireSuccess(
    "empty-database migration",
    compose(["run", "--rm", "--no-deps", "development-migrate"]),
  );
  requireSuccess("repeat migration", compose(["run", "--rm", "--no-deps", "development-migrate"]));

  requireQueryResult(
    "migration state verification",
    "SELECT (to_regnamespace('app') IS NOT NULL AND to_regclass('drizzle.schema_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'))::text",
    "true",
  );
  requireQueryResult(
    "Prompt 03 table-set verification",
    `SELECT (ARRAY[
      'account', 'action_link_issuance_intents', 'audit_events', 'delivery_attempts',
      'invitation', 'invitation_continuations', 'member', 'operation_idempotency',
      'organization', 'outbox_events', 'security_tombstone_mutations',
      'security_tombstone_state', 'session', 'user', 'verification'
    ]::text[] <@ ARRAY(
      SELECT table_name::text FROM information_schema.tables WHERE table_schema = 'app'
    ))::text`,
    "true",
  );
  requireQueryResult(
    "Better Auth stock column compatibility",
    `SELECT (ARRAY[
      'user.id', 'user.email', 'user.emailVerified', 'account.issuer', 'account.accountId',
      'account.providerId', 'session.token', 'session.activeOrganizationId',
      'verification.identifier', 'organization.slug', 'member.role',
      'invitation.inviterId', 'invitation_continuations.action_intent_id'
    ]::text[] <@ ARRAY(
      SELECT table_name || '.' || column_name
        FROM information_schema.columns
       WHERE table_schema = 'app'
    ))::text`,
    "true",
  );
  requireQueryResult(
    "Better Auth required-column and issuer-identity compatibility",
    `SELECT (
      NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'app'
           AND table_name = 'verification'
           AND column_name IN ('createdAt', 'updatedAt')
           AND is_nullable <> 'NO'
      )
      AND (
        SELECT count(*) = 2
          FROM information_schema.columns
         WHERE table_schema = 'app'
           AND table_name = 'verification'
           AND column_name IN ('createdAt', 'updatedAt')
      )
      AND EXISTS (
        SELECT 1
          FROM pg_indexes
         WHERE schemaname = 'app'
           AND tablename = 'account'
           AND indexname = 'account_issuer_identity_unique'
           AND indexdef LIKE '%UNIQUE%issuer%accountId%'
      )
    )::text`,
    "true",
  );
  requireQueryResult(
    "RFC Message-ID storage type",
    `SELECT (count(*) = 2 AND bool_and(data_type = 'text'))::text
       FROM information_schema.columns
      WHERE table_schema = 'app'
        AND column_name = 'stable_message_id'
        AND table_name IN ('action_link_issuance_intents', 'delivery_attempts')`,
    "true",
  );
  requireQueryResult(
    "runtime schema-grant verification",
    "SELECT (has_schema_privilege('app_api', 'app', 'USAGE') AND NOT has_schema_privilege('app_api', 'app', 'CREATE') AND has_schema_privilege('app_worker', 'app', 'USAGE') AND NOT has_schema_privilege('app_worker', 'app', 'CREATE') AND has_schema_privilege('backup_reader', 'app', 'USAGE') AND NOT has_schema_privilege('backup_reader', 'app', 'CREATE'))::text",
    "true",
  );
  requireQueryResult(
    "runtime role-matrix verification",
    `SELECT (
      has_table_privilege('app_api', 'app.user', 'SELECT')
      AND has_table_privilege('app_api', 'app.user', 'INSERT')
      AND has_table_privilege('app_api', 'app.user', 'UPDATE')
      AND NOT has_table_privilege('app_api', 'app.user', 'DELETE')
      AND has_table_privilege('app_api', 'app.audit_events', 'SELECT')
      AND NOT has_table_privilege('app_api', 'app.audit_events', 'UPDATE')
      AND NOT has_table_privilege('app_api', 'app.audit_events', 'DELETE')
      AND has_table_privilege('app_worker', 'app.action_link_issuance_intents', 'SELECT')
      AND has_table_privilege('app_worker', 'app.invitation', 'SELECT')
      AND NOT has_table_privilege('app_worker', 'app.invitation', 'UPDATE')
      AND has_column_privilege('app_worker', 'app.invitation', 'updatedAt', 'UPDATE')
      AND NOT has_column_privilege('app_worker', 'app.invitation', 'status', 'UPDATE')
      AND has_table_privilege('app_worker', 'app.verification', 'SELECT')
      AND has_table_privilege('app_worker', 'app.verification', 'INSERT')
      AND NOT has_table_privilege('app_worker', 'app.verification', 'UPDATE')
      AND NOT has_table_privilege('app_worker', 'app.verification', 'DELETE')
      AND NOT has_table_privilege('app_worker', 'app.user', 'SELECT')
      AND NOT has_table_privilege('app_worker', 'app.user', 'INSERT')
      AND NOT has_table_privilege('app_worker', 'app.user', 'UPDATE')
      AND NOT has_table_privilege('app_worker', 'app.user', 'DELETE')
      AND has_table_privilege('app_api', 'app.security_tombstone_state', 'SELECT')
      AND NOT has_table_privilege('app_api', 'app.security_tombstone_state', 'INSERT')
      AND has_column_privilege('app_api', 'app.security_tombstone_state', 'contiguous_high_water', 'UPDATE')
      AND has_column_privilege('app_api', 'app.security_tombstone_state', 'access_closed', 'UPDATE')
      AND NOT has_column_privilege('app_api', 'app.security_tombstone_state', 'environment', 'UPDATE')
      AND NOT has_column_privilege('app_api', 'app.security_tombstone_state', 'epoch', 'UPDATE')
      AND has_table_privilege('backup_reader', 'app.user', 'SELECT')
      AND NOT has_table_privilege('backup_reader', 'app.user', 'INSERT')
      AND NOT has_table_privilege('backup_reader', 'app.user', 'UPDATE')
      AND NOT has_table_privilege('backup_reader', 'app.user', 'DELETE')
      AND NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'backup_reader')
    )::text`,
    "true",
  );
  requireQueryResult(
    "pg-boss runtime isolation verification",
    `SELECT (
      to_regnamespace('pgboss') IS NOT NULL
      AND NOT has_schema_privilege('app_api', 'pgboss', 'USAGE')
      AND has_schema_privilege('app_worker', 'pgboss', 'USAGE')
      AND NOT EXISTS (
        SELECT 1
          FROM information_schema.tables
         WHERE table_schema = 'pgboss'
           AND (
             has_table_privilege('app_api', format('%I.%I', table_schema, table_name), 'SELECT')
             OR has_table_privilege('app_api', format('%I.%I', table_schema, table_name), 'INSERT')
             OR has_table_privilege('app_api', format('%I.%I', table_schema, table_name), 'UPDATE')
             OR has_table_privilege('app_api', format('%I.%I', table_schema, table_name), 'DELETE')
           )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM information_schema.tables
         WHERE table_schema = 'pgboss'
           AND NOT (
             has_table_privilege('app_worker', format('%I.%I', table_schema, table_name), 'SELECT')
             AND has_table_privilege('app_worker', format('%I.%I', table_schema, table_name), 'INSERT')
             AND has_table_privilege('app_worker', format('%I.%I', table_schema, table_name), 'UPDATE')
             AND has_table_privilege('app_worker', format('%I.%I', table_schema, table_name), 'DELETE')
           )
      )
    )::text`,
    "true",
  );

  requireRuntimeConnection(
    "API runtime-role connection",
    "app_api",
    "development_postgres_api_password",
  );
  requireRuntimeConnection(
    "worker runtime-role connection",
    "app_worker",
    "development_postgres_worker_password",
  );

  requirePermissionDenied(
    "API runtime-role DDL denial",
    roleCannotCreateTable("app_api", "development_postgres_api_password", "forbidden_api_ddl"),
  );
  requireQueryResult(
    "API forbidden-table absence",
    "SELECT (to_regclass('app.forbidden_api_ddl') IS NULL)::text",
    "true",
  );
  requirePermissionDenied(
    "worker runtime-role DDL denial",
    roleCannotCreateTable(
      "app_worker",
      "development_postgres_worker_password",
      "forbidden_worker_ddl",
    ),
  );
  requireQueryResult(
    "worker forbidden-table absence",
    "SELECT (to_regclass('app.forbidden_worker_ddl') IS NULL)::text",
    "true",
  );

  requireAdminQuerySuccess(
    "Prompt 03 synthetic fixture setup",
    `BEGIN;
     INSERT INTO app."user" (id, name, email, "emailVerified") VALUES
       ('synthetic-owner', 'Synthetic Owner', 'owner@example.test', true),
       ('synthetic-editor', 'Synthetic Editor', 'editor@example.test', true),
       ('synthetic-member', 'Synthetic Member', 'member@example.test', true);
     INSERT INTO app.organization (id, name, slug)
       VALUES ('synthetic-org', 'Synthetic Organization', 'synthetic-organization');
     INSERT INTO app.member (id, "organizationId", "userId", role) VALUES
       ('synthetic-owner-membership', 'synthetic-org', 'synthetic-owner', 'owner'),
       ('synthetic-editor-membership', 'synthetic-org', 'synthetic-editor', 'editor');
     COMMIT;`,
  );

  requireRoleSqlState(
    "canonical email constraint",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app."user" (id, name, email)
     VALUES ('invalid-email-user', 'Invalid Email', 'invalid@@example.test')`,
    "23514",
  );
  requireRoleSqlState(
    "exact membership-role constraint",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.member (id, "organizationId", "userId", role)
     VALUES ('invalid-role-membership', 'synthetic-org', 'synthetic-member', 'admin')`,
    "23514",
  );
  requireRoleSqlState(
    "seven-day invitation upper bound",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.invitation (
       id, "organizationId", email, role, status, "expiresAt", "inviterId"
     ) VALUES (
       'too-long-invitation', 'synthetic-org', 'invitee@example.test', 'member',
       'pending', statement_timestamp() + interval '7 days 1 second', 'synthetic-owner'
     )`,
    "23514",
  );
  requireRoleQueryResult(
    "pending invitation fixture",
    "app_api",
    "development_postgres_api_password",
    `WITH inserted AS (
       INSERT INTO app.invitation (
         id, "organizationId", email, role, status, "expiresAt", "inviterId"
       ) VALUES (
         'pending-invitation', 'synthetic-org', 'invitee@example.test', 'member',
         'pending', transaction_timestamp() + interval '7 days', 'synthetic-owner'
       ) RETURNING id
     ) SELECT count(*)::text FROM inserted`,
    "1",
  );
  requireRoleSqlState(
    "one pending invitation per organization and canonical email",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.invitation (
       id, "organizationId", email, role, status, "expiresAt", "inviterId"
     ) VALUES (
       'duplicate-pending-invitation', 'synthetic-org', 'invitee@example.test', 'editor',
       'pending', statement_timestamp() + interval '7 days', 'synthetic-owner'
     )`,
    "23505",
  );
  requireRoleSqlState(
    "hash-only issued intent constraint",
    "app_owner",
    "development_postgres_migration_password",
    `INSERT INTO app.action_link_issuance_intents (
       id, environment, purpose, recipient_email, callback_identifier,
       generation, status, dispatch_not_after
     ) VALUES (
       '10000000-0000-4000-8000-000000000001', 'development', 'magic_login',
       'intent@example.test', 'magic_login_callback', 1, 'issued',
       statement_timestamp() + interval '10 minutes'
     )`,
    "23514",
  );
  requireRoleQueryResult(
    "requested magic-link intent fixture",
    "app_api",
    "development_postgres_api_password",
    `WITH inserted AS (
       INSERT INTO app.action_link_issuance_intents (
         id, environment, purpose, recipient_email, callback_identifier,
         generation, dispatch_not_after
       ) VALUES (
         '10000000-0000-4000-8000-000000000006', 'development', 'magic_login',
         'magic-worker@example.test', 'magic_login_callback', 1,
         transaction_timestamp() + interval '10 minutes'
       ) RETURNING id
     ) SELECT count(*)::text FROM inserted`,
    "1",
  );
  requireRoleQueryResult(
    "worker RFC Message-ID and hash issuance",
    "app_worker",
    "development_postgres_worker_password",
    `WITH issued AS (
       UPDATE app.action_link_issuance_intents
          SET status = 'issued',
              key_version = '1',
              token_hash = repeat('d', 64),
              stable_message_id = '<synthetic.development@messages.esmii.app>',
              issued_at = statement_timestamp(),
              expires_at = dispatch_not_after,
              updated_at = statement_timestamp()
        WHERE id = '10000000-0000-4000-8000-000000000006'
        RETURNING stable_message_id
     ) SELECT stable_message_id FROM issued`,
    "<synthetic.development@messages.esmii.app>",
  );
  requireRoleSqlState(
    "non-RFC stable message identifier rejection",
    "app_owner",
    "development_postgres_migration_password",
    `INSERT INTO app.action_link_issuance_intents (
       id, environment, purpose, recipient_email, callback_identifier,
       generation, status, dispatch_not_after, key_version, token_hash,
       stable_message_id, issued_at, expires_at
     ) VALUES (
       '10000000-0000-4000-8000-000000000007', 'development', 'magic_login',
       'bad-message-id@example.test', 'magic_login_callback', 1, 'issued',
       transaction_timestamp() + interval '10 minutes', '1', repeat('f', 64),
       '10000000-0000-4000-8000-000000000007', statement_timestamp(),
       transaction_timestamp() + interval '9 minutes'
     )`,
    "23514",
  );
  requireRoleQueryResult(
    "worker Better Auth magic verification insert",
    "app_worker",
    "development_postgres_worker_password",
    `WITH inserted AS (
       INSERT INTO app.verification (
         id, identifier, value, "expiresAt", "createdAt", "updatedAt"
       ) VALUES (
         'synthetic-magic-verification', repeat('d', 64),
         '{"email":"magic-worker@example.test"}',
         statement_timestamp() + interval '9 minutes',
         statement_timestamp(), statement_timestamp()
       ) RETURNING id
     ) SELECT id FROM inserted`,
    "synthetic-magic-verification",
  );
  requireRoleSqlState(
    "worker Better Auth verification UPDATE denial",
    "app_worker",
    "development_postgres_worker_password",
    `UPDATE app.verification SET value = '{}'
      WHERE id = 'synthetic-magic-verification'`,
    "42501",
  );
  requireRoleSqlState(
    "worker Better Auth verification DELETE denial",
    "app_worker",
    "development_postgres_worker_password",
    `DELETE FROM app.verification WHERE id = 'synthetic-magic-verification'`,
    "42501",
  );
  requireRoleSqlState(
    "worker unrelated verification insert denial",
    "app_worker",
    "development_postgres_worker_password",
    `INSERT INTO app.verification (
       id, identifier, value, "expiresAt", "createdAt", "updatedAt"
     ) VALUES (
       'unrelated-worker-verification', repeat('e', 64),
       '{"email":"magic-worker@example.test"}',
       statement_timestamp() + interval '9 minutes',
       statement_timestamp(), statement_timestamp()
     )`,
    "42501",
  );
  requireRoleQueryResult(
    "requested invitation intent fixture",
    "app_api",
    "development_postgres_api_password",
    `WITH inserted AS (
       INSERT INTO app.action_link_issuance_intents (
         id, environment, purpose, recipient_email, callback_identifier,
         invitation_id, generation, dispatch_not_after
       )
       SELECT
         '10000000-0000-4000-8000-000000000008', 'development',
         'invitation_accept', email, 'invitation_accept_callback', id, 1, "expiresAt"
       FROM app.invitation
       WHERE id = 'pending-invitation'
       RETURNING id
     ) SELECT count(*)::text FROM inserted`,
    "1",
  );
  requireRoleQueryResult(
    "worker invitation intent issuance",
    "app_worker",
    "development_postgres_worker_password",
    `WITH issued AS (
       UPDATE app.action_link_issuance_intents AS intent
          SET status = 'issued',
              key_version = '1',
              token_hash = repeat('a', 64),
              stable_message_id = '<invitation.synthetic@messages.esmii.app>',
              issued_at = statement_timestamp(),
              expires_at = invitation."expiresAt",
              updated_at = statement_timestamp()
         FROM app.invitation
        WHERE intent.id = '10000000-0000-4000-8000-000000000008'
          AND invitation.id = intent.invitation_id
        RETURNING intent.id
     ) SELECT count(*)::text FROM issued`,
    "1",
  );
  requireRoleQueryResult(
    "exact-intent continuation fixture",
    "app_api",
    "development_postgres_api_password",
    `WITH inserted AS (
       INSERT INTO app.invitation_continuations (
         id, invitation_id, action_intent_id, secret_hash, expires_at
       ) VALUES (
         '10000000-0000-4000-8000-000000000009', 'pending-invitation',
         '10000000-0000-4000-8000-000000000008', repeat('b', 64),
         transaction_timestamp() + interval '10 minutes'
       ) RETURNING id
     ) SELECT count(*)::text FROM inserted`,
    "1",
  );
  requireRoleSqlState(
    "continuation exact invitation-intent binding",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.invitation_continuations (
       id, invitation_id, action_intent_id, secret_hash, expires_at
     ) VALUES (
       '10000000-0000-4000-8000-000000000010', 'pending-invitation',
       '10000000-0000-4000-8000-000000000006', repeat('c', 64),
       transaction_timestamp() + interval '10 minutes'
     )`,
    "23503",
  );
  requireRoleSqlState(
    "continuation action-intent rebinding denial",
    "app_api",
    "development_postgres_api_password",
    `UPDATE app.invitation_continuations
        SET action_intent_id = '10000000-0000-4000-8000-000000000006'
      WHERE id = '10000000-0000-4000-8000-000000000009'`,
    "42501",
  );
  requireRoleQueryResult(
    "delivery outbox fixture",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.outbox_events (
       event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
       idempotency_key, payload, correlation_id
     ) VALUES (
       '10000000-0000-4000-8000-000000000011', 'invitation.requested',
       'action_link_issuance_intent', '10000000-0000-4000-8000-000000000008',
       1, 'synthetic-delivery-retry',
       '{"intentId":"10000000-0000-4000-8000-000000000008","purpose":"invitation_accept"}'::jsonb,
       'synthetic-delivery-correlation'
     );
     SELECT '1'::text`,
    "1",
  );
  requireRoleQueryResult(
    "worker delivery attempt and retry release",
    "app_worker",
    "development_postgres_worker_password",
    `BEGIN;
     UPDATE app.outbox_events
        SET status = 'claimed', claimed_at = statement_timestamp(),
            claimed_by = 'synthetic-worker',
            lease_expires_at = statement_timestamp() + interval '30 seconds',
            dispatch_attempts = dispatch_attempts + 1,
            updated_at = statement_timestamp()
      WHERE event_id = '10000000-0000-4000-8000-000000000011';
     INSERT INTO app.delivery_attempts (
       id, outbox_event_id, stable_message_id, attempt_number, status
     ) VALUES (
       '10000000-0000-4000-8000-000000000012',
       '10000000-0000-4000-8000-000000000011',
       '<retry.synthetic@messages.esmii.app>', 1, 'started'
     );
     UPDATE app.delivery_attempts
        SET status = 'retryable_failure', failure_class = 'retryable',
            failure_code = 'SMTP_TEMPORARY', finished_at = statement_timestamp()
      WHERE id = '10000000-0000-4000-8000-000000000012';
     UPDATE app.outbox_events
        SET status = 'pending', available_at = statement_timestamp() + interval '1 minute',
            claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL,
            failure_code = 'SMTP_TEMPORARY', updated_at = statement_timestamp()
      WHERE event_id = '10000000-0000-4000-8000-000000000011'
        AND claimed_by = 'synthetic-worker';
     COMMIT;
     SELECT status || ':' || failure_code
       FROM app.outbox_events
      WHERE event_id = '10000000-0000-4000-8000-000000000011'`,
    "pending:SMTP_TEMPORARY",
  );
  requireRoleQueryResult(
    "worker outbox exhaustion",
    "app_worker",
    "development_postgres_worker_password",
    `BEGIN;
     UPDATE app.outbox_events
        SET status = 'claimed', claimed_at = statement_timestamp(),
            claimed_by = 'synthetic-worker',
            lease_expires_at = statement_timestamp() + interval '30 seconds',
            dispatch_attempts = dispatch_attempts + 1,
            updated_at = statement_timestamp()
      WHERE event_id = '10000000-0000-4000-8000-000000000011';
     UPDATE app.outbox_events
        SET status = 'exhausted', claimed_at = NULL, claimed_by = NULL,
            lease_expires_at = NULL, exhausted_at = statement_timestamp(),
            failure_code = 'DELIVERY_EXHAUSTED', updated_at = statement_timestamp()
      WHERE event_id = '10000000-0000-4000-8000-000000000011'
        AND claimed_by = 'synthetic-worker';
     COMMIT;
     SELECT status || ':' || dispatch_attempts::text || ':' || failure_code
       FROM app.outbox_events
      WHERE event_id = '10000000-0000-4000-8000-000000000011'`,
    "exhausted:2:DELIVERY_EXHAUSTED",
  );
  requireRoleSqlState(
    "nested secret-key outbox rejection",
    "app_api",
    "development_postgres_api_password",
    `INSERT INTO app.outbox_events (
       event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
       idempotency_key, payload, correlation_id
     ) VALUES (
       '10000000-0000-4000-8000-000000000002', 'notification.requested',
       'synthetic', 'synthetic', 1, 'nested-secret-test',
       '{"safe":{"token":"forbidden"}}'::jsonb, 'synthetic-correlation'
     )`,
    "23514",
  );

  requireRoleQueryResult(
    "append-only audit fixture",
    "app_api",
    "development_postgres_api_password",
    `WITH inserted AS (
       INSERT INTO app.audit_events (
         event_id, actor_user_id, organization_id, action, target_type,
         target_id, result, request_id, correlation_id, metadata
       ) VALUES (
         '10000000-0000-4000-8000-000000000003', 'synthetic-owner', 'synthetic-org',
         'organization.created', 'organization', 'synthetic-org', 'success',
         'synthetic-request', 'synthetic-correlation', '{}'::jsonb
       ) RETURNING event_id
     ) SELECT count(*)::text FROM inserted`,
    "1",
  );
  requireRoleSqlState(
    "migration owner audit UPDATE denial",
    "app_owner",
    "development_postgres_migration_password",
    `UPDATE app.audit_events SET action = 'organization.changed'
      WHERE event_id = '10000000-0000-4000-8000-000000000003'`,
    "42501",
  );
  requireRoleSqlState(
    "migration owner audit DELETE denial",
    "app_owner",
    "development_postgres_migration_password",
    `DELETE FROM app.audit_events
      WHERE event_id = '10000000-0000-4000-8000-000000000003'`,
    "42501",
  );
  requireRoleSqlState(
    "tombstone target-binding denial",
    "app_api",
    "development_postgres_api_password",
    `BEGIN;
     INSERT INTO app.security_tombstone_mutations (
       event_id, environment, operation, scope_kind, scope_digest,
       user_id, organization_id, membership_id, prepare_sequence, prepared_at
     ) VALUES (
       '10000000-0000-4000-8000-000000000004', 'development', 'membership.demote',
       'membership', repeat('a', 64), 'synthetic-owner', 'synthetic-org',
       'synthetic-owner-membership', 1, statement_timestamp()
     );
     SELECT set_config('esmii.tombstone_event_id', '10000000-0000-4000-8000-000000000004', true);
     UPDATE app.member SET role = 'member'
      WHERE id = 'synthetic-editor-membership';
     COMMIT;`,
    "42501",
  );
  requireRoleSqlState(
    "deferred last-owner invariant",
    "app_api",
    "development_postgres_api_password",
    `BEGIN;
     INSERT INTO app.security_tombstone_mutations (
       event_id, environment, operation, scope_kind, scope_digest,
       user_id, organization_id, membership_id, prepare_sequence, prepared_at
     ) VALUES (
       '10000000-0000-4000-8000-000000000005', 'development', 'ownership.demote',
       'ownership', repeat('b', 64), 'synthetic-owner', 'synthetic-org',
       'synthetic-owner-membership', 2, statement_timestamp()
     );
     SELECT set_config('esmii.tombstone_event_id', '10000000-0000-4000-8000-000000000005', true);
     UPDATE app.member SET role = 'member'
      WHERE id = 'synthetic-owner-membership';
     UPDATE app.security_tombstone_mutations
        SET status = 'local_applied', local_applied_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE event_id = '10000000-0000-4000-8000-000000000005';
     INSERT INTO app.audit_events (
       event_id, actor_user_id, organization_id, action, target_type,
       target_id, result, request_id, correlation_id, metadata
     ) VALUES (
       '10000000-0000-4000-8000-000000000005', 'synthetic-owner', 'synthetic-org',
       'ownership.demoted', 'membership', 'synthetic-owner-membership', 'success',
       'last-owner-request', 'last-owner-correlation', '{}'::jsonb
     );
     COMMIT;`,
    "23514",
  );
  requireRoleSqlState(
    "API worker-only action-intent material denial",
    "app_api",
    "development_postgres_api_password",
    `UPDATE app.action_link_issuance_intents
        SET token_hash = repeat('c', 64)
      WHERE id = '10000000-0000-4000-8000-000000000001'`,
    "42501",
  );
  requireRoleSqlState(
    "worker application identity write denial",
    "app_worker",
    "development_postgres_worker_password",
    `INSERT INTO app."user" (id, name, email)
     VALUES ('worker-forbidden-user', 'Worker Forbidden', 'worker@example.test')`,
    "42501",
  );

  requireValkeyResponse("API Valkey authentication and ping", "esmii_api", "acl", ["PING"], "PONG");
  requireValkeyResponse(
    "API Valkey namespace write",
    "esmii_api",
    "acl",
    ["SET", "esmii:api:acl-test", "api-value"],
    "OK",
  );
  requireValkeyResponse(
    "API Valkey namespace read",
    "esmii_api",
    "acl",
    ["GET", "esmii:api:acl-test"],
    "api-value",
  );
  requireValkeyResponse(
    "worker Valkey authentication and ping",
    "esmii_worker",
    "acl",
    ["PING"],
    "PONG",
  );
  requireValkeyResponse(
    "worker Valkey namespace setup",
    "esmii_worker",
    "acl",
    ["SET", "esmii:worker:acl-test", "worker-value"],
    "OK",
  );
  requireValkeyPermissionDenied("API Valkey worker-namespace read denial", "esmii_api", "acl", [
    "GET",
    "esmii:worker:acl-test",
  ]);
  requireValkeyPermissionDenied("API Valkey worker-namespace write denial", "esmii_api", "acl", [
    "SET",
    "esmii:worker:api-write-test",
    "forbidden",
  ]);
  requireValkeyPermissionDenied("worker Valkey dangerous-command denial", "esmii_worker", "acl", [
    "FLUSHALL",
  ]);
  requireValkeyResponse(
    "health Valkey authentication and ping",
    "health",
    "health",
    ["PING"],
    "PONG",
  );
  requireValkeyPermissionDenied("health Valkey read denial", "health", "health", [
    "GET",
    "esmii:api:acl-test",
  ]);
  requireValkeyPermissionDenied("health Valkey write denial", "health", "health", [
    "SET",
    "esmii:api:health-write-test",
    "forbidden",
  ]);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  const cleanup = compose(["down", "--volumes", "--remove-orphans"]);
  if (cleanup.status !== 0) {
    failed = true;
    console.error("Migration-test environment cleanup failed.");
  }
}

process.exit(failed ? 1 : 0);
