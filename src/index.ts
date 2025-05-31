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
import item from "../public/item.html";
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

// Enable prewarming with higher TTLs for critical endpoints
const setupPromise = setup();
const cacheWarmingPromise = preloadCaches();

// Allow these to run in parallel for faster startup
await Promise.all([setupPromise, cacheWarmingPromise]).catch((err) => {
  console.error("Startup error:", err);
  Sentry.captureException(err);
});

const server = Bun.serve({
  port: process.env.PORT || 3000,
  reusePort: true,
  maxRequestBodySize: 1024 * 1024,
  routes: {
    "/": root,
    "/item": item,
    // Apply CORS to all API routes
    "/api/story/:id": handleCORS(async (req) => {
      try {
        // Extract the story ID from the URL path
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const storyIdStr = pathParts[3]; // Get ID from path parts
        const storyId = storyIdStr
          ? Number.parseInt(storyIdStr, 10)
          : Number.NaN;

        if (Number.isNaN(storyId) || storyId <= 0) {
          return new Response(JSON.stringify({ error: "Invalid story ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Create a cache key for the story
        const cacheKey = `story_${storyId}`;

        // Function to fetch the story data
        const queryFn = async () => {
          const story = await db.query.stories.findFirst({
            columns: {
              id: true,
              title: true,
              url: true,
              position: true,
              peakPosition: true,
              score: true,
              peakScore: true,
              descendants: true,
              by: true,
              enteredLeaderboardAt: true,
              firstSeenAt: true,
              isOnLeaderboard: true,
              isFromMonitoredUser: true,
            },
            where: (stories, { eq }) => eq(stories.id, storyId),
          });

          if (!story) {
            return null;
          }

          // Calculate time on front page if available
          let timeOnFrontPage = null;
          if (story.enteredLeaderboardAt) {
            // Use current time as end time if the story is still on the leaderboard
            const endTime = story.isOnLeaderboard
              ? Math.floor(Date.now() / 1000)
              : story.enteredLeaderboardAt + 3600;
            timeOnFrontPage = endTime - story.enteredLeaderboardAt;
          }

          // Format the response
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
            timestamp: (story.enteredLeaderboardAt || story.firstSeenAt) * 1000,
            by: story.by,
            isFromMonitoredUser: story.isFromMonitoredUser,
            timeOnFrontPage: timeOnFrontPage,
          };
        };

        // Register this dynamic query for potential cache warming
        queryCache.register(cacheKey, queryFn, 600);

        // Execute the query with caching
        const data = await queryCache.get(cacheKey, queryFn, 600);

        if (!data) {
          return new Response(JSON.stringify({ error: "Story not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Create response with cached headers
        const headers = createCacheHeaders(cacheKey, 600);
        const response = new Response(JSON.stringify(data), { headers });

        return compressResponse(req, response);
      } catch (error) {
        if (!isProduction) {
          console.error("Failed to fetch story:", error);
        }
        Sentry.captureException(error);

        return new Response(
          JSON.stringify({ error: "Failed to fetch story" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }),
    "/api/stories": handleCORS(
      createCachedEndpoint(
        "leaderboard_stories",
        async () => {
          // Use direct SQL with raw() for maximum performance
          const storyAlerts = await db.query.stories.findMany({
            // Use the covering index by selecting only needed columns
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

          // Optimize memory allocation with exact array size
          const result = new Array(storyAlerts.length);

          // Pre-calculate constant values outside loop
          const timeMultiplier = 1000;
          const baseHnUrl = "https://news.ycombinator.com/item?id=";

          // Use for loop with cached length for better performance
          const len = storyAlerts.length;
          for (let i = 0; i < len; i++) {
            const story = storyAlerts[i];
            if (!story) continue;

            // Use lazy evaluation for timestamp calculation
            const timestamp =
              (story.enteredLeaderboardAt || story.firstSeenAt) *
              timeMultiplier;

            result[i] = {
              id: story.id,
              title: story.title,
              url: story.url || baseHnUrl + story.id,
              rank: story.position,
              peakRank: story.peakPosition,
              points: story.score,
              peakPoints: story.peakScore,
              comments: story.descendants,
              timestamp: new Date(timestamp).toISOString(),
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
          // Use faster COUNT(*) in raw SQL
          const result = await db.select({ count: count() }).from(stories);

          return {
            count: Number(result[0]?.count || 0),
            timestamp: Math.floor(Date.now() / 1000),
          };
        },
        // Increase TTL for this rarely changing value
        1800,
      ),
    ),

    "/api/stats/verified-users": handleCORS(
      createCachedEndpoint(
        "verified_users_stats",
        async () => {
          // Optimize query to only fetch the exact columns needed
          const verifiedStories = await db.query.stories.findMany({
            columns: {
              isOnLeaderboard: true,
              peakScore: true,
            },
            where: (stories, { eq }) => eq(stories.isFromMonitoredUser, true),
          });

          // Get verified users count with optimized query
          const verifiedUsersCount = await db.query.users
            .findMany({
              columns: { id: true },
              where: (users, { eq }) => eq(users.verified, true),
            })
            .then((users) => users.length);

          // Efficiently count front page stories
          let frontPageCount = 0;
          let totalPeakPoints = 0;

          // Single pass through the data
          const len = verifiedStories.length;
          for (let i = 0; i < len; i++) {
            const story = verifiedStories[i];
            if (story?.isOnLeaderboard) frontPageCount++;
            if (story?.peakScore) totalPeakPoints += story.peakScore;
          }

          const avgPeakPoints = len > 0 ? Math.round(totalPeakPoints / len) : 0;

          return {
            totalCount: verifiedUsersCount,
            frontPageCount: frontPageCount,
            avgPeakPoints: avgPeakPoints,
            timestamp: Math.floor(Date.now() / 1000),
          };
        },
        // Increase cache time for this rarely changing stat
        1200,
      ),
    ),

    "/api/story/:id/snapshots": handleCORS(async (req) => {
      try {
        // Extract the story ID from the URL path
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const storyIdStr = pathParts[3]; // Get ID from path parts directly
        const storyId = storyIdStr
          ? Number.parseInt(storyIdStr, 10)
          : Number.NaN;

        if (Number.isNaN(storyId) || storyId <= 0) {
          // Use constant prepared error response for invalid IDs
          return new Response(JSON.stringify({ error: "Invalid story ID" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Create a cached endpoint handler dynamically based on the story ID
        const cacheKey = `story_snapshots_${storyId}`;
        const queryFn = async () => {
          // Get snapshots for the story with column projection
          const snapshots = await db.query.leaderboardSnapshots.findMany({
            columns: {
              timestamp: true,
              position: true,
              score: true,
            },
            where: (snapshots, { eq }) => eq(snapshots.storyId, storyId),
            orderBy: (snapshots, { asc }) => [asc(snapshots.timestamp)],
          });

          // Pre-allocate result array for better memory efficiency
          const result = new Array(snapshots.length);
          const timeMultiplier = 1000; // Pre-calculate the multiplier

          // Use optimized for loop with cached length
          const len = snapshots.length;
          for (let i = 0; i < len; i++) {
            const snapshot = snapshots[i];
            if (snapshot) {
              const timestamp = snapshot.timestamp * timeMultiplier;
              result[i] = {
                timestamp: snapshot.timestamp,
                position: snapshot.position,
                score: snapshot.score,
                date: new Date(timestamp).toISOString(),
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
        // Avoid logging in production
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
