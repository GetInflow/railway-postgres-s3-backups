# Restoring a Postgres S3 Backup

This repo can run a second, manual Railway service that restores backups created by the backup service.

The backup service currently writes gzip-compressed tar archives:

```text
backup-YYYY-MM-DDTHH-MM-SS-sssZ.tar.gz
```

The restore service streams the selected S3 object through gzip into `pg_restore` and restores it into a fresh PostgreSQL database.

## Recommended Railway setup

Use the same repository with two Railway services:

1. **Postgres S3 Backup**
    - normal scheduled service
    - command: default `bun run src/index.ts`

2. **Postgres S3 Restore**
    - no cron schedule
    - manually triggered only
    - custom start command: `bun run restore`

Create a new/fresh Railway Postgres instance in the desired region, then point the restore service at that database with `TARGET_DATABASE_URL`.

## Safety rules

- Restore only into a fresh disposable Postgres instance.
- Do not restore into an existing production database.
- The restore service refuses to run unless `RESTORE_ENABLED=true` and `RESTORE_CONFIRM_TARGET_IS_DISPOSABLE=true`.
- By default the target must have zero non-system tables.
- If restore fails halfway, create another fresh Postgres instance and rerun. Do not try to surgically clean up a partial restore unless you know exactly what happened.

## Required environment variables

```env
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=...
TARGET_DATABASE_URL=...
RESTORE_ENABLED=true
RESTORE_CONFIRM_TARGET_IS_DISPOSABLE=true
```

If using Cloudflare R2, MinIO, Backblaze, etc. also configure the same S3 settings as the backup service:

```env
S3_ENDPOINT=...
S3_FORCE_PATH_STYLE=false
```

## Select a backup

Preferred: restore an exact S3 key.

```env
RESTORE_S3_KEY=backups/backup-2026-05-07T12-00-00-000Z.tar.gz
```

Or restore the newest matching backup:

```env
RESTORE_LATEST=true
BACKUP_FILE_PREFIX=backup
BUCKET_SUBFOLDER=backups
```

Exact `RESTORE_S3_KEY` is safer because it avoids accidentally restoring a newer/older backup than intended.

## Optional environment variables

Create extensions before restore:

```env
RESTORE_CREATE_EXTENSIONS=pg_trgm,vector,uuid-ossp,dblink
```

Count specific tables after restore:

```env
RESTORE_VERIFY_TABLES=public."user",public.orders
```

Dry-run the restore plan without mutating the database:

```env
RESTORE_PLAN_ONLY=true
```

Send Discord notifications:

```env
DISCORD_WEBHOOK_URL=...
```

Disable the empty-target check only for advanced/manual recovery work:

```env
RESTORE_REQUIRE_EMPTY=false
```

## Manual trigger flow

1. Create a fresh Railway Postgres database in the target region.
2. Add a separate Railway service from this repo named something like `Postgres S3 Restore`.
3. Set its custom start command to:

    ```bash
    bun run restore
    ```

4. Set the required restore environment variables.
5. Optionally run once with:

    ```env
    RESTORE_PLAN_ONLY=true
    ```

    to verify the selected backup and target.

6. Remove `RESTORE_PLAN_ONLY` or set it to `false`.
7. Manually deploy/run the restore service.
8. Check logs for:
    - selected S3 backup key
    - target DB version/user
    - target table count before restore
    - `pg_restore` completion
    - verification summary

## Restore implementation

Equivalent command:

```bash
gzip -dc backup.tar.gz | pg_restore \
  --exit-on-error \
  --dbname="$TARGET_DATABASE_URL" \
  --format=tar \
  --no-owner \
  --no-privileges
```

The service streams from S3 rather than downloading the full backup to local disk.

## Performance note

The current backup format is gzip-compressed tar, so `pg_restore --jobs=N` parallel restore is not available. If faster restores become important, add a future backup mode using custom or directory format.
