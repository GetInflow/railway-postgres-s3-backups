import {
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
    S3ClientConfig,
} from "@aws-sdk/client-s3";
import { spawn } from "child_process";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { filesize } from "filesize";

import { sendDiscordNotification } from "./discord.js";
import { restoreEnv as env } from "./restore-env.js";

type BackupObject = {
    key: string;
    size?: number;
    lastModified?: Date;
};

const createS3Client = () => {
    const clientOptions: S3ClientConfig = {
        region: env.S3_REGION,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: env.S3_ACCESS_KEY,
            secretAccessKey: env.S3_SECRET_KEY,
        },
    };
    if (env.S3_ENDPOINT) {
        clientOptions.endpoint = env.S3_ENDPOINT;
    }
    return new S3Client(clientOptions);
};

const parseCsv = (value: string) =>
    value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

const backupPrefix = () => {
    const prefix = `${env.BACKUP_FILE_PREFIX}-`;
    return env.BUCKET_SUBFOLDER ? `${env.BUCKET_SUBFOLDER}/${prefix}` : prefix;
};

const quoteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const quoteQualifiedIdentifier = (identifier: string) => {
    const parts = identifier.match(/(?:"[^"]*(?:""[^"]*)*"|[^.])+/g);
    if (!parts || parts.length === 0) {
        throw new Error(`Invalid identifier: ${identifier}`);
    }

    return parts
        .map((part) => {
            const trimmed = part.trim();
            if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
                return trimmed;
            }
            return quoteIdentifier(trimmed);
        })
        .join(".");
};

const command = async (
    name: string,
    args: string[],
    options: { input?: string; inheritOutput?: boolean } = {},
): Promise<string> => {
    const child = spawn(name, args, {
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.inheritOutput) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (options.inheritOutput) process.stderr.write(chunk);
    });

    if (options.input && child.stdin) {
        child.stdin.end(options.input);
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });

    if (exitCode !== 0) {
        const safeArgs = args.map((arg) => {
            if (arg === env.TARGET_DATABASE_URL) return "***";
            if (arg.startsWith("--dbname=")) return "--dbname=***";
            return arg;
        });
        throw new Error(
            `${name} ${safeArgs.join(" ")} failed with exit code ${exitCode}${stderr ? `: ${stderr.trimEnd()}` : ""}`,
        );
    }

    return stdout.trimEnd();
};

const psql = (args: string[]) => command("psql", [env.TARGET_DATABASE_URL, ...args]);

const psqlValue = async (query: string) => (await psql(["-Atqc", query])).trim();

const psqlPrint = async (label: string, query: string) => {
    console.log(`\n${label}`);
    const output = await psql(["-P", "pager=off", "-c", query]);
    console.log(output);
};

const selectBackup = async (client: S3Client): Promise<BackupObject> => {
    if (env.RESTORE_S3_KEY) {
        const response = await client.send(
            new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: env.RESTORE_S3_KEY }),
        );
        return {
            key: env.RESTORE_S3_KEY,
            size: response.ContentLength,
            lastModified: response.LastModified,
        };
    }

    if (!env.RESTORE_LATEST) {
        throw new Error("Set RESTORE_S3_KEY to an exact backup key or RESTORE_LATEST=true.");
    }

    const prefix = backupPrefix();
    const objects: BackupObject[] = [];
    let continuationToken: string | undefined;

    do {
        const response = await client.send(
            new ListObjectsV2Command({
                Bucket: env.S3_BUCKET,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );

        for (const item of response.Contents ?? []) {
            if (!item.Key) continue;
            if (!item.Key.endsWith(".tar.gz")) continue;
            objects.push({ key: item.Key, size: item.Size, lastModified: item.LastModified });
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    objects.sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));

    const latest = objects[0];
    if (!latest) {
        throw new Error(`No .tar.gz backups found in s3://${env.S3_BUCKET}/${prefix}`);
    }

    return latest;
};

const assertTargetIsSafe = async () => {
    if (!env.RESTORE_ENABLED) {
        throw new Error("RESTORE_ENABLED must be true before restore can run.");
    }

    if (!env.RESTORE_CONFIRM_TARGET_IS_DISPOSABLE) {
        throw new Error(
            "RESTORE_CONFIRM_TARGET_IS_DISPOSABLE must be true. Restore should target a fresh disposable Railway Postgres instance.",
        );
    }

    const tableCount = Number(
        await psqlValue(
            "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema');",
        ),
    );

    console.log(`Target non-system table count: ${tableCount}`);

    if (env.RESTORE_REQUIRE_EMPTY && tableCount !== 0) {
        throw new Error(
            `Target database is not empty (${tableCount} non-system table(s)). Create a fresh Railway Postgres instance and retry.`,
        );
    }
};

const createExtensions = async () => {
    const extensions = parseCsv(env.RESTORE_CREATE_EXTENSIONS);
    if (extensions.length === 0) return;

    console.log(`\nCreating extension(s): ${extensions.join(", ")}`);
    for (const extension of extensions) {
        await psql([
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            `create extension if not exists ${quoteIdentifier(extension)};`,
        ]);
    }
};

const toReadable = (body: unknown): Readable => {
    if (body instanceof Readable) return body;

    if (body && typeof body === "object" && Symbol.asyncIterator in body) {
        return Readable.from(body as AsyncIterable<Uint8Array>);
    }

    if (body && typeof body === "object" && "transformToWebStream" in body) {
        const webStream = (
            body as { transformToWebStream: () => ReadableStream<Uint8Array> }
        ).transformToWebStream();
        return Readable.fromWeb(webStream);
    }

    throw new Error("S3 object body is not a readable stream.");
};

const restoreFromS3 = async (client: S3Client, backup: BackupObject) => {
    console.log(`\nRestoring from s3://${env.S3_BUCKET}/${backup.key}`);
    const startedAt = Date.now();

    const object = await client.send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: backup.key }),
    );
    const body = toReadable(object.Body);

    const args = [
        "--exit-on-error",
        `--dbname=${env.TARGET_DATABASE_URL}`,
        "--format=tar",
        "--no-owner",
        "--no-privileges",
    ];

    console.log(
        `Running: pg_restore ${args.map((arg) => (arg.startsWith("--dbname=") ? "--dbname=***" : arg)).join(" ")}`,
    );

    const pgRestore = spawn("pg_restore", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
    });

    pgRestore.stdout.setEncoding("utf8");
    pgRestore.stderr.setEncoding("utf8");
    pgRestore.stdout.on("data", (chunk: string) => process.stdout.write(chunk));
    pgRestore.stderr.on("data", (chunk: string) => process.stderr.write(chunk));

    const restoreExit = new Promise<void>((resolve, reject) => {
        pgRestore.once("error", reject);
        pgRestore.once("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`pg_restore exited with code ${code}`));
        });
    });

    try {
        await Promise.all([pipeline(body, createGunzip(), pgRestore.stdin), restoreExit]);
    } catch (error) {
        pgRestore.kill();
        throw error;
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`Restore completed in ${elapsedSeconds}s.`);
};

const preflight = async (backup: BackupObject) => {
    console.log("Restore preflight");
    console.log(`Selected backup key: ${backup.key}`);
    if (backup.size !== undefined) console.log(`Selected backup size: ${filesize(backup.size)}`);
    if (backup.lastModified)
        console.log(`Selected backup last modified: ${backup.lastModified.toISOString()}`);
    if (env.S3_ENDPOINT) console.log(`Using custom S3 endpoint: ${env.S3_ENDPOINT}`);

    console.log("\nClient versions");
    console.log(await command("pg_restore", ["--version"]));
    console.log(await command("psql", ["--version"]));

    await psqlPrint("Target database", "select current_database(), current_user, version();");
    await psqlPrint(
        "Installed target extensions",
        "select extname, extversion from pg_extension order by 1;",
    );

    await assertTargetIsSafe();
};

const verify = async () => {
    await psqlPrint(
        "Target restore summary",
        "select 'tables' as metric, count(*)::text as value from information_schema.tables where table_schema not in ('pg_catalog','information_schema') union all select 'sequences', count(*)::text from information_schema.sequences where sequence_schema not in ('pg_catalog','information_schema') union all select 'database_size', pg_size_pretty(pg_database_size(current_database()));",
    );
    await psqlPrint(
        "Installed target extensions",
        "select extname, extversion from pg_extension order by 1;",
    );

    const tables = parseCsv(env.RESTORE_VERIFY_TABLES);
    if (tables.length === 0) return;

    console.log("\nConfigured table row counts");
    for (const table of tables) {
        const count = await psqlValue(`select count(*) from ${quoteQualifiedIdentifier(table)};`);
        console.log(`${table}: ${count}`);
    }
};

const main = async () => {
    console.log("Running restore service...");

    const client = createS3Client();
    const backup = await selectBackup(client);

    await preflight(backup);

    if (env.RESTORE_PLAN_ONLY) {
        console.log(
            "RESTORE_PLAN_ONLY=true, exiting before creating extensions or restoring data.",
        );
        return;
    }

    await createExtensions();
    await restoreFromS3(client, backup);
    await verify();

    await sendDiscordNotification(`✅ Restore complete: \`${backup.key}\``);
};

try {
    await main();
} catch (error) {
    console.error("Error while running restore:", error);
    const message = error instanceof Error ? error.message : String(error);
    await sendDiscordNotification(`❌ Restore failed: ${message}`, {
        isError: true,
        errorTitle: "❌ Restore Failed",
    });
    process.exit(1);
}
