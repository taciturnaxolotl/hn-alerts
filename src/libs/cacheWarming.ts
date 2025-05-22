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
  const startTime = performance.now();
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
    
    // Define critical, high and regular priority endpoints
    const criticalKeys = [
      "leaderboard_stories" // Most important endpoint - load first
    ];
    
    const highPriorityKeys = [
      "total_stories_count",
      "verified_users_stats"
    ];
    
    // Sort keys into priority tiers
    const sortedCriticalKeys = criticalKeys.filter(key => registeredKeys.includes(key));
    const sortedHighPriorityKeys = highPriorityKeys.filter(key => registeredKeys.includes(key));
    const regularPriorityKeys = registeredKeys.filter(key => 
      !criticalKeys.includes(key) && !highPriorityKeys.includes(key)
    );
    
    // Step 1: Load critical endpoints sequentially for most predictable performance
    for (const key of sortedCriticalKeys) {
      if (!isProduction) {
        console.log(`Warming CRITICAL cache for ${key}...`);
      }
      await queryCache.warmCache(key);
      
      // Register as priority in cache system to prevent eviction
      const registration = queryCache.getQueryRegistration(key);
      if (registration) {
        queryCache.register(key, registration.fn, registration.ttl, true);
      }
    }
    
    // Step 2: Load high priority keys in parallel
    await Promise.all(sortedHighPriorityKeys.map(async (key) => {
      if (!isProduction) {
        console.log(`Warming HIGH PRIORITY cache for ${key}...`);
      }
      await queryCache.warmCache(key);
      
      // Register these as priority too
      const registration = queryCache.getQueryRegistration(key);
      if (registration) {
        queryCache.register(key, registration.fn, registration.ttl, true);
      }
    }));
    
    // Step 3: For regular priority, use staggered loading with limited concurrency
    const concurrencyLimit = isProduction ? 3 : 5;
    const chunkSize = Math.min(concurrencyLimit, regularPriorityKeys.length);
    
    // Process in smaller chunks to prevent overwhelming the database
    for (let i = 0; i < regularPriorityKeys.length; i += chunkSize) {
      const chunk = regularPriorityKeys.slice(i, i + chunkSize);
      const chunkPromises = chunk.map(async (key) => {
        if (!isProduction) {
          console.log(`Warming regular cache for ${key}...`);
        }
        return queryCache.warmCache(key);
      });
      
      await Promise.all(chunkPromises);
      
      // Small breather between chunks to avoid CPU spikes
      if (i + chunkSize < regularPriorityKeys.length) {
        await new Promise(resolve => setTimeout(resolve, isProduction ? 50 : 20));
      }
    }
    
    // Preload snapshots for top stories - this requires custom handling
    // since these use dynamic keys (story_snapshots_{id})
    if (!isProduction) {
      console.log("Preloading top story snapshots...");
    }
    
    // Get IDs of top 5 stories in production (more likely to be viewed), or top 3 in dev
    const topStoriesLimit = isProduction ? 5 : 3;
    
    // Use optimized query with only necessary columns
    const topStories = await db.query.stories.findMany({
      columns: { id: true }, // Only retrieve the ID field to minimize memory use
      where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
      orderBy: (stories, { asc }) => [asc(stories.position)],
      limit: topStoriesLimit,
    });
    
    // Warm story snapshots with limited concurrency to prevent DB overload
    for (const story of topStories) {
      const snapshotKey = `story_snapshots_${story.id}`;
      await queryCache.warmCache(snapshotKey);
      
      // Short delay between each story to minimize server load spikes
      if (story !== topStories[topStories.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, isProduction ? 100 : 50));
      }
    }

    const totalTime = Math.round(performance.now() - startTime);
    if (!isProduction) {
      console.log(`Cache preloading completed successfully in ${totalTime}ms`);
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
  
  // Don't invalidate everything - be selective to maintain performance
  // First get a list of keys to invalidate (non-priority ones)
  const allKeys = queryCache.getRegisteredKeys();
  const nonPriorityKeys = queryCache.getNonPriorityKeys();
  
  // Only invalidate non-priority keys first
  for (const key of nonPriorityKeys) {
    queryCache.invalidate(key);
  }
  
  // Gradually refresh caches with staggered starts
  setTimeout(() => {
    preloadCaches().catch((err) => {
      console.error("Error during cache preloading after invalidation:", err);
      Sentry.captureException(err);
    });
  }, isProduction ? 100 : 200); // Slightly longer delay to ensure system stability
}
