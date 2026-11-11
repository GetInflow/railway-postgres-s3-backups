import {
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
    S3ClientConfig,
} from "@aws-sdk/client-s3";
import { ChildProcess, spawn } from "child_process";
import { mkdir, open, rename, rm, stat, statfs, writeFile } from "fs/promises";
import { join } from "path";
import { filesize } from "filesize";

import { restoreEnv as env } from "./restore-env.js";

type BackupFormat = "custom" | "legacy-tar-gzip";

type BackupObject = {
    key: string;
    format: BackupFormat;
    size?: number;
    lastModified?: Date;
};

type ProcessResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
};

type LocalBackup = {
    archivePath: string;
    restorePath: string;
    cleanupPaths: string[];
};

const captureLimit = 20_000;
let activeChild: ChildProcess | undefined;
let receivedSignal: NodeJS.Signals | undefined;

const capture = (current: string, chunk: string) =>
    (current + chunk).slice(Math.max(0, current.length + chunk.length - captureLimit));

const elapsed = (startedAt: number) => `${Math.round((Date.now() - startedAt) / 1000)}s`;

const memoryUsage = () => filesize(process.memoryUsage().rss);

const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

const backupFormat = (key: string): BackupFormat | undefined => {
    if (key.endsWith(".dump")) return "custom";
    if (key.endsWith(".tar.gz")) return "legacy-tar-gzip";
    return undefined;
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

const throwIfTerminationRequested = () => {
    if (receivedSignal) {
        throw new Error(`Restore interrupted by ${receivedSignal}.`);
    }
};

const runProcess = async (
    name: string,
    args: string[],
    options: {
        env?: NodeJS.ProcessEnv;
        inheritOutput?: boolean;
        heartbeat?: () => void | Promise<void>;
        heartbeatIntervalMs?: number;
    } = {},
): Promise<ProcessResult> => {
    throwIfTerminationRequested();

    const child = spawn(name, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
    });
    activeChild = child;

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
        stdout = capture(stdout, chunk);
        if (options.inheritOutput) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
        stderr = capture(stderr, chunk);
        if (options.inheritOutput) process.stderr.write(chunk);
    });

    const heartbeat =
        options.heartbeat &&
        setInterval(() => {
            void Promise.resolve(options.heartbeat?.()).catch((error) => {
                console.warn(`Progress check failed: ${String(error)}`);
            });
        }, options.heartbeatIntervalMs ?? 30_000);
    heartbeat?.unref();

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
        },
    ).finally(() => {
        if (heartbeat) clearInterval(heartbeat);
        if (activeChild === child) activeChild = undefined;
    });

    return {
        ...exit,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
    };
};

const safeCommand = (name: string, args: string[]) =>
    `${name} ${args
        .map((arg) => {
            if (arg === env.TARGET_DATABASE_URL) return "***";
            if (arg.startsWith("--dbname=")) return "--dbname=***";
            return arg;
        })
        .join(" ")}`;

const command = async (name: string, args: string[]): Promise<string> => {
    const result = await runProcess(name, args);

    if (result.code !== 0) {
        throw new Error(
            `${safeCommand(name, args)} failed with exit code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}${result.stderr ? `: ${result.stderr}` : ""}`,
        );
    }

    return result.stdout || result.stderr;
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
        const format = backupFormat(env.RESTORE_S3_KEY);
        if (!format) {
            throw new Error("RESTORE_S3_KEY must identify a .dump or legacy .tar.gz backup.");
        }
        const response = await client.send(
            new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: env.RESTORE_S3_KEY }),
        );
        return {
            key: env.RESTORE_S3_KEY,
            format,
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
            const format = backupFormat(item.Key);
            if (!format) continue;
            objects.push({
                key: item.Key,
                format,
                size: item.Size,
                lastModified: item.LastModified,
            });
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    objects.sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));

    const latest = objects[0];
    if (!latest) {
        throw new Error(`No .dump or .tar.gz backups found in s3://${env.S3_BUCKET}/${prefix}`);
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

const assertRestoreSettings = () => {
    for (const [name, value] of [
        ["RESTORE_DOWNLOAD_ATTEMPTS", env.RESTORE_DOWNLOAD_ATTEMPTS],
        ["RESTORE_JOBS", env.RESTORE_JOBS],
    ] as const) {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`${name} must be a positive integer.`);
        }
    }
};

const prepareWorkDirectory = async (backup: BackupObject) => {
    await mkdir(env.RESTORE_WORK_DIR, { recursive: true });

    if (backup.size === undefined) return;

    const filesystem = await statfs(env.RESTORE_WORK_DIR);
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    const required = backup.size + 256 * 1024 * 1024;
    console.log(`Restore workspace: ${env.RESTORE_WORK_DIR} (${filesize(available)} available)`);

    if (available < required) {
        throw new Error(
            `Insufficient restore workspace: ${filesize(available)} available, at least ${filesize(required)} required for this archive.`,
        );
    }
};

const awsEnvironment = (configPath?: string): NodeJS.ProcessEnv => ({
    ...process.env,
    AWS_ACCESS_KEY_ID: env.S3_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: env.S3_SECRET_KEY,
    AWS_DEFAULT_REGION: env.S3_REGION,
    AWS_RETRY_MODE: "standard",
    AWS_MAX_ATTEMPTS: "5",
    AWS_PAGER: "",
    AWS_EC2_METADATA_DISABLED: "true",
    ...(configPath ? { AWS_CONFIG_FILE: configPath } : {}),
});

const restoreCleanupPaths = () => [
    join(env.RESTORE_WORK_DIR, "selected-backup.dump.part"),
    join(env.RESTORE_WORK_DIR, "selected-backup.dump"),
    join(env.RESTORE_WORK_DIR, "selected-backup.tar.gz.part"),
    join(env.RESTORE_WORK_DIR, "selected-backup.tar.gz"),
    join(env.RESTORE_WORK_DIR, "selected-backup.tar"),
    join(env.RESTORE_WORK_DIR, "aws-config"),
];

const downloadBackup = async (backup: BackupObject): Promise<LocalBackup> => {
    assertRestoreSettings();
    await prepareWorkDirectory(backup);

    const archiveName =
        backup.format === "custom" ? "selected-backup.dump" : "selected-backup.tar.gz";
    const archivePath = join(env.RESTORE_WORK_DIR, archiveName);
    const partialPath = `${archivePath}.part`;
    const legacyTarPath = join(env.RESTORE_WORK_DIR, "selected-backup.tar");
    const configPath = join(env.RESTORE_WORK_DIR, "aws-config");
    const cleanupPaths = restoreCleanupPaths();

    await Promise.all(cleanupPaths.map((path) => rm(path, { force: true })));

    if (env.S3_FORCE_PATH_STYLE) {
        await writeFile(configPath, "[default]\ns3 =\n    addressing_style = path\n", {
            mode: 0o600,
        });
    }

    const source = `s3://${env.S3_BUCKET}/${backup.key}`;
    const args = ["s3", "cp", source, partialPath, "--no-progress", "--only-show-errors"];
    if (env.S3_ENDPOINT) args.push("--endpoint-url", env.S3_ENDPOINT);

    console.log(`\nDownloading ${source} to ${archivePath}`);
    const startedAt = Date.now();
    let lastError = "";

    for (let attempt = 1; attempt <= env.RESTORE_DOWNLOAD_ATTEMPTS; attempt += 1) {
        await rm(partialPath, { force: true });
        console.log(`Download attempt ${attempt}/${env.RESTORE_DOWNLOAD_ATTEMPTS}`);

        const result = await runProcess("aws", args, {
            env: awsEnvironment(env.S3_FORCE_PATH_STYLE ? configPath : undefined),
            inheritOutput: true,
            heartbeatIntervalMs: 15_000,
            heartbeat: async () => {
                try {
                    const downloaded = (await stat(partialPath)).size;
                    const percentage =
                        backup.size && backup.size > 0
                            ? ` (${Math.min(100, (downloaded / backup.size) * 100).toFixed(1)}%)`
                            : "";
                    console.log(
                        `Download progress: ${filesize(downloaded)}${percentage}, elapsed ${elapsed(startedAt)}, runner RSS ${memoryUsage()}`,
                    );
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            },
        });

        throwIfTerminationRequested();

        if (result.code === 0) {
            lastError = "";
            break;
        }

        lastError = `aws s3 cp failed with exit code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}${result.stderr ? `: ${result.stderr}` : ""}`;
        if (attempt < env.RESTORE_DOWNLOAD_ATTEMPTS) {
            const delaySeconds = 5 * 2 ** (attempt - 1);
            console.warn(`${lastError}\nRetrying download in ${delaySeconds}s.`);
            await sleep(delaySeconds * 1000);
        }
    }

    if (lastError) throw new Error(lastError);

    const downloadedSize = (await stat(partialPath)).size;
    if (backup.size !== undefined && downloadedSize !== backup.size) {
        throw new Error(
            `Downloaded size mismatch: expected ${backup.size} bytes, received ${downloadedSize} bytes.`,
        );
    }

    await rename(partialPath, archivePath);
    console.log(
        `Download completed: ${filesize(downloadedSize)} in ${elapsed(startedAt)}; runner RSS ${memoryUsage()}.`,
    );

    let restorePath = archivePath;
    if (backup.format === "legacy-tar-gzip") {
        restorePath = legacyTarPath;
        console.log(`Decompressing legacy archive to ${restorePath}`);
        await decompressLegacyArchive(archivePath, restorePath);
    }

    console.log("Validating downloaded archive with pg_restore --list...");
    await command("pg_restore", ["--list", restorePath]);
    console.log("Archive validation completed.");

    return { archivePath, restorePath, cleanupPaths };
};

const decompressLegacyArchive = async (archivePath: string, outputPath: string) => {
    const startedAt = Date.now();
    const output = await open(outputPath, "w");
    let child: ChildProcess | undefined;
    let stderr = "";
    const heartbeat = setInterval(() => {
        void stat(outputPath)
            .then((file) => {
                console.log(
                    `Legacy decompression progress: ${filesize(file.size)}, elapsed ${elapsed(startedAt)}, runner RSS ${memoryUsage()}.`,
                );
            })
            .catch((error) => {
                console.warn(`Legacy decompression progress check failed: ${String(error)}`);
            });
    }, 15_000);
    heartbeat.unref();

    try {
        child = spawn("gzip", ["-dc", archivePath], {
            stdio: ["ignore", output.fd, "pipe"],
            env: process.env,
        });
        activeChild = child;
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr = capture(stderr, chunk);
            process.stderr.write(chunk);
        });

        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
                child?.once("error", reject);
                child?.once("close", (code, signal) => resolve({ code, signal }));
            },
        );

        if (result.code !== 0) {
            throw new Error(
                `gzip failed with exit code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}${stderr ? `: ${stderr.trimEnd()}` : ""}`,
            );
        }
    } finally {
        clearInterval(heartbeat);
        if (child && activeChild === child) activeChild = undefined;
        await output.close();
    }

    console.log(
        `Legacy decompression completed in ${elapsed(startedAt)} (${filesize((await stat(outputPath)).size)}).`,
    );
};

const restoreFromFile = async (backup: BackupObject, local: LocalBackup) => {
    const startedAt = Date.now();
    const pgRestoreFormat = backup.format === "custom" ? "custom" : "tar";
    const args = [
        "--exit-on-error",
        `--dbname=${env.TARGET_DATABASE_URL}`,
        `--format=${pgRestoreFormat}`,
        "--no-owner",
        "--no-privileges",
    ];

    if (backup.format === "custom" && env.RESTORE_JOBS > 1) {
        args.push(`--jobs=${env.RESTORE_JOBS}`);
    }
    args.push(local.restorePath);

    console.log(`\nRestoring local archive: ${local.restorePath}`);
    console.log(`Running: ${safeCommand("pg_restore", args)}`);

    const result = await runProcess("pg_restore", args, {
        inheritOutput: true,
        heartbeatIntervalMs: 30_000,
        heartbeat: () => {
            console.log(
                `Restore still running: elapsed ${elapsed(startedAt)}, runner RSS ${memoryUsage()}.`,
            );
        },
    });

    if (result.code !== 0) {
        throw new Error(
            `pg_restore failed with exit code ${result.code}${result.signal ? ` signal ${result.signal}` : ""}${result.stderr ? `\npg_restore stderr:\n${result.stderr}` : ""}${result.stdout ? `\npg_restore stdout:\n${result.stdout}` : ""}`,
        );
    }

    console.log(`Restore completed in ${elapsed(startedAt)}; runner RSS ${memoryUsage()}.`);
};

const cleanupLocalBackup = async (local: LocalBackup | undefined) => {
    console.log("Deleting local restore files...");
    const results = await Promise.allSettled(
        (local?.cleanupPaths ?? restoreCleanupPaths()).map((path) => rm(path, { force: true })),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
        console.warn(`Failed to delete ${failures.length} local restore file(s).`);
    }
};

const preflight = async (backup: BackupObject) => {
    console.log("Restore preflight");
    console.log(`Selected backup key: ${backup.key}`);
    console.log(`Selected backup format: ${backup.format}`);
    if (backup.size !== undefined) console.log(`Selected backup size: ${filesize(backup.size)}`);
    if (backup.lastModified)
        console.log(`Selected backup last modified: ${backup.lastModified.toISOString()}`);
    if (env.S3_ENDPOINT) console.log(`Using custom S3 endpoint: ${env.S3_ENDPOINT}`);

    console.log("\nClient versions");
    console.log(await command("pg_restore", ["--version"]));
    console.log(await command("psql", ["--version"]));
    console.log(await command("aws", ["--version"]));

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
    assertRestoreSettings();

    const client = createS3Client();
    let local: LocalBackup | undefined;

    try {
        const backup = await selectBackup(client);

        await preflight(backup);

        if (env.RESTORE_PLAN_ONLY) {
            console.log(
                "RESTORE_PLAN_ONLY=true, exiting before downloading or modifying the target database.",
            );
            return;
        }

        try {
            local = await downloadBackup(backup);
            await createExtensions();
            await restoreFromFile(backup, local);
            await verify();
        } finally {
            await cleanupLocalBackup(local);
        }
    } finally {
        client.destroy();
    }
};

const handleSignal = (signal: NodeJS.Signals) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    console.error(
        `Received ${signal}; stopping${activeChild ? ` active child process ${activeChild.pid ?? ""}` : " restore"}...`,
    );
    activeChild?.kill(signal);
};

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

try {
    await main();
} catch (error) {
    console.error("Error while running restore:", error);
    if (!process.exitCode) process.exitCode = 1;
}
