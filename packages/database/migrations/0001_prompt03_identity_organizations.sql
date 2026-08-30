-- Esmii identity and organization schema.
CREATE FUNCTION "app"."jsonb_has_forbidden_key"(document jsonb, forbidden_keys text[]) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  child jsonb;
  object_key text;
BEGIN
  IF jsonb_typeof(document) = 'object' THEN
    FOR object_key, child IN SELECT key, value FROM jsonb_each(document) LOOP
      IF lower(object_key) = ANY(forbidden_keys)
         OR app.jsonb_has_forbidden_key(child, forbidden_keys) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(document) LOOP
      IF app.jsonb_has_forbidden_key(child, forbidden_keys) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$function$;
--> statement-breakpoint
CREATE TABLE "app"."user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean DEFAULT false NOT NULL,
  "image" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "statusChangedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "authorizationVersion" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "user_email_canonical_check" CHECK (
    "email" = lower(btrim("email"))
    AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    AND length("email") BETWEEN 3 AND 320
  ),
  CONSTRAINT "user_status_check" CHECK ("status" IN ('active', 'disabled', 'deleted')),
  CONSTRAINT "user_authorization_version_check" CHECK ("authorizationVersion" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "app"."user" USING btree ("email");
--> statement-breakpoint
CREATE TABLE "app"."organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "metadata" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now(),
  "deletedAt" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "organization_name_check" CHECK (
    length(btrim("name")) BETWEEN 1 AND 120 AND "name" = btrim("name")
  ),
  CONSTRAINT "organization_slug_normalized_check" CHECK (
    "slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  CONSTRAINT "organization_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_unique" ON "app"."organization" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE "app"."account" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp with time zone,
  "refreshTokenExpiresAt" timestamp with time zone,
  "scope" text,
  "password" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "app"."user"("id") ON DELETE CASCADE,
  CONSTRAINT "account_password_disabled_check" CHECK ("password" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_identity_unique" ON "app"."account" USING btree ("issuer", "accountId");
--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "app"."account" USING btree ("userId");
--> statement-breakpoint
CREATE TABLE "app"."session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "token" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL,
  "activeOrganizationId" text,
  CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "app"."user"("id") ON DELETE CASCADE,
  CONSTRAINT "session_activeOrganizationId_organization_id_fk" FOREIGN KEY ("activeOrganizationId") REFERENCES "app"."organization"("id") ON DELETE SET NULL,
  CONSTRAINT "session_expiry_check" CHECK ("expiresAt" > "createdAt")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "app"."session" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "session_user_expiry_index" ON "app"."session" USING btree ("userId", "expiresAt");
--> statement-breakpoint
CREATE INDEX "session_active_organization_index" ON "app"."session" USING btree ("activeOrganizationId");
--> statement-breakpoint
CREATE TABLE "app"."verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "app"."verification" USING btree ("identifier");
--> statement-breakpoint
CREATE TABLE "app"."member" (
  "id" text PRIMARY KEY NOT NULL,
  "organizationId" text NOT NULL,
  "userId" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "removedAt" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "member_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "app"."organization"("id") ON DELETE RESTRICT,
  CONSTRAINT "member_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "app"."user"("id") ON DELETE RESTRICT,
  CONSTRAINT "member_role_check" CHECK ("role" IN ('owner', 'editor', 'member')),
  CONSTRAINT "member_status_check" CHECK ("status" IN ('active', 'removed', 'disabled')),
  CONSTRAINT "member_removed_at_check" CHECK (
    ("status" = 'active' AND "removedAt" IS NULL)
    OR ("status" <> 'active' AND "removedAt" IS NOT NULL)
  ),
  CONSTRAINT "member_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_unique" ON "app"."member" USING btree ("organizationId", "userId");
--> statement-breakpoint
CREATE INDEX "member_user_status_index" ON "app"."member" USING btree ("userId", "status");
--> statement-breakpoint
CREATE INDEX "member_organization_role_status_index" ON "app"."member" USING btree ("organizationId", "role", "status");
--> statement-breakpoint
CREATE TABLE "app"."invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organizationId" text NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "inviterId" text NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "acceptedAt" timestamp with time zone,
  "revokedAt" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "invitation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "app"."organization"("id") ON DELETE RESTRICT,
  CONSTRAINT "invitation_inviterId_user_id_fk" FOREIGN KEY ("inviterId") REFERENCES "app"."user"("id") ON DELETE RESTRICT,
  CONSTRAINT "invitation_email_canonical_check" CHECK (
    "email" = lower(btrim("email"))
    AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    AND length("email") BETWEEN 3 AND 320
  ),
  CONSTRAINT "invitation_role_check" CHECK ("role" IN ('editor', 'member')),
  CONSTRAINT "invitation_status_check" CHECK (
    "status" IN ('pending', 'accepted', 'rejected', 'canceled', 'revoked', 'expired')
  ),
  CONSTRAINT "invitation_expiry_check" CHECK (
    "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '7 days'
  ),
  CONSTRAINT "invitation_resolution_timestamp_check" CHECK (
    ("status" = 'accepted' AND "acceptedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" IN ('rejected', 'canceled', 'revoked') AND "revokedAt" IS NOT NULL AND "acceptedAt" IS NULL)
    OR ("status" IN ('pending', 'expired') AND "acceptedAt" IS NULL AND "revokedAt" IS NULL)
  ),
  CONSTRAINT "invitation_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_one_pending_per_recipient" ON "app"."invitation" USING btree ("organizationId", "email") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "invitation_recipient_status_index" ON "app"."invitation" USING btree ("email", "status");
--> statement-breakpoint
CREATE TABLE "app"."action_link_issuance_intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "environment" text NOT NULL,
  "purpose" text NOT NULL,
  "recipient_email" text NOT NULL,
  "callback_identifier" text NOT NULL,
  "invitation_id" text,
  "generation" integer NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "dispatch_not_after" timestamp with time zone NOT NULL,
  "key_version" text,
  "token_hash" text,
  "stable_message_id" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "issued_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "superseded_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_link_issuance_intents_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "app"."invitation"("id") ON DELETE RESTRICT,
  CONSTRAINT "action_intent_environment_check" CHECK ("environment" IN ('development', 'test', 'staging', 'production')),
  CONSTRAINT "action_intent_purpose_check" CHECK ("purpose" IN ('magic_login', 'invitation_accept')),
  CONSTRAINT "action_intent_callback_check" CHECK (
    ("purpose" = 'magic_login' AND "callback_identifier" = 'magic_login_callback')
    OR ("purpose" = 'invitation_accept' AND "callback_identifier" = 'invitation_accept_callback')
  ),
  CONSTRAINT "action_intent_subject_check" CHECK (
    ("purpose" = 'magic_login' AND "invitation_id" IS NULL)
    OR ("purpose" = 'invitation_accept' AND "invitation_id" IS NOT NULL)
  ),
  CONSTRAINT "action_intent_recipient_canonical_check" CHECK (
    "recipient_email" = lower(btrim("recipient_email"))
    AND "recipient_email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    AND length("recipient_email") BETWEEN 3 AND 320
  ),
  CONSTRAINT "action_intent_status_check" CHECK (
    "status" IN ('requested', 'issued', 'consumed', 'expired', 'superseded', 'cancelled')
  ),
  CONSTRAINT "action_intent_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "action_intent_dispatch_window_check" CHECK ("dispatch_not_after" > "requested_at"),
  CONSTRAINT "action_intent_key_version_check" CHECK ("key_version" IS NULL OR "key_version" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "action_intent_message_id_check" CHECK (
    "stable_message_id" IS NULL OR "stable_message_id" ~ '^<[A-Za-z0-9._-]{1,200}@[A-Za-z0-9.-]{1,253}>$'
  ),
  CONSTRAINT "action_intent_hash_check" CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "action_intent_issued_state_check" CHECK (
    ("status" = 'requested' AND "token_hash" IS NULL AND "key_version" IS NULL AND "issued_at" IS NULL AND "expires_at" IS NULL AND "stable_message_id" IS NULL)
    OR ("status" IN ('issued', 'consumed') AND "token_hash" IS NOT NULL AND "key_version" IS NOT NULL AND "issued_at" IS NOT NULL AND "expires_at" IS NOT NULL AND "stable_message_id" IS NOT NULL)
    OR ("status" IN ('expired', 'superseded', 'cancelled'))
  ),
  CONSTRAINT "action_intent_consumed_state_check" CHECK (
    ("status" = 'consumed' AND "consumed_at" IS NOT NULL)
    OR ("status" <> 'consumed' AND "consumed_at" IS NULL)
  ),
  CONSTRAINT "action_intent_superseded_state_check" CHECK (
    ("status" = 'superseded' AND "superseded_at" IS NOT NULL)
    OR ("status" <> 'superseded' AND "superseded_at" IS NULL)
  ),
  CONSTRAINT "action_intent_cancelled_state_check" CHECK (
    ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancelled_at" IS NULL)
  ),
  CONSTRAINT "action_intent_expiry_check" CHECK (
    "expires_at" IS NULL
    OR (
      "issued_at" IS NOT NULL
      AND "expires_at" > "issued_at"
      AND (
        ("purpose" = 'magic_login' AND "expires_at" <= "requested_at" + interval '10 minutes')
        OR ("purpose" = 'invitation_accept' AND "expires_at" <= "requested_at" + interval '7 days')
      )
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_intent_stable_message_unique" ON "app"."action_link_issuance_intents" USING btree ("stable_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_intent_id_invitation_unique" ON "app"."action_link_issuance_intents" USING btree ("id", "invitation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_intent_current_magic_recipient_unique" ON "app"."action_link_issuance_intents" USING btree ("environment", "purpose", "recipient_email") WHERE "purpose" = 'magic_login' AND "status" IN ('requested', 'issued');
--> statement-breakpoint
CREATE UNIQUE INDEX "action_intent_current_invitation_unique" ON "app"."action_link_issuance_intents" USING btree ("invitation_id") WHERE "purpose" = 'invitation_accept' AND "status" IN ('requested', 'issued');
--> statement-breakpoint
CREATE INDEX "action_intent_dispatch_index" ON "app"."action_link_issuance_intents" USING btree ("status", "dispatch_not_after");
--> statement-breakpoint
CREATE TABLE "app"."outbox_events" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "aggregate_version" bigint NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "lease_expires_at" timestamp with time zone,
  "dispatch_attempts" integer DEFAULT 0 NOT NULL,
  "pg_boss_job_id" text,
  "dispatched_at" timestamp with time zone,
  "exhausted_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_event_type_check" CHECK (
    "event_type" IN ('magic_link.requested', 'invitation.requested', 'notification.requested', 'authorization.invalidated')
  ),
  CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" > 0),
  CONSTRAINT "outbox_status_check" CHECK ("status" IN ('pending', 'claimed', 'dispatched', 'exhausted')),
  CONSTRAINT "outbox_payload_shape_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 8192
    AND NOT app.jsonb_has_forbidden_key("payload", ARRAY['token', 'url', 'body', 'key', 'secret', 'password', 'authorization', 'cookie'])
  ),
  CONSTRAINT "outbox_dispatch_attempts_check" CHECK ("dispatch_attempts" >= 0),
  CONSTRAINT "outbox_failure_code_check" CHECK (
    "failure_code" IS NULL OR "failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT "outbox_claim_state_check" CHECK (
    ("status" = 'claimed' AND "claimed_at" IS NOT NULL AND "claimed_by" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR "status" <> 'claimed'
  ),
  CONSTRAINT "outbox_terminal_state_check" CHECK (
    ("status" = 'dispatched' AND "dispatched_at" IS NOT NULL AND "pg_boss_job_id" IS NOT NULL)
    OR ("status" = 'exhausted' AND "exhausted_at" IS NOT NULL AND "failure_code" IS NOT NULL)
    OR "status" IN ('pending', 'claimed')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idempotency_key_unique" ON "app"."outbox_events" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "outbox_dispatch_index" ON "app"."outbox_events" USING btree ("status", "available_at");
--> statement-breakpoint
CREATE TABLE "app"."delivery_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "stable_message_id" text NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" text NOT NULL,
  "provider_reference" text,
  "failure_class" text,
  "failure_code" text,
  "skip_code" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "delivery_attempts_outbox_event_id_outbox_events_event_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "app"."outbox_events"("event_id") ON DELETE RESTRICT,
  CONSTRAINT "delivery_attempt_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "delivery_attempt_message_id_check" CHECK (
    "stable_message_id" ~ '^<[A-Za-z0-9._-]{1,200}@[A-Za-z0-9.-]{1,253}>$'
  ),
  CONSTRAINT "delivery_attempt_status_check" CHECK (
    "status" IN ('started', 'accepted', 'retryable_failure', 'permanent_failure', 'skipped')
  ),
  CONSTRAINT "delivery_attempt_failure_check" CHECK (
    ("status" IN ('retryable_failure', 'permanent_failure') AND "failure_class" IS NOT NULL AND "failure_code" IS NOT NULL)
    OR ("status" NOT IN ('retryable_failure', 'permanent_failure') AND "failure_class" IS NULL AND "failure_code" IS NULL)
  ),
  CONSTRAINT "delivery_attempt_failure_class_check" CHECK (
    "failure_class" IS NULL OR "failure_class" IN ('retryable', 'permanent')
  ),
  CONSTRAINT "delivery_attempt_failure_code_check" CHECK (
    "failure_code" IS NULL OR "failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT "delivery_attempt_skip_code_check" CHECK (
    ("status" = 'skipped' AND "skip_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    OR ("status" <> 'skipped' AND "skip_code" IS NULL)
  ),
  CONSTRAINT "delivery_attempt_finished_check" CHECK (
    ("status" = 'started' AND "finished_at" IS NULL)
    OR ("status" <> 'started' AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempt_event_attempt_unique" ON "app"."delivery_attempts" USING btree ("outbox_event_id", "attempt_number");
--> statement-breakpoint
CREATE INDEX "delivery_attempt_status_index" ON "app"."delivery_attempts" USING btree ("status", "started_at");
--> statement-breakpoint
CREATE TABLE "app"."operation_idempotency" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_user_id" text NOT NULL,
  "operation" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "status" text DEFAULT 'in_progress' NOT NULL,
  "result_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "operation_idempotency_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."user"("id") ON DELETE RESTRICT,
  CONSTRAINT "operation_idempotency_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "operation_idempotency_status_check" CHECK ("status" IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT "operation_idempotency_completion_check" CHECK (
    ("status" = 'completed' AND "result_reference" IS NOT NULL AND "completed_at" IS NOT NULL)
    OR "status" <> 'completed'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operation_idempotency_actor_key_unique" ON "app"."operation_idempotency" USING btree ("actor_user_id", "operation", "idempotency_key");
--> statement-breakpoint
CREATE TABLE "app"."audit_events" (
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "event_id" uuid PRIMARY KEY NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_user_id" text,
  "organization_id" text,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "result" text NOT NULL,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "audit_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."user"("id") ON DELETE RESTRICT,
  CONSTRAINT "audit_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE RESTRICT,
  CONSTRAINT "audit_action_check" CHECK ("action" ~ '^[a-z][a-z0-9_.]{1,127}$'),
  CONSTRAINT "audit_target_type_check" CHECK ("target_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "audit_result_check" CHECK ("result" IN ('success', 'denied', 'failed')),
  CONSTRAINT "audit_metadata_shape_check" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND octet_length("metadata"::text) <= 4096
    AND NOT app.jsonb_has_forbidden_key("metadata", ARRAY['token', 'url', 'body', 'key', 'secret', 'password', 'authorization', 'cookie', 'claims'])
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_sequence_unique" ON "app"."audit_events" USING btree ("sequence");
--> statement-breakpoint
CREATE INDEX "audit_organization_sequence_index" ON "app"."audit_events" USING btree ("organization_id", "sequence");
--> statement-breakpoint
CREATE INDEX "audit_actor_sequence_index" ON "app"."audit_events" USING btree ("actor_user_id", "sequence");
--> statement-breakpoint
CREATE TABLE "app"."security_tombstone_mutations" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "environment" text NOT NULL,
  "operation" text NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_digest" text NOT NULL,
  "user_id" text,
  "organization_id" text,
  "membership_id" text,
  "account_id" text,
  "prepare_sequence" bigint NOT NULL,
  "resolution_sequence" bigint,
  "status" text DEFAULT 'prepared' NOT NULL,
  "prepared_at" timestamp with time zone NOT NULL,
  "local_applied_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "security_tombstone_mutations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE RESTRICT,
  CONSTRAINT "security_tombstone_mutations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE RESTRICT,
  CONSTRAINT "security_tombstone_mutations_membership_id_member_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."member"("id") ON DELETE RESTRICT,
  CONSTRAINT "tombstone_environment_check" CHECK ("environment" IN ('development', 'test', 'staging', 'production')),
  CONSTRAINT "tombstone_scope_kind_check" CHECK ("scope_kind" IN ('user', 'account', 'provider', 'membership', 'ownership', 'organization')),
  CONSTRAINT "tombstone_scope_digest_check" CHECK ("scope_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tombstone_prepare_sequence_check" CHECK ("prepare_sequence" > 0),
  CONSTRAINT "tombstone_resolution_sequence_check" CHECK (
    "resolution_sequence" IS NULL OR "resolution_sequence" > "prepare_sequence"
  ),
  CONSTRAINT "tombstone_status_check" CHECK ("status" IN ('prepared', 'local_applied', 'committed', 'cancelled')),
  CONSTRAINT "tombstone_state_timestamp_check" CHECK (
    ("status" = 'prepared' AND "local_applied_at" IS NULL AND "resolved_at" IS NULL AND "resolution_sequence" IS NULL AND "failure_code" IS NULL)
    OR ("status" = 'local_applied' AND "local_applied_at" IS NOT NULL AND "resolved_at" IS NULL AND "resolution_sequence" IS NULL AND "failure_code" IS NULL)
    OR ("status" = 'committed' AND "local_applied_at" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolution_sequence" IS NOT NULL AND "failure_code" IS NULL)
    OR ("status" = 'cancelled' AND "local_applied_at" IS NULL AND "resolved_at" IS NOT NULL AND "resolution_sequence" IS NOT NULL AND "failure_code" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tombstone_environment_prepare_sequence_unique" ON "app"."security_tombstone_mutations" USING btree ("environment", "prepare_sequence");
--> statement-breakpoint
CREATE INDEX "tombstone_status_prepared_index" ON "app"."security_tombstone_mutations" USING btree ("status", "prepared_at");
--> statement-breakpoint
CREATE INDEX "tombstone_organization_index" ON "app"."security_tombstone_mutations" USING btree ("organization_id", "prepare_sequence");
--> statement-breakpoint
CREATE TABLE "app"."security_tombstone_state" (
  "singleton" boolean DEFAULT true PRIMARY KEY NOT NULL,
  "environment" text NOT NULL,
  "epoch" uuid NOT NULL,
  "contiguous_high_water" bigint DEFAULT 0 NOT NULL,
  "access_closed" boolean DEFAULT false NOT NULL,
  "closure_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tombstone_state_singleton_check" CHECK ("singleton"),
  CONSTRAINT "tombstone_state_environment_check" CHECK ("environment" IN ('development', 'test', 'staging', 'production')),
  CONSTRAINT "tombstone_high_water_check" CHECK ("contiguous_high_water" >= 0),
  CONSTRAINT "tombstone_state_version_check" CHECK ("version" > 0),
  CONSTRAINT "tombstone_closure_reason_check" CHECK (
    ("access_closed" AND "closure_reason" IS NOT NULL)
    OR (NOT "access_closed" AND "closure_reason" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "app"."invitation_continuations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "invitation_id" text NOT NULL,
  "action_intent_id" uuid NOT NULL,
  "secret_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "invitation_continuations_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "app"."invitation"("id") ON DELETE RESTRICT,
  CONSTRAINT "invitation_continuation_exact_intent_fk" FOREIGN KEY ("action_intent_id", "invitation_id") REFERENCES "app"."action_link_issuance_intents"("id", "invitation_id") ON DELETE RESTRICT,
  CONSTRAINT "invitation_continuation_hash_check" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "invitation_continuation_expiry_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '10 minutes'
  ),
  CONSTRAINT "invitation_continuation_consumed_check" CHECK (
    "consumed_at" IS NULL OR ("consumed_at" >= "created_at" AND "consumed_at" <= "expires_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_continuation_action_intent_unique" ON "app"."invitation_continuations" USING btree ("action_intent_id");
--> statement-breakpoint
CREATE INDEX "invitation_continuation_invitation_index" ON "app"."invitation_continuations" USING btree ("invitation_id");
--> statement-breakpoint
CREATE FUNCTION "app"."reject_audit_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RAISE EXCEPTION 'audit history is append-only' USING ERRCODE = '42501';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "app"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_audit_history_mutation"();
--> statement-breakpoint
CREATE FUNCTION "app"."reject_unapproved_physical_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF current_user = 'app_owner' AND current_setting('esmii.physical_purge_maintenance', true) = 'approved' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'physical deletion requires reviewed migration-owner maintenance' USING ERRCODE = '42501';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "organization_no_unapproved_hard_delete"
BEFORE DELETE ON "app"."organization"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_unapproved_physical_delete"();
--> statement-breakpoint
CREATE TRIGGER "user_no_unapproved_hard_delete"
BEFORE DELETE ON "app"."user"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_unapproved_physical_delete"();
--> statement-breakpoint
CREATE FUNCTION "app"."serialize_membership_change"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  target_organization_id text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_organization_id := NEW."organizationId";
  ELSE
    target_organization_id := OLD."organizationId";
    IF TG_OP = 'UPDATE' AND NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
      RAISE EXCEPTION 'membership organization is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM 1 FROM app.organization WHERE id = target_organization_id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "member_serialize_organization"
BEFORE INSERT OR UPDATE OR DELETE ON "app"."member"
FOR EACH ROW EXECUTE FUNCTION "app"."serialize_membership_change"();
--> statement-breakpoint
CREATE FUNCTION "app"."check_organization_has_active_owner"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  target_organization_id text;
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    IF TG_OP = 'DELETE' THEN target_organization_id := OLD.id;
    ELSE target_organization_id := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN target_organization_id := OLD."organizationId";
    ELSE target_organization_id := NEW."organizationId";
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.organization
     WHERE id = target_organization_id AND "deletedAt" IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM app.member
     WHERE "organizationId" = target_organization_id
       AND status = 'active'
       AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'active organization must retain an active owner' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "member_last_owner_invariant"
AFTER INSERT OR UPDATE OR DELETE ON "app"."member"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_organization_has_active_owner"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "organization_initial_owner_invariant"
AFTER INSERT ON "app"."organization"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_organization_has_active_owner"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "organization_deletion_owner_invariant"
AFTER UPDATE OF "deletedAt" ON "app"."organization"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_organization_has_active_owner"();
--> statement-breakpoint
CREATE FUNCTION "app"."validate_session_active_organization"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW."activeOrganizationId" IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM app.member
      INNER JOIN app.organization
        ON organization.id = member."organizationId"
       AND organization."deletedAt" IS NULL
      INNER JOIN app."user"
        ON "user".id = member."userId"
       AND "user".status = 'active'
     WHERE member."organizationId" = NEW."activeOrganizationId"
       AND member."userId" = NEW."userId"
       AND member.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active organization requires current membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "session_active_organization_valid"
BEFORE INSERT OR UPDATE OF "activeOrganizationId", "userId" ON "app"."session"
FOR EACH ROW EXECUTE FUNCTION "app"."validate_session_active_organization"();
--> statement-breakpoint
CREATE FUNCTION "app"."check_removed_membership_has_no_active_session"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW.status <> 'active') AND EXISTS (
    SELECT 1 FROM app."session"
     WHERE "userId" = OLD."userId"
       AND "activeOrganizationId" = OLD."organizationId"
  ) THEN
    RAISE EXCEPTION 'membership reduction must clear active organization sessions' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "member_active_session_invariant"
AFTER UPDATE OR DELETE ON "app"."member"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_removed_membership_has_no_active_session"();
--> statement-breakpoint
CREATE FUNCTION "app"."check_deleted_organization_has_no_active_session"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW."deletedAt" IS NOT NULL AND EXISTS (
    SELECT 1 FROM app."session" WHERE "activeOrganizationId" = NEW.id
  ) THEN
    RAISE EXCEPTION 'organization deletion must clear active organization sessions' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "organization_active_session_invariant"
AFTER UPDATE OF "deletedAt" ON "app"."organization"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_deleted_organization_has_no_active_session"();
--> statement-breakpoint
CREATE FUNCTION "app"."check_disabled_user_has_no_session"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.status <> 'active' AND EXISTS (
    SELECT 1 FROM app."session" WHERE "userId" = NEW.id
  ) THEN
    RAISE EXCEPTION 'disabled or deleted user must have no active session' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "user_session_revocation_invariant"
AFTER UPDATE OF "status" ON "app"."user"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_disabled_user_has_no_session"();
--> statement-breakpoint
CREATE FUNCTION "app"."require_prepared_tombstone"(allowed_scope_kinds text[]) RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, app
AS $function$
DECLARE
  configured_event text;
  parsed_event uuid;
BEGIN
  configured_event := current_setting('esmii.tombstone_event_id', true);
  IF configured_event IS NULL OR configured_event = '' THEN
    RAISE EXCEPTION 'access reduction requires a prepared tombstone' USING ERRCODE = '42501';
  END IF;
  BEGIN
    parsed_event := configured_event::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'access reduction tombstone identity is invalid' USING ERRCODE = '42501';
  END;

  IF NOT EXISTS (
    SELECT 1
      FROM app.security_tombstone_mutations
     WHERE event_id = parsed_event
       AND status = 'prepared'
       AND scope_kind = ANY(allowed_scope_kinds)
  ) THEN
    RAISE EXCEPTION 'access reduction tombstone is not current' USING ERRCODE = '42501';
  END IF;
  RETURN parsed_event;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION "app"."guard_user_access_reduction"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  tombstone_event uuid;
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    tombstone_event := app.require_prepared_tombstone(ARRAY['user', 'account']);
    IF NOT EXISTS (
      SELECT 1 FROM app.security_tombstone_mutations
       WHERE event_id = tombstone_event AND user_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'user reduction tombstone scope does not match target' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "user_access_reduction_requires_tombstone"
BEFORE UPDATE OF "status" ON "app"."user"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_user_access_reduction"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_account_unlink"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  tombstone_event uuid;
BEGIN
  tombstone_event := app.require_prepared_tombstone(ARRAY['account', 'provider']);
  IF NOT EXISTS (
    SELECT 1 FROM app.security_tombstone_mutations
     WHERE event_id = tombstone_event
       AND account_id = OLD.id
       AND (user_id IS NULL OR user_id = OLD."userId")
  ) THEN
    RAISE EXCEPTION 'account unlink tombstone scope does not match target' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "account_unlink_requires_tombstone"
BEFORE DELETE ON "app"."account"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_account_unlink"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_membership_access_reduction"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  old_rank integer;
  new_rank integer;
  tombstone_event uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    tombstone_event := app.require_prepared_tombstone(ARRAY['membership', 'ownership', 'organization']);
    IF NOT EXISTS (
      SELECT 1 FROM app.security_tombstone_mutations
       WHERE event_id = tombstone_event
         AND (
           (scope_kind IN ('membership', 'ownership') AND membership_id = OLD.id)
           OR (scope_kind = 'organization' AND organization_id = OLD."organizationId")
         )
    ) THEN
      RAISE EXCEPTION 'membership reduction tombstone scope does not match target' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  old_rank := CASE OLD.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END;
  new_rank := CASE NEW.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END;
  IF (OLD.status = 'active' AND NEW.status <> 'active') OR new_rank < old_rank THEN
    tombstone_event := app.require_prepared_tombstone(ARRAY['membership', 'ownership', 'organization']);
    IF NOT EXISTS (
      SELECT 1 FROM app.security_tombstone_mutations
       WHERE event_id = tombstone_event
         AND (
           (scope_kind IN ('membership', 'ownership') AND membership_id = OLD.id)
           OR (scope_kind = 'organization' AND organization_id = OLD."organizationId")
         )
    ) THEN
      RAISE EXCEPTION 'membership reduction tombstone scope does not match target' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "member_access_reduction_requires_tombstone"
BEFORE UPDATE OR DELETE ON "app"."member"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_membership_access_reduction"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_organization_soft_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  tombstone_event uuid;
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
    tombstone_event := app.require_prepared_tombstone(ARRAY['organization']);
    IF NOT EXISTS (
      SELECT 1 FROM app.security_tombstone_mutations
       WHERE event_id = tombstone_event AND organization_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'organization deletion tombstone scope does not match target' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "organization_soft_delete_requires_tombstone"
BEFORE UPDATE OF "deletedAt" ON "app"."organization"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_organization_soft_delete"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_tombstone_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.scope_digest IS DISTINCT FROM OLD.scope_digest
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.prepare_sequence IS DISTINCT FROM OLD.prepare_sequence
     OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at THEN
    RAISE EXCEPTION 'tombstone preparation identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'prepared' AND NEW.status IN ('local_applied', 'cancelled') THEN RETURN NEW; END IF;
  IF OLD.status = 'local_applied' AND NEW.status = 'committed' THEN RETURN NEW; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid tombstone state transition' USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "security_tombstone_transition"
BEFORE UPDATE ON "app"."security_tombstone_mutations"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_tombstone_transition"();
--> statement-breakpoint
CREATE FUNCTION "app"."check_tombstone_audit_link"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.status IN ('local_applied', 'committed') AND NOT EXISTS (
    SELECT 1 FROM app.audit_events WHERE event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION 'locally applied tombstone requires audit event with the same identity' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "security_tombstone_audit_invariant"
AFTER INSERT OR UPDATE ON "app"."security_tombstone_mutations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_tombstone_audit_link"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_action_intent_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
     OR NEW.callback_identifier IS DISTINCT FROM OLD.callback_identifier
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.dispatch_not_after IS DISTINCT FROM OLD.dispatch_not_after
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'action-link issuance identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF current_user = 'app_api' AND (
    NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.stable_message_id IS DISTINCT FROM OLD.stable_message_id
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'only the worker may issue action-link material' USING ERRCODE = '42501';
  END IF;

  IF current_user = 'app_worker' AND NEW.status NOT IN ('issued', 'expired') THEN
    RAISE EXCEPTION 'worker cannot consume or supersede action-link intents' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF OLD.status = 'requested' AND NEW.status IN ('issued', 'expired', 'superseded', 'cancelled') THEN RETURN NEW; END IF;
  IF OLD.status = 'issued' AND NEW.status IN ('consumed', 'expired', 'superseded', 'cancelled') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid action-link issuance state transition' USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "action_link_issuance_transition"
BEFORE UPDATE ON "app"."action_link_issuance_intents"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_action_intent_transition"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_delivery_attempt_transition"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
     OR NEW.stable_message_id IS DISTINCT FROM OLD.stable_message_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'delivery attempt identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'started'
     AND NEW.status IN ('accepted', 'retryable_failure', 'permanent_failure', 'skipped') THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid delivery attempt state transition' USING ERRCODE = '23514';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "delivery_attempt_transition"
BEFORE UPDATE ON "app"."delivery_attempts"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_delivery_attempt_transition"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_worker_magic_verification"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  verification_payload jsonb;
  verification_email text;
BEGIN
  IF current_user <> 'app_worker' THEN RETURN NEW; END IF;
  BEGIN
    verification_payload := NEW.value::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'worker verification payload is invalid' USING ERRCODE = '42501';
  END;
  verification_email := verification_payload ->> 'email';
  IF NEW.identifier !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(verification_payload) <> 'object'
     OR verification_payload - ARRAY['email', 'name'] <> '{}'::jsonb
     OR verification_email IS NULL
     OR verification_email <> lower(btrim(verification_email))
     OR verification_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     OR NEW."expiresAt" <= statement_timestamp()
     OR NEW."expiresAt" > statement_timestamp() + interval '10 minutes'
     OR NOT EXISTS (
       SELECT 1
         FROM app.action_link_issuance_intents
        WHERE purpose = 'magic_login'
          AND recipient_email = verification_email
          AND token_hash = NEW.identifier
          AND status = 'issued'
          AND expires_at > statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'worker verification insert is outside an issued magic-link intent' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "worker_magic_verification_only"
BEFORE INSERT ON "app"."verification"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_worker_magic_verification"();
--> statement-breakpoint
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA "app" FROM "app_api", "app_worker", "backup_reader";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "app" TO "app_api", "app_worker", "backup_reader";
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC, "app_api", "app_worker", "backup_reader";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "app" FROM PUBLIC, "app_api", "app_worker", "backup_reader";
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "app" FROM PUBLIC, "app_api", "app_worker", "backup_reader";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."user" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."account" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."session" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."verification" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."organization" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."member" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."invitation" TO "app_api";
--> statement-breakpoint
GRANT SELECT ON TABLE "app"."action_link_issuance_intents" TO "app_api";
--> statement-breakpoint
GRANT INSERT (
  "id", "environment", "purpose", "recipient_email", "callback_identifier",
  "invitation_id", "generation", "dispatch_not_after"
) ON TABLE "app"."action_link_issuance_intents" TO "app_api";
--> statement-breakpoint
GRANT UPDATE (
  "status", "consumed_at", "superseded_at", "cancelled_at", "updated_at"
) ON TABLE "app"."action_link_issuance_intents" TO "app_api";
--> statement-breakpoint
GRANT INSERT (
  "event_id", "event_type", "aggregate_type", "aggregate_id", "aggregate_version",
  "idempotency_key", "payload", "correlation_id", "available_at"
) ON TABLE "app"."outbox_events" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."operation_idempotency" TO "app_api";
--> statement-breakpoint
GRANT SELECT ON TABLE "app"."audit_events" TO "app_api";
--> statement-breakpoint
GRANT INSERT (
  "event_id", "actor_user_id", "organization_id", "action", "target_type",
  "target_id", "result", "request_id", "correlation_id", "metadata"
) ON TABLE "app"."audit_events" TO "app_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."security_tombstone_mutations" TO "app_api";
--> statement-breakpoint
GRANT SELECT ON TABLE "app"."security_tombstone_state" TO "app_api";
--> statement-breakpoint
GRANT UPDATE (
  "contiguous_high_water", "access_closed", "closure_reason", "version", "updated_at"
) ON TABLE "app"."security_tombstone_state" TO "app_api";
--> statement-breakpoint
GRANT SELECT ON TABLE "app"."invitation_continuations" TO "app_api";
--> statement-breakpoint
GRANT INSERT (
  "id", "invitation_id", "action_intent_id", "secret_hash", "expires_at"
) ON TABLE "app"."invitation_continuations" TO "app_api";
--> statement-breakpoint
GRANT UPDATE ("consumed_at") ON TABLE "app"."invitation_continuations" TO "app_api";
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "app"."audit_events_sequence_seq" TO "app_api";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."require_prepared_tombstone"(text[]) TO "app_api";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."jsonb_has_forbidden_key"(jsonb, text[]) TO "app_api", "app_worker";
--> statement-breakpoint
GRANT SELECT ON TABLE
  "app"."organization",
  "app"."invitation",
  "app"."action_link_issuance_intents",
  "app"."outbox_events",
  "app"."delivery_attempts"
TO "app_worker";
--> statement-breakpoint
GRANT UPDATE ("updatedAt") ON TABLE "app"."invitation" TO "app_worker";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."verification" TO "app_worker";
--> statement-breakpoint
GRANT UPDATE (
  "status", "key_version", "token_hash", "stable_message_id", "issued_at", "expires_at", "updated_at"
) ON TABLE "app"."action_link_issuance_intents" TO "app_worker";
--> statement-breakpoint
GRANT UPDATE (
  "status", "available_at", "claimed_at", "claimed_by", "lease_expires_at", "dispatch_attempts",
  "pg_boss_job_id", "dispatched_at", "exhausted_at", "failure_code", "updated_at"
) ON TABLE "app"."outbox_events" TO "app_worker";
--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE "app"."delivery_attempts" TO "app_worker";
--> statement-breakpoint
GRANT INSERT (
  "event_id", "actor_user_id", "organization_id", "action", "target_type",
  "target_id", "result", "request_id", "correlation_id", "metadata"
) ON TABLE "app"."audit_events" TO "app_worker";
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "app"."audit_events_sequence_seq" TO "app_worker";
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA "app" TO "backup_reader";
--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app" TO "backup_reader";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" REVOKE ALL ON SEQUENCES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" REVOKE ALL ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "backup_reader";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON SEQUENCES TO "backup_reader";
