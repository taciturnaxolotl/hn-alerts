import { slackClient } from "../index";
import Bottleneck from "bottleneck";
import Queue from "./queue";
import colors from "colors";
import * as Sentry from "@sentry/bun";
import type {
	ChatPostMessageRequest,
	ChatPostMessageResponse,
} from "slack-edge";

// Create a rate limiter with Bottleneck
const limiter = new Bottleneck({
	minTime: 1000, // 1 second between each request
});

const messageQueue = new Queue();

async function sendMessage(
	message: ChatPostMessageRequest,
): Promise<ChatPostMessageResponse> {
	try {
		return await limiter.schedule(() => slackClient.chat.postMessage(message));
	} catch (error) {
		Sentry.captureException(error, {
			extra: { channel: message.channel, text: message.text },
			tags: { type: "slack_message_error" },
		});
		console.error("Failed to send Slack message:", error);
		throw error;
	}
}

async function slog(
	logMessage: string,
	location?: {
		thread_ts?: string;
		channel: string;
	},
): Promise<void> {
	try {
		const channel = location?.channel || process.env.SLACK_LOG_CHANNEL;

		if (!channel) {
			throw new Error("No Slack channel specified for logging");
		}

		const message: ChatPostMessageRequest = {
			channel,
			thread_ts: location?.thread_ts,
			text: logMessage.substring(0, 2500),
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: logMessage
							.split("\n")
							.map((a) => `> ${a}`)
							.join("\n"),
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `${new Date().toString()}`,
						},
					],
				},
			],
		};

		messageQueue.enqueue(() => sendMessage(message));
	} catch (error) {
		Sentry.captureException(error, {
			extra: { logMessage, location, channel: location?.channel },
			tags: { type: "slog_error" },
		});
		console.error("Failed to queue Slack log message:", error);
	}
}

type LogType = "info" | "start" | "cron" | "error";

type LogMetadata = {
	error?: Error;
	context?: string;
	additional?: Record<string, unknown>;
};

export async function clog(
	logMessage: string,
	type: LogType,
	metadata?: LogMetadata,
): Promise<void> {
	const timestamp = new Date().toISOString();
	const formattedMessage = `[${timestamp}] ${logMessage}`;

	switch (type) {
		case "info":
			console.log(colors.blue(formattedMessage));
			break;
		case "start":
			console.log(colors.green(formattedMessage));
			break;
		case "cron":
			console.log(colors.magenta(`[CRON]: ${formattedMessage}`));
			break;
		case "error": {
			const errorMessage = colors.red.bold(
				`Yo <@S0790GPRA48> deres an error \n\n [ERROR]: ${formattedMessage}`,
			);
			console.error(errorMessage);
			break;
		}
		default:
			console.log(formattedMessage);
	}
}

export async function blog(
	logMessage: string,
	type: LogType,
	location?: {
		thread_ts?: string;
		channel: string;
	},
	metadata?: LogMetadata,
): Promise<void> {
	try {
		await Promise.all([
			slog(logMessage, location),
			clog(logMessage, type, metadata),
		]);
	} catch (error) {
		console.error("Failed to log message:", error);
		Sentry.captureException(error, {
			extra: { logMessage, type, location, metadata },
			tags: { type: "blog_error" },
		});
	}
}

export { clog as default, slog };
