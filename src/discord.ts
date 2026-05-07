import { filesize } from "filesize";

export type BackupSuccessInfo = {
    filename: string;
    size: number;
};

export const sendDiscordNotification = async (
    message: string,
    options?: {
        isError?: boolean;
        backup?: BackupSuccessInfo;
        webhookUrl?: string;
        errorTitle?: string;
    },
) => {
    const webhookUrl = options?.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        let body: { content?: string; embeds?: object[] };

        if (options?.backup) {
            const { filename, size } = options.backup;
            body = {
                embeds: [
                    {
                        title: "✅ Backup Complete",
                        color: 0x22c55e,
                        fields: [
                            {
                                name: "File",
                                value: `\`${filename}\``,
                                inline: true,
                            },
                            {
                                name: "Size",
                                value: filesize(size),
                                inline: true,
                            },
                            {
                                name: "Timestamp",
                                value: new Date().toISOString(),
                                inline: true,
                            },
                        ],
                    },
                ],
            };
        } else if (options?.isError) {
            body = {
                embeds: [
                    {
                        title: options.errorTitle ?? "❌ Backup Failed",
                        color: 0xef4444,
                        description: message,
                        timestamp: new Date().toISOString(),
                    },
                ],
            };
        } else {
            body = { content: message };
        }

        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (err) {
        console.error("Failed to send Discord notification:", err);
    }
};
