import * as Sentry from "@sentry/bun";
import { db } from "./db";
import { queryCache } from "./cache";

/**
 * Proactively warms the cache by loading commonly accessed data using registered query functions
 * Call this after cron jobs update the database or at server startup
 */
export async function preloadCaches(): Promise<void> {
  console.log("Preloading all caches for optimal performance...");

  try {
    // Get all registered cache keys
    const registeredKeys = queryCache.getRegisteredKeys();

    if (registeredKeys.length === 0) {
      console.warn("No registered cache keys found. Cache warming skipped.");
      return;
    }

    console.log(`Found ${registeredKeys.length} registered cache keys to warm`);

    // Prioritize the most critical endpoints first
    const priorityKeys = [
      "leaderboard_stories",
      "total_stories_count",
      "verified_users_stats",
    ];

    // Sort keys by priority (known critical keys first, then others)
    const sortedKeys = [
      ...priorityKeys.filter((key) => registeredKeys.includes(key)),
      ...registeredKeys.filter((key) => !priorityKeys.includes(key)),
    ];

    // Warm each cache using its registered query function
    for (const key of sortedKeys) {
      console.log(`Warming cache for ${key}...`);
      await queryCache.warmCache(key);
    }

    // Preload snapshots for top stories - this requires custom handling
    // since these use dynamic keys (story_snapshots_{id})
    console.log("Preloading top story snapshots (limited to 3)...");

    // Get IDs of top 3 stories to warm their snapshots
    const topStories = await db.query.stories.findMany({
      columns: { id: true }, // Only retrieve the ID field to minimize memory use
      where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
      orderBy: (stories, { asc }) => [asc(stories.position)],
      limit: 3,
    });

    // Check if any dynamic story snapshot keys are registered
    for (const story of topStories) {
      const snapshotKey = `story_snapshots_${story.id}`;
      await queryCache.warmCache(snapshotKey);
    }

    console.log("Cache preloading completed successfully");
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
  console.log("Invalidating all query caches and refreshing data");
  queryCache.invalidateAll();

  // Immediately refill the cache using registered query functions
  setTimeout(() => {
    preloadCaches().catch((err) => {
      console.error("Error during cache preloading after invalidation:", err);
      Sentry.captureException(err);
    });
  }, 100); // Small delay to let any pending requests complete
}
