import { backup } from "./backup.js";

const startedAt = Date.now();

console.log(
    JSON.stringify({
        message: "Backup run started",
        level: "info",
        event: "backup.started",
        timestamp: new Date().toISOString(),
    }),
);

try {
    const { filename, size } = await backup();
    console.log(
        JSON.stringify({
            message: "Backup run completed",
            level: "info",
            event: "backup.completed",
            filename,
            size,
            durationMs: Date.now() - startedAt,
            timestamp: new Date().toISOString(),
        }),
    );
} catch (error) {
    console.error(
        JSON.stringify({
            message: "Backup run failed",
            level: "error",
            event: "backup.failed",
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
            timestamp: new Date().toISOString(),
        }),
    );
    process.exit(1);
}
