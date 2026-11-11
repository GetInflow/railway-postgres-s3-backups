# Restoring a Postgres S3 Backup

This repo can run a second, manual Railway service that restores backups created by the backup service.

The backup service writes directly compressed PostgreSQL custom-format archives:

```text
backup-YYYY-MM-DDTHH-MM-SS-sssZ.dump
```

The restore service downloads the selected S3 object to local restore-runner storage, validates it, and then restores it into a fresh PostgreSQL database. Keeping the S3 transfer separate from `pg_restore` prevents a network or download failure from modifying the target database. Legacy gzip-compressed `.tar.gz` backups remain supported during migration.

## Recommended Railway setup

Use the same repository with two Railway services:

1. **Postgres S3 Backup**
    - normal scheduled service
    - command: default `bun run src/index.ts`

2. **Postgres S3 Restore**
    - no cron schedule
    - manually triggered only
    - custom start command: `bun run restore`
    - dedicated volume mounted at `/restore-cache`

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
RESTORE_WORK_DIR=/restore-cache
```

If using Cloudflare R2, MinIO, Backblaze, etc. also configure the same S3 settings as the backup service:

```env
S3_ENDPOINT=...
S3_FORCE_PATH_STYLE=false
```

## Select a backup

Preferred: restore an exact S3 key.

```env
RESTORE_S3_KEY=backups/backup-2026-05-07T12-00-00-000Z.dump
```

Or restore the newest matching backup:

```env
RESTORE_LATEST=true
BACKUP_FILE_PREFIX=backup
BUCKET_SUBFOLDER=backups
```

Exact `RESTORE_S3_KEY` is safer because it avoids accidentally restoring a newer/older backup than intended. `RESTORE_LATEST=true` considers both current `.dump` files and legacy `.tar.gz` files, then selects the newest matching object.

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

Disable the empty-target check only for advanced/manual recovery work:

```env
RESTORE_REQUIRE_EMPTY=false
```

Configure complete-download retries (default `3`):

```env
RESTORE_DOWNLOAD_ATTEMPTS=3
```

Custom-format archives can optionally use parallel restore jobs:

```env
RESTORE_JOBS=1
```

Keep `RESTORE_JOBS=1` for the first production-sized restore test. Every additional job increases concurrency, database connections, and target load.

## Restore-runner storage

Mount a dedicated Railway volume on the restore runner at `/restore-cache`. This is separate from the volume attached to the disposable PostgreSQL service.

Allow enough space for the largest compressed backup plus operating margin:

- current 4.91 GB archive: at least 10–15 GB
- archives approaching 10 GB: at least 20 GB
- legacy `.tar.gz` archives: enough for both the compressed archive and decompressed `.tar`

The service checks free space against the compressed S3 object before downloading. It also removes stale restore files before a new download and cleans up local files after success or failure.

## Manual trigger flow

1. Create a fresh Railway Postgres database in the target region.
2. Add a separate Railway service from this repo named something like `Postgres S3 Restore`.
3. Set its custom start command to:

    ```bash
    bun run restore
    ```

4. Set the required restore environment variables.
5. Attach the restore-runner volume and set `RESTORE_WORK_DIR` to its mount path.
6. Optionally run once with:

    ```env
    RESTORE_PLAN_ONLY=true
    ```

    to verify the selected backup and target.

7. Remove `RESTORE_PLAN_ONLY` or set it to `false`.
8. Manually deploy/run the restore service.
9. Check logs for:
    - selected S3 backup key
    - target DB version/user
    - target table count before restore
    - download attempts and percentage
    - archive size and validation
    - periodic restore heartbeat and runner memory
    - `pg_restore` completion
    - verification summary

## Restore implementation

Equivalent command for current custom-format backups:

```bash
pg_restore \
  --exit-on-error \
  --dbname="$TARGET_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  backup.dump
```

The service performs these stages:

1. Select the exact or latest backup with the S3 API.
2. Run target safety checks.
3. Download with `aws s3 cp` to a `.part` file.
4. Check the local size against S3 metadata and atomically rename the completed file.
5. Validate it with `pg_restore --list`.
6. Create configured extensions.
7. Restore from the local file and verify the target.
8. Delete local restore files.

AWS CLI runs as a child process, so Bun does not relay the multi-gigabyte backup into `pg_restore`. AWS request retries use standard mode with five attempts, and the complete download is retried according to `RESTORE_DOWNLOAD_ATTEMPTS`.

Legacy `.tar.gz` archives are downloaded and decompressed to a local `.tar` before validation and restore.

## Performance note

Custom format supports `pg_restore --jobs=N` because the downloaded archive is a regular seekable file. The default remains one job to minimize database connections and resource use. Increase `RESTORE_JOBS` only after observing the disposable target's CPU, memory, disk, WAL, and connection usage.

Restore percentage is available during the download. PostgreSQL does not expose a reliable overall percentage during `pg_restore`, so that stage emits elapsed-time and runner-memory heartbeats instead.
