import { spawn } from "child_process";
import {
    S3Client,
    S3ClientConfig,
    PutObjectCommandInput,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, statSync } from "fs";
import { rm } from "fs/promises";
import { filesize } from "filesize";
import path from "path";
import os from "os";

import { env } from "./env.js";
import { createMD5 } from "./util.js";

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

const uploadToS3 = async ({
    name,
    path: filePath,
}: {
    name: string;
    path: string;
}): Promise<void> => {
    console.log("Uploading backup to S3...");

    const bucket = env.S3_BUCKET;
    const client = createS3Client();

    if (env.S3_ENDPOINT) {
        console.log(`Using custom endpoint: ${env.S3_ENDPOINT}`);
    }

    let s3Key = name;
    if (env.BUCKET_SUBFOLDER) {
        s3Key = env.BUCKET_SUBFOLDER + "/" + name;
    }

    let params: PutObjectCommandInput = {
        Bucket: bucket,
        Key: s3Key,
        Body: createReadStream(filePath),
    };

    if (env.SUPPORT_OBJECT_LOCK) {
        console.log("MD5 hashing file...");

        const md5Hash = await createMD5(filePath);

        console.log("Done hashing file");

        params.ContentMD5 = Buffer.from(md5Hash, "hex").toString("base64");
    }

    await new Upload({
        client,
        params: params,
    }).done();

    console.log("Backup uploaded to S3...");

    if (env.MAX_BACKUPS > 0) {
        const prefix = env.BUCKET_SUBFOLDER
            ? `${env.BUCKET_SUBFOLDER}/${env.BACKUP_FILE_PREFIX}-`
            : `${env.BACKUP_FILE_PREFIX}-`;

        const objects: { Key?: string; LastModified?: Date }[] = [];
        let continuationToken: string | undefined;

        do {
            const listResponse = await client.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
            );
            objects.push(...(listResponse.Contents ?? []));
            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);
        if (objects.length > env.MAX_BACKUPS) {
            const sorted = [...objects].sort(
                (a, b) => (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0),
            );
            const toDelete = sorted.slice(0, objects.length - env.MAX_BACKUPS);

            for (let i = 0; i < toDelete.length; i += 1000) {
                const batch = toDelete.slice(i, i + 1000);
                await client.send(
                    new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: {
                            Objects: batch.map((obj) => ({ Key: obj.Key! })),
                            Quiet: true,
                        },
                    }),
                );
            }

            console.log(`Pruned ${toDelete.length} old backup(s), keeping ${env.MAX_BACKUPS}.`);
        }
    }
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const connectionConfig = (): { databaseUrl: string; env: NodeJS.ProcessEnv } => {
    let databaseUrl: URL;
    try {
        databaseUrl = new URL(env.DATABASE_URL);
    } catch {
        throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }

    if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
        throw new Error("DATABASE_URL must use the postgresql:// or postgres:// protocol.");
    }

    const username = decodeURIComponent(databaseUrl.username);
    const password = decodeURIComponent(databaseUrl.password);
    databaseUrl.username = "";
    databaseUrl.password = "";

    return {
        databaseUrl: databaseUrl.toString(),
        env: {
            ...process.env,
            PGUSER: username,
            PGPASSWORD: password,
            PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || "15",
            PGKEEPALIVES: process.env.PGKEEPALIVES || "1",
            PGKEEPALIVESIDLE: process.env.PGKEEPALIVESIDLE || "60",
            PGKEEPALIVESINTERVAL: process.env.PGKEEPALIVESINTERVAL || "15",
            PGKEEPALIVESCOUNT: process.env.PGKEEPALIVESCOUNT || "4",
        },
    };
};

const runCommand = async (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; captureStdout?: boolean } = {},
) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, {
            env: options.env ?? process.env,
            stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const captureLimit = 20_000;
        const capture = (current: string, chunk: string) =>
            (current + chunk).slice(Math.max(0, current.length + chunk.length - captureLimit));

        child.stdout?.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            stdout = capture(stdout, chunk);
        });
        child.stderr.on("data", (chunk: string) => {
            stderr = capture(stderr, chunk);
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const detail = stderr.trimEnd() || stdout.trimEnd() || "No error output was produced.";
            reject(
                new Error(
                    `${command} failed with exit code ${code}${signal ? ` (signal ${signal})` : ""}: ${detail}`,
                ),
            );
        });
    });

const parseBackupOptions = (value: string): string[] => {
    const args: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let escaping = false;

    const push = () => {
        if (current) args.push(current);
        current = "";
    };

    for (const character of value.trim()) {
        if (escaping) {
            current += character;
            escaping = false;
        } else if (character === "\\" && quote !== "'") {
            escaping = true;
        } else if (quote) {
            if (character === quote) quote = undefined;
            else current += character;
        } else if (character === "'" || character === '"') {
            quote = character;
        } else if (/\s/.test(character)) {
            push();
        } else {
            current += character;
        }
    }

    if (escaping || quote)
        throw new Error("BACKUP_OPTIONS contains an unfinished quote or escape.");
    push();

    const controlledOptions = ["--dbname", "--file", "--format", "--compress"];
    for (const arg of args) {
        const isControlledLongOption = controlledOptions.some(
            (option) => arg === option || arg.startsWith(`${option}=`),
        );
        const isControlledShortOption =
            !arg.startsWith("--") &&
            (arg.startsWith("-d") ||
                arg.startsWith("-f") ||
                arg.startsWith("-F") ||
                arg.startsWith("-Z"));
        if (isControlledLongOption || isControlledShortOption) {
            throw new Error(
                `BACKUP_OPTIONS cannot override the database, output file, archive format, or compression: ${arg}`,
            );
        }
    }

    return args;
};

const removeIfPresent = (filePath: string) => rm(filePath, { force: true });

const dumpAttempt = async (filePath: string) => {
    await removeIfPresent(filePath);
    const connection = connectionConfig();

    console.log("Checking database readiness...");
    await runCommand("pg_isready", ["--timeout=10", `--dbname=${connection.databaseUrl}`], {
        env: connection.env,
        captureStdout: true,
    });

    console.log("Dumping DB to file...");
    await runCommand(
        "pg_dump",
        [
            ...parseBackupOptions(env.BACKUP_OPTIONS),
            `--dbname=${connection.databaseUrl}`,
            "--format=custom",
            `--compress=${env.BACKUP_COMPRESSION}`,
            `--file=${filePath}`,
        ],
        { env: connection.env },
    );

    console.log("Validating backup archive...");
    await runCommand("pg_restore", ["--list", filePath]);

    if (statSync(filePath).size === 0) {
        throw new Error("Backup archive is empty.");
    }

    console.log("Backup archive is valid");
    console.log("Backup filesize:", filesize(statSync(filePath).size));
};

const dumpToFile = async (filePath: string) => {
    const maxAttempts = 3;
    const baseDelayMilliseconds = 5_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await dumpAttempt(filePath);
            console.log("DB dumped to file...");
            return;
        } catch (error) {
            await removeIfPresent(filePath);
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Backup attempt ${attempt}/${maxAttempts} failed: ${message}`);

            if (attempt === maxAttempts) throw error;

            const delay = baseDelayMilliseconds * 2 ** (attempt - 1);
            console.log(`Retrying backup in ${delay / 1000} seconds...`);
            await sleep(delay);
        }
    }
};

export const backup = async (): Promise<{ filename: string; size: number }> => {
    console.log("Initiating DB backup...");

    const date = new Date().toISOString();
    const timestamp = date.replace(/[:.]+/g, "-");
    const filename = `${env.BACKUP_FILE_PREFIX}-${timestamp}.dump`;
    const filepath = path.join(os.tmpdir(), filename);

    try {
        await dumpToFile(filepath);
        const size = statSync(filepath).size;
        await uploadToS3({ name: filename, path: filepath });

        console.log("DB backup complete...");
        return { filename, size };
    } finally {
        console.log("Deleting temporary files...");
        await removeIfPresent(filepath);
    }
};
