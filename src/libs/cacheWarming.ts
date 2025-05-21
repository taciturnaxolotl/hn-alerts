import * as Sentry from "@sentry/bun";
import { db } from "./db";
import { count } from "drizzle-orm";
import { stories, users } from "./schema";
import { queryCache } from "./cache";

/**
 * Proactively warms the cache by loading commonly accessed data
 * Call this after cron jobs update the database or at server startup
 */
export async function preloadCaches(): Promise<void> {
  console.log("Preloading all caches for optimal performance...");
  
  try {
    // Load critical caches sequentially to avoid database contention
    
    // 1. Leaderboard stories (most frequently accessed)
    console.log("Preloading leaderboard stories cache...");
    await queryCache.get('leaderboard_stories', async () => {
      const storyAlerts = await db.query.stories.findMany({
        where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
        orderBy: (stories, { asc }) => [asc(stories.position)],
        limit: 100,
      });
      
      // Transform for frontend
      return storyAlerts.map((story) => ({
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
    });
    
    // 2. Total stories count
    console.log("Preloading story count cache...");
    await queryCache.get('total_stories_count', async () => {
      const result = await db.select({ count: count() }).from(stories);
      return Number(result[0]?.count);
    });
    
    // 3. Verified users stats
    console.log("Preloading verified users stats cache...");
    await queryCache.get('verified_users_stats', async () => {
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
      };
    });

    // 4. Optional: Warm up top 5 story snapshots (preload most accessed story graphs)
    // This is done with lower priority as it's less critical
    console.log("Preloading top story snapshots (limited to 5)...");
    
    // Get IDs of top 5 stories to warm their snapshots
    const topStories = await db.query.stories.findMany({
      where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
      orderBy: (stories, { asc }) => [asc(stories.position)],
      limit: 5, // Reduced from 20 to 5 to minimize initial load
    });

    // Preload snapshots for these stories sequentially
    for (const story of topStories) {
      await queryCache.get(`story_snapshots_${story.id}`, async () => {
        // Get snapshots for the story
        const snapshots = await db.query.leaderboardSnapshots.findMany({
          where: (snapshots, { eq }) => eq(snapshots.storyId, story.id),
          orderBy: (snapshots, { asc }) => [asc(snapshots.timestamp)],
        });

        // Transform snapshot data for frontend
        return snapshots.map((snapshot) => ({
          timestamp: snapshot.timestamp,
          position: snapshot.position,
          score: snapshot.score,
          date: new Date(snapshot.timestamp * 1000).toISOString(),
        }));
      }, 3600); // Cache story snapshots for 1 hour
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
  
  // Immediately refill the cache
  preloadCaches().catch(err => {
    console.error("Error during cache preloading after invalidation:", err);
    Sentry.captureException(err);
  });
}