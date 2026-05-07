import { bool, envsafe, str } from "envsafe";

export const restoreEnv = envsafe({
    S3_ACCESS_KEY: str(),
    S3_SECRET_KEY: str(),
    S3_BUCKET: str(),
    S3_REGION: str(),
    S3_ENDPOINT: str({
        desc: "The S3 custom endpoint you want to use.",
        default: "",
        allowEmpty: true,
    }),
    S3_FORCE_PATH_STYLE: bool({
        desc: "Use path style for the endpoint instead of the default subdomain style, useful for MinIO",
        default: false,
        allowEmpty: true,
    }),
    BACKUP_FILE_PREFIX: str({
        desc: "Prefix to the backup file name when RESTORE_LATEST is used.",
        default: "backup",
    }),
    BUCKET_SUBFOLDER: str({
        desc: "S3 subfolder containing backup files.",
        default: "",
        allowEmpty: true,
    }),
    TARGET_DATABASE_URL: str({
        desc: "The fresh PostgreSQL database connection string to restore into.",
    }),
    RESTORE_ENABLED: bool({
        desc: "Must be true before any restore can run.",
        default: false,
    }),
    RESTORE_CONFIRM_TARGET_IS_DISPOSABLE: bool({
        desc: "Must be true to confirm the target database can be discarded/recreated if restore fails.",
        default: false,
    }),
    RESTORE_REQUIRE_EMPTY: bool({
        desc: "Require the target database to contain no non-system tables before restore.",
        default: true,
    }),
    RESTORE_S3_KEY: str({
        desc: "Exact S3 object key to restore, preferred for safety.",
        default: "",
        allowEmpty: true,
    }),
    RESTORE_LATEST: bool({
        desc: "Restore the newest backup matching BACKUP_FILE_PREFIX/BUCKET_SUBFOLDER if RESTORE_S3_KEY is empty.",
        default: false,
    }),
    RESTORE_CREATE_EXTENSIONS: str({
        desc: "Comma-separated list of extensions to create before restore, e.g. pg_trgm,vector.",
        default: "",
        allowEmpty: true,
    }),
    RESTORE_VERIFY_TABLES: str({
        desc: 'Comma-separated table names to count after restore, e.g. public.user,public.orders. Quote-sensitive names can use public."user".',
        default: "",
        allowEmpty: true,
    }),
    RESTORE_PLAN_ONLY: bool({
        desc: "Print selected backup and target preflight, then exit without changing the database.",
        default: false,
    }),
    DISCORD_WEBHOOK_URL: str({
        desc: "Optional Discord webhook URL for restore success/failure notifications.",
        default: "",
        allowEmpty: true,
    }),
});
