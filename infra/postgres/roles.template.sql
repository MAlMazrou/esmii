-- Non-secret reference for the development and future rendered host role shape.
-- Passwords are supplied through generated or root-owned secret files, never here.
CREATE ROLE app_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<MIGRATION_ROLE_PASSWORD>';
CREATE ROLE app_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<API_ROLE_PASSWORD>';
CREATE ROLE app_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<WORKER_ROLE_PASSWORD>';
CREATE ROLE backup_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE esmii FROM PUBLIC;
GRANT CONNECT ON DATABASE esmii TO app_owner, app_api, app_worker, backup_reader;
GRANT USAGE ON SCHEMA public TO app_api, app_worker;

-- Migrations owned by app_owner must add table-specific runtime grants and
-- explicit default privileges. Never grant all application or pg-boss tables
-- to both runtime roles as a convenience.
