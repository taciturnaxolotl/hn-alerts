import { SlackApp } from "slack-edge";
import { blog } from "./libs/Logger";
import { version, name } from "../package.json";
const environment = process.env.NODE_ENV;
const commit = (() => {
	try {
		return Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
			.stdout.toString()
			.trim();
	} catch (e) {
		console.error("Failed to get git commit hash:", e);
		return "unknown";
	}
})();

import * as Sentry from "@sentry/bun";
import setup from "./features";

// Check required environment variables
const requiredVars = [
	"SLACK_BOT_TOKEN",
	"SLACK_SIGNING_SECRET",
	"SLACK_CHANNEL",
	"SENTRY_DSN",
] as const;
const missingVars = requiredVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
	throw new Error(
		`Missing required environment variables: ${missingVars.join(", ")}`,
	);
}

Sentry.init({
	dsn: process.env.SENTRY_DSN,
	environment,
	release: version,
});

console.log(
	`----------------------------------\n${name} Server\n----------------------------------\n`,
);
console.log(`🏗️ Starting ${name}...`);
console.log("📦 Loading Slack App...");
console.log("🔑 Loading environment variables...");

const slackApp = new SlackApp({
	env: {
		SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN as string,
		SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET as string,
		SLACK_LOGGING_LEVEL: "INFO",
	},
	startLazyListenerAfterAck: true,
});
const slackClient = slackApp.client;

await setup();

Bun.serve({
	port: process.env.PORT || 3000,
	development: environment === "dev",
	routes: {
		"/": new Response(`hello from ${name}@${version}@${commit}`),
		"/health": new Response("OK"),
	},
	async fetch(request: Request) {
		const url = new URL(request.url);
		const path = `/${url.pathname.split("/")[1]}`;

		switch (path) {
			case "/slack":
				return slackApp.run(request);
			default:
				return new Response("404 Not Found", { status: 404 });
		}
	},
});

console.log(
	`🚀 Server Started in ${
		Bun.nanoseconds() / 1000000
	} milliseconds on version: ${version}@${commit}!\n\n----------------------------------\n`,
);

export { slackApp, slackClient, version, name, environment };
