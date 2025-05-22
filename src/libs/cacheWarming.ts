import * as Sentry from "@sentry/bun";
import { db } from "./db";
import { queryCache } from "./cache";

// Check if we're in production mode to reduce logging
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Proactively warms the cache by loading commonly accessed data using registered query functions
 * Call this after cron jobs update the database or at server startup
 */
export async function preloadCaches(): Promise<void> {
  if (!isProduction) {
    console.log("Preloading all caches for optimal performance...");
  }

  try {
    // Get all registered cache keys
    const registeredKeys = queryCache.getRegisteredKeys();
    
    if (registeredKeys.length === 0) {
      if (!isProduction) {
        console.warn("No registered cache keys found. Cache warming skipped.");
      }
      return;
    }
    
    if (!isProduction) {
      console.log(`Found ${registeredKeys.length} registered cache keys to warm`);
    }
    
    // Prioritize the most critical endpoints first
    const priorityKeys = [
      "leaderboard_stories",
      "total_stories_count",
      "verified_users_stats"
    ];
    
    // Sort keys by priority (known critical keys first, then others)
    const sortedKeys = [
      ...priorityKeys.filter(key => registeredKeys.includes(key)),
      ...registeredKeys.filter(key => !priorityKeys.includes(key))
    ];
    
    // Prepare warming promises to run in parallel for better performance
    const warmingPromises = sortedKeys.map(async (key) => {
      if (!isProduction) {
        console.log(`Warming cache for ${key}...`);
      }
      return queryCache.warmCache(key);
    });
    
    // Run warming of standard endpoints in parallel
    await Promise.all(warmingPromises);
    
    // Preload snapshots for top stories - this requires custom handling
    // since these use dynamic keys (story_snapshots_{id})
    if (!isProduction) {
      console.log("Preloading top story snapshots (limited to 3)...");
    }
    
    // Get IDs of top 3 stories to warm their snapshots
    const topStories = await db.query.stories.findMany({
      columns: { id: true }, // Only retrieve the ID field to minimize memory use
      where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
      orderBy: (stories, { asc }) => [asc(stories.position)],
      limit: 3,
    });
    
    // Warm story snapshots in parallel
    const snapshotPromises = topStories.map(story => {
      const snapshotKey = `story_snapshots_${story.id}`;
      return queryCache.warmCache(snapshotKey);
    });
    
    await Promise.all(snapshotPromises);

    if (!isProduction) {
      console.log("Cache preloading completed successfully");
    }
  } catch (error) {
    console.error("Error during cache preloading:", error);
    Sentry.captureException(error);
  }
}

/**
 * Invalidates all caches and then immediately reloads them
 * Call this after data updates (like the HN check cron job)
 */
export function invalidateAndRefreshCaches(): void {
  if (!isProduction) {
    console.log("Invalidating all query caches and refreshing data");
  }
  queryCache.invalidateAll();

  // Immediately refill the cache using registered query functions
  setTimeout(() => {
    preloadCaches().catch((err) => {
      console.error("Error during cache preloading after invalidation:", err);
      Sentry.captureException(err);
    });
  }, isProduction ? 50 : 100); // Smaller delay in production for faster refresh
}
