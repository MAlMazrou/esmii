#!/bin/sh
set -eu

read_secret() {
  secret_path="$1"
  if [ ! -r "$secret_path" ]; then
    printf '%s\n' "Required development secret file is unavailable." >&2
    exit 1
  fi

  IFS= read -r secret_value < "$secret_path"
  if [ -z "$secret_value" ]; then
    printf '%s\n' "Required development secret file is empty." >&2
    exit 1
  fi

  printf '%s' "$secret_value"
}

migration_password="$(read_secret /run/secrets/development_postgres_migration_password)"
api_password="$(read_secret /run/secrets/development_postgres_api_password)"
worker_password="$(read_secret /run/secrets/development_postgres_worker_password)"

psql --set=ON_ERROR_STOP=1 \
  --set=migration_password="$migration_password" \
  --set=api_password="$api_password" \
  --set=worker_password="$worker_password" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<-'SQL'
	CREATE ROLE app_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migration_password';
	CREATE ROLE app_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'api_password';
	CREATE ROLE app_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'worker_password';
	CREATE ROLE backup_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

	CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

	ALTER DATABASE esmii OWNER TO app_owner;
	ALTER SCHEMA public OWNER TO app_owner;
	REVOKE CREATE ON SCHEMA public FROM PUBLIC;
	REVOKE ALL ON DATABASE esmii FROM PUBLIC;
	GRANT CONNECT ON DATABASE esmii TO app_owner, app_api, app_worker, backup_reader;
	GRANT USAGE ON SCHEMA public TO app_api, app_worker;
SQL

unset migration_password api_password worker_password
