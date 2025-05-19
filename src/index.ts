import * as Sentry from "@sentry/bun";
import { SlackApp } from "slack-edge";
import setup from "./features";
import { db } from "./libs/db";
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

// Check required environment variables
const requiredVars = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CHANNEL",
  "SENTRY_DSN",
  "DATABASE_URL",
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
  sendClientReports: environment === "production",
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
    SLACK_LOGGING_LEVEL: environment === "production" ? "WARN" : "DEBUG",
  },
  startLazyListenerAfterAck: true,
});
const slackClient = slackApp.client;

await setup();

export default {
  port: process.env.PORT || 3000,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    switch (path) {
      case "/":
        return new Response(`Hello World from ${name}@${version}@${commit}`);
      case "/health":
        return new Response("OK");
      case "/slack":
        return slackApp.run(request);
      default:
        return new Response("404 Not Found", { status: 404 });
    }
  },
};

console.log(
  `🚀 Server Started in ${
    Bun.nanoseconds() / 1000000
  } milliseconds on version: ${version}@${commit}!\n\n----------------------------------\n`,
);

export { slackApp, slackClient, version, name, environment, db };
