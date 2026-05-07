# Postgres S3 Backups

A simple Bun application to backup your PostgreSQL database to S3. Runs a single backup on startup and exits—schedule it via your platform's cron or scheduler (e.g. Railway Cron).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/postgres-s3-backup?referralCode=5tCsuk&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Quick Start

1. Click **Deploy on Railway** above
2. Add a Postgres database and S3-compatible storage (e.g. AWS S3, Cloudflare R2, Backblaze B2)
3. Configure the required environment variables
4. Set up a cron job to run the service on your desired schedule

## Configuration

- `S3_ACCESS_KEY` - AWS access key ID.

- `S3_SECRET_KEY` - AWS secret access key, sometimes also called an application key.

- `S3_BUCKET` - The name of the bucket that the access key ID and secret access key are authorized to access.

- `S3_REGION` - The name of the region your bucket is located in, set to `auto` if unknown.

- `DATABASE_URL` - The connection string of the database to backup. Defaults to `${{Postgres.DATABASE_URL}}` for Railway.

- `S3_ENDPOINT` - The S3 custom endpoint you want to use. Applicable for 3-rd party S3 services such as Cloudflare R2 or Backblaze R2.

- `S3_FORCE_PATH_STYLE` - Use path style for the endpoint instead of the default subdomain style, useful for MinIO. Default `false`

- `BACKUP_FILE_PREFIX` - Add a prefix to the file name.

- `BUCKET_SUBFOLDER` - Define a subfolder to place the backup files in.

- `SUPPORT_OBJECT_LOCK` - Enables support for buckets with object lock by providing an MD5 hash with the backup file.

- `BACKUP_OPTIONS` - Add any valid pg_dump option, supported pg_dump options can be found [here](https://www.postgresql.org/docs/current/app-pgdump.html). Example: `--exclude-table=pattern`

- `MAX_BACKUPS` - Maximum number of backups to keep in S3. Oldest backups are deleted when exceeded. 0 = unlimited. Default `0`.

- `DISCORD_WEBHOOK_URL` - Optional Discord webhook URL for backup success/failure notifications.

## Restoring Backups

This repo also includes a manual restore entrypoint for restoring these backups into a fresh PostgreSQL database:

```bash
bun run restore
```

Use it as a separate, manually triggered Railway service with `TARGET_DATABASE_URL`, `RESTORE_ENABLED=true`, `RESTORE_CONFIRM_TARGET_IS_DISPOSABLE=true`, and either `RESTORE_S3_KEY` or `RESTORE_LATEST=true`. See [RESTORE.md](./RESTORE.md) for the full restore runbook.

- `BUN_VERSION` - Specify a custom Bun version to override the default version set in the Dockerfile.

- `PG_VERSION` - Specify a custom PostgreSQL version to override the default version set in the Dockerfile.

## Notes for PostgreSQL versions

Set `PG_VERSION` to the major version of the database you are backing up, for example `17` or `18`. The Docker image uses the matching official `postgres:<PG_VERSION>-alpine` client tools so newer versions do not depend on Alpine package availability.
