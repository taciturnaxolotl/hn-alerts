import * as Sentry from "@sentry/bun";
import { SlackApp } from "slack-edge";
import setup from "./features";
import { db } from "./libs/db";
import { version, name } from "../package.json";
import { preloadCaches, invalidateAndRefreshCaches } from "./libs/cacheWarming";
import { QueryCache, queryCache, createCacheHeaders, compressResponse, createCachedEndpoint } from "./libs/cache";
import root from "../public/index.html";
import { count, sql } from "drizzle-orm";
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

// Initialize Slack app
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
await preloadCaches();

const server = Bun.serve({
  port: process.env.PORT || 3000,
  reusePort: true,
  routes: {
    "/": root,
    "/api/stories": createCachedEndpoint("leaderboard_stories", async () => {
      // Only select the specific columns we need for better performance
      const storyAlerts = await db.query.stories.findMany({
        columns: {
          id: true,
          title: true,
          url: true,
          position: true,
          peakPosition: true,
          score: true,
          peakScore: true, 
          descendants: true,
          enteredLeaderboardAt: true,
          firstSeenAt: true,
          by: true,
          isFromMonitoredUser: true,
        },
        where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
        orderBy: (stories, { asc }) => [asc(stories.position)],
        limit: 30, // Reduced from 100 to 30 for better performance
      });

      // Pre-calculate the time multiplier to optimize date transformations
      const timeMultiplier = 1000;
      
      // Transform story data to match the format expected by the frontend
      return storyAlerts.map((story) => {
        // Calculate timestamp only once per story
        const timestamp = story.enteredLeaderboardAt
          ? new Date(story.enteredLeaderboardAt * timeMultiplier).toISOString()
          : new Date(story.firstSeenAt * timeMultiplier).toISOString();
          
        return {
          id: story.id,
          title: story.title,
          url:
            story.url || `https://news.ycombinator.com/item?id=${story.id}`,
          rank: story.position,
          peakRank: story.peakPosition,
          points: story.score,
          peakPoints: story.peakScore,
          comments: story.descendants,
          timestamp,
          by: story.by,
          isFromMonitoredUser: story.isFromMonitoredUser,
        };
      });
    }, 300),
    "/api/stats/total-stories": createCachedEndpoint("total_stories_count", async () => {
      const result = await db.select({ count: count() }).from(stories);
      return {
        count: Number(result[0]?.count),
        timestamp: Math.floor(Date.now() / 1000),
      };
    }, 300),
    "/api/stats/verified-users": createCachedEndpoint("verified_users_stats", async () => {
      // Get stats for verified user stories
      const verifiedStories = await db.query.stories.findMany({
        where: (stories, { eq }) => eq(stories.isFromMonitoredUser, true),
      });
      // Get count of verified users in the system
      const verifiedUsersCount = await db.query.users
        .findMany({
          where: (users, { eq }) => eq(users.verified, true),
        })
        .then((users) => users.length);

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

      return {
        totalCount: verifiedUsersCount,
        frontPageCount: frontPageCount,
        avgPeakPoints: avgPeakPoints,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }, 300),
    "/api/story/:id/snapshots": async (req) => {
      try {
        const storyId = Number.parseInt(req.params.id as string);
        if (Number.isNaN(storyId)) {
          return new Response(JSON.stringify({ error: "Invalid story ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Create a cached endpoint handler dynamically based on the story ID
        const handler = createCachedEndpoint(
          `story_snapshots_${storyId}`,
          async () => {
            // Get snapshots for the story
            const snapshots = await db.query.leaderboardSnapshots.findMany({
              where: (snapshots, { eq }) => eq(snapshots.storyId, storyId),
              orderBy: (snapshots, { asc }) => [asc(snapshots.timestamp)],
            });

            // Transform snapshot data for frontend
            return snapshots.map((snapshot) => ({
              timestamp: snapshot.timestamp,
              position: snapshot.position,
              score: snapshot.score,
              date: new Date(snapshot.timestamp * 1000).toISOString(),
            }));
          },
          3600 // Cache story snapshots for 1 hour as they change less frequently
        );

        // Execute the cached handler
        return handler(req);
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
    "/health": (req) => {
      const response = new Response(JSON.stringify({ status: "ok" }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control":
            "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      });
      return compressResponse(req, response);
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

// Function to invalidate all caches and refresh them - call this when data is updated
function invalidateAllCaches() {
  console.log("Invalidating all query caches and refreshing data");
  invalidateAndRefreshCaches();
}

export {
  slackApp,
  slackClient,
  version,
  name,
  environment,
  db,
  queryCache,
  invalidateAllCaches,
};
