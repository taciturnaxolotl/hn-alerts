import * as Sentry from "@sentry/bun";
import { SlackApp } from "slack-edge";
import setup from "./features";
import { db } from "./libs/db";
import { version, name } from "../package.json";
import root from "../public/index.html";
import { count } from "drizzle-orm";
import { stories } from "./libs/schema";

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

const server = Bun.serve({
  port: process.env.PORT || 3000,
  reusePort: true,
  routes: {
    "/": root,
    "/api/stories": async () => {
      try {
        // Get stories that reached the front page (leaderboard)
        const storyAlerts = await db.query.stories.findMany({
          where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
          orderBy: (stories, { asc }) => [asc(stories.position)],
          limit: 100,
        });

        // Transform story data to match the format expected by the frontend
        const alerts = storyAlerts.map((story) => ({
          id: story.id,
          title: story.title,
          url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
          rank: story.position,
          peakRank: story.peakPosition,
          points: story.score,
          peakPoints: story.peakScore,
          comments: story.descendants,
          timestamp: story.enteredLeaderboardAt
            ? new Date(story.enteredLeaderboardAt * 1000).toISOString()
            : new Date(story.firstSeenAt * 1000).toISOString(),
          by: story.by,
          isFromMonitoredUser: story.isFromMonitoredUser,
        }));

        return new Response(JSON.stringify(alerts), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Failed to fetch alerts:", error);
        return new Response(
          JSON.stringify({ error: "Failed to fetch alerts" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
    "/api/stats/total-stories": async () => {
      try {
        // Count all stories in the database
        const result = await db.select({ count: count() }).from(stories);
        const totalCount = Number(result[0]?.count);

        return new Response(
          JSON.stringify({
            count: totalCount,
            timestamp: Math.floor(Date.now() / 1000),
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        console.error("Failed to count stories:", error);
        return new Response(
          JSON.stringify({ error: "Failed to count stories" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
    "/api/stats/verified-users": async () => {
      try {
        // Get stats for verified user stories
        const verifiedStories = await db.query.stories.findMany({
          where: (stories, { eq }) => eq(stories.isFromMonitoredUser, true),
        });

        // Count stories on front page (rank <= 30)
        const frontPageCount = verifiedStories.filter(
          (s) => s.isOnLeaderboard,
        ).length;

        // Calculate average peak points for verified users
        let totalPeakPoints = 0;
        for (const s of verifiedStories) {
          if (s.peakScore) totalPeakPoints += s.peakScore;
        }
        const avgPeakPoints = verifiedStories.length
          ? Math.round(totalPeakPoints / verifiedStories.length)
          : 0;

        return new Response(
          JSON.stringify({
            totalCount: verifiedStories.length,
            frontPageCount: frontPageCount,
            avgPeakPoints: avgPeakPoints,
            timestamp: Math.floor(Date.now() / 1000),
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        console.error("Failed to get verified user stats:", error);
        return new Response(
          JSON.stringify({ error: "Failed to get verified user stats" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
    "/api/story/:id/snapshots": async (req) => {
      try {
        const storyId = Number.parseInt(req.params.id as string);
        if (Number.isNaN(storyId)) {
          return new Response(JSON.stringify({ error: "Invalid story ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Get snapshots for the story
        const snapshots = await db.query.leaderboardSnapshots.findMany({
          where: (snapshots, { eq }) => eq(snapshots.storyId, storyId),
          orderBy: (snapshots, { asc }) => [asc(snapshots.timestamp)],
        });

        // Transform snapshot data for frontend
        const graphData = snapshots.map((snapshot) => ({
          timestamp: snapshot.timestamp,
          position: snapshot.position,
          score: snapshot.score,
          date: new Date(snapshot.timestamp * 1000).toISOString(),
        }));

        return new Response(JSON.stringify(graphData), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Failed to fetch snapshots for story:", error);
        return new Response(
          JSON.stringify({ error: "Failed to fetch snapshots" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
    "/health": () => {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
    "/slack": (res: Request) => {
      return slackApp.run(res);
    },
  },
});

console.log(
  `🚀 Server Started in ${
    Bun.nanoseconds() / 1000000
  } milliseconds on version: ${version}@${commit}!\n\n----------------------------------\n`,
);

export { slackApp, slackClient, version, name, environment, db };
