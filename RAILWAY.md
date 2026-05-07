# Deploy and Host Postgres S3 Backups on Railway

Postgres S3 Backups is a lightweight Bun application that dumps your PostgreSQL database and uploads compressed backups to any S3-compatible storage. It runs a single backup on startup and exits—pair it with Railway Cron for automated, scheduled backups.

## About Hosting Postgres S3 Backups

Deploying this template gives you a service that performs full PostgreSQL backups (pg_dump) and stores them in S3-compatible object storage. The service runs once per invocation, making it ideal for cron-triggered deployments. You'll need a Postgres database to backup and S3 credentials (AWS S3, Cloudflare R2, Backblaze B2, or any S3-compatible provider). Configure environment variables for your storage provider, link your Postgres database, and set up Railway Cron to run backups on your preferred schedule (e.g., daily at 5 AM).

## Common Use Cases

- **Automated database backups** – Schedule daily or hourly backups of your production Postgres database
- **Disaster recovery** – Store backups off-site in S3 for quick restoration
- **Cost-effective storage** – Use Cloudflare R2 or Backblaze B2 for cheaper backup storage than AWS S3
- **Retention management** – Use `MAX_BACKUPS` to automatically prune old backups and control storage costs
- **Discord notifications** – Get rich embed notifications on success or failure by configuring a Discord webhook URL

## Dependencies for Postgres S3 Backups Hosting

- **PostgreSQL** – The database to backup (add via Railway Postgres or use an external connection string)
- **S3-compatible storage** – AWS S3, Cloudflare R2, Backblaze B2, MinIO, or any S3-compatible service

### Deployment Dependencies

- [PostgreSQL pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Cloudflare R2 S3 API](https://developers.cloudflare.com/r2/api/s3/)
- [Backblaze B2 S3-compatible API](https://www.backblaze.com/b2/docs/s3_compatible_api.html)

### Implementation Details

Set up Railway Cron to trigger this service on a schedule. For example, a cron expression of `0 5 * * *` runs the backup daily at 5:00 AM UTC. The service will start, run one backup, and exit—Railway Cron handles the scheduling.

**Discord notifications (optional):** Set `DISCORD_WEBHOOK_URL` to receive embed notifications in a Discord channel. On success, you'll get a green embed with the backup filename, size, and timestamp. On failure, you'll receive a red embed with the error message. Create a webhook in your Discord server under Server Settings → Integrations → Webhooks.

**Restores:** This repo includes a separate manual restore command, `bun run restore`, intended for a second on-demand Railway service. Create a fresh Railway Postgres database, configure `TARGET_DATABASE_URL`, `RESTORE_ENABLED=true`, `RESTORE_CONFIRM_TARGET_IS_DISPOSABLE=true`, and either `RESTORE_S3_KEY` or `RESTORE_LATEST=true`, then trigger the restore service manually.

## Why Deploy Postgres S3 Backups on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Postgres S3 Backups on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
