import * as Sentry from "@sentry/bun";
import { SlackApp } from "slack-edge";
import setup from "./features";
import { db } from "./libs/db";
import { version, name } from "../package.json";
import { preloadCaches, invalidateAndRefreshCaches } from "./libs/cacheWarming";
import {
  queryCache,
  compressResponse,
  createCachedEndpoint,
  createCacheHeaders,
} from "./libs/cache";
import { handleCORS } from "./libs/cors";
import root from "../public/index.html";
import { count } from "drizzle-orm";
import { stories } from "./libs/schema";

// Check if we're in production mode to reduce logging
const isProduction = process.env.NODE_ENV === "production";

const environment = process.env.NODE_ENV;
// Only compute git commit in development, use a constant in production to avoid process spawn
const commit = isProduction
  ? "production"
  : (() => {
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
  // Only enable performance monitoring in production
  tracesSampleRate: environment === "production" ? 0.1 : 0,
  // Don't trace background tasks to save resources
  ignoreTransactions: [/warming|preload|invalidate/],
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
    SLACK_LOGGING_LEVEL: environment === "production" ? "ERROR" : "DEBUG", // Use ERROR in production for less overhead
  },
  startLazyListenerAfterAck: true,
});
const slackClient = slackApp.client;

// Set up feature initialization and cache warming
const setupPromise = setup();
const cacheWarmingPromise = preloadCaches();

// Allow these to run in parallel for faster startup
await Promise.all([setupPromise, cacheWarmingPromise]);

const server = Bun.serve({
  port: process.env.PORT || 3000,
  reusePort: true,
  routes: {
    "/": root,
    // Apply CORS to all API routes
    "/api/stories": handleCORS(
      createCachedEndpoint(
        "leaderboard_stories",
        async () => {
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
            limit: 30,
          });

          // Pre-calculate the time multiplier to optimize date transformations
          const timeMultiplier = 1000;
          const result = new Array(storyAlerts.length);

          // Transform story data with optimized loop (no anonymous functions)
          for (let i = 0; i < storyAlerts.length; i++) {
            const story = storyAlerts[i];
            if (!story) continue; // Skip if undefined
            
            const timestamp = story.enteredLeaderboardAt
              ? new Date(
                  story.enteredLeaderboardAt * timeMultiplier,
                ).toISOString()
              : new Date(story.firstSeenAt * timeMultiplier).toISOString();

            result[i] = {
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
          }

          return result;
        },
        300,
      ),
    ),

    "/api/stats/total-stories": handleCORS(
      createCachedEndpoint(
        "total_stories_count",
        async () => {
          // Optimize count query - more direct and efficient
          const result = await db.select({ count: count() }).from(stories);
          // Pre-compute timestamp once
          const now = Math.floor(Date.now() / 1000);

          return {
            count: Number(result[0]?.count || 0),
            timestamp: now,
          };
        },
        300,
      ),
    ),

    "/api/stats/verified-users": handleCORS(
      createCachedEndpoint(
        "verified_users_stats",
        async () => {
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
        },
        300,
      ),
    ),

    "/api/story/:id/snapshots": handleCORS(async (req) => {
      try {
        // Extract the story ID from the URL path
        const url = new URL(req.url);
        const match = url.pathname.match(/\/api\/story\/(\d+)\/snapshots/);
        const storyId = match
          ? Number.parseInt(match[1] as string, 10)
          : Number.NaN;

        if (Number.isNaN(storyId) || storyId <= 0) {
          // Prepared error response for invalid IDs
          return new Response(JSON.stringify({ error: "Invalid story ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Create a cached endpoint handler dynamically based on the story ID
        const cacheKey = `story_snapshots_${storyId}`;
        const queryFn = async () => {
          // Get snapshots for the story
          const snapshots = await db.query.leaderboardSnapshots.findMany({
            where: (snapshots, { eq }) => eq(snapshots.storyId, storyId),
            orderBy: (snapshots, { asc }) => [asc(snapshots.timestamp)],
          });

          // Pre-allocate result array for better memory efficiency
          const result = new Array(snapshots.length);

          // Manual loop is faster than map for large arrays
          for (let i = 0; i < snapshots.length; i++) {
            const snapshot = snapshots[i];
            if (snapshot) {
              result[i] = {
                timestamp: snapshot.timestamp,
                position: snapshot.position,
                score: snapshot.score,
                date: new Date(snapshot.timestamp * 1000).toISOString(),
              };
            }
          }

          return result;
        };

        // Register this dynamic query for potential cache warming
        queryCache.register(cacheKey, queryFn, 3600);

        // Execute the query with caching
        const data = await queryCache.get(cacheKey, queryFn, 3600);

        // Use cached headers for better performance
        const headers = createCacheHeaders(cacheKey, 3600);

        // Create response with optimized headers
        const response = new Response(JSON.stringify(data), { headers });

        return compressResponse(req, response);
      } catch (error) {
        // Don't log in production to reduce overhead
        if (!isProduction) {
          console.error("Failed to fetch snapshots for story:", error);
        }
        Sentry.captureException(error);

        // Use constant error response
        return new Response(
          JSON.stringify({ error: "Failed to fetch snapshots" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }),

    "/health": handleCORS(async (req) => {
      // Pre-stringify the response and cache the headers for /health
      const responseBody = JSON.stringify({ status: "ok" });
      const healthHeaders = {
        "Content-Type": "application/json",
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      };

      const response = new Response(responseBody, { headers: healthHeaders });
      // Skip compression for simple responses to reduce overhead
      return response;
    }),

    "/slack": (res: Request) => {
      // No CORS needed for Slack endpoints
      return slackApp.run(res);
    },
  },
});

if (!isProduction) {
  console.log(
    `🚀 Server Started in ${
      Bun.nanoseconds() / 1000000
    } milliseconds on version: ${version}@${commit}!\n\n----------------------------------\n`,
  );
} else {
  console.log(`Server started, v${version}`);
}

// Function to invalidate all caches and refresh them - call this when data is updated
function invalidateAllCaches() {
  if (!isProduction) {
    console.log("Invalidating all query caches and refreshing data");
  }
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
