import { envsafe, str, bool, num } from "envsafe";

export const env = envsafe({
    S3_ACCESS_KEY: str(),
    S3_SECRET_KEY: str(),
    S3_BUCKET: str(),
    S3_REGION: str(),
    DATABASE_URL: str({
        desc: "The connection string of the database to backup.",
    }),
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
        desc: "Prefix to the file name",
        default: "backup",
    }),
    BUCKET_SUBFOLDER: str({
        desc: "A subfolder to place the backup files in",
        default: "",
        allowEmpty: true,
    }),
    // This is both time consuming and resource intensive so we leave it disabled by default
    SUPPORT_OBJECT_LOCK: bool({
        desc: "Enables support for buckets with object lock by providing an MD5 hash with the backup file",
        default: false,
    }),
    BACKUP_OPTIONS: str({
        desc: "Any valid pg_dump option.",
        default: "",
        allowEmpty: true,
    }),
    BACKUP_COMPRESSION: str({
        desc: "Compression method and level for the PostgreSQL custom-format archive.",
        default: "gzip:6",
    }),
    MAX_BACKUPS: num({
        desc: "Maximum number of backups to keep in S3. Oldest backups are deleted when exceeded. 0 = unlimited.",
        default: 10,
        allowEmpty: true,
    }),
});
