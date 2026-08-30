CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
COMMENT ON SCHEMA "app" IS 'Esmii application schema';
--> statement-breakpoint
GRANT USAGE ON SCHEMA "app" TO "app_api", "app_worker";
