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
      
      // Transform for frontend
      return storyAlerts.map((story) => {
        // Calculate timestamp only once per story
        const timestamp = story.enteredLeaderboardAt
          ? new Date(story.enteredLeaderboardAt * timeMultiplier).toISOString()
          : new Date(story.firstSeenAt * timeMultiplier).toISOString();
          
        return {
          id: story.id,
          title: story.title,
          url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
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
    });
    
    // 1.1 Leaderboard stories lite version for high load scenarios
    console.log("Preloading leaderboard stories lite cache...");
    await queryCache.get('leaderboard_stories_lite', async () => {
      // Even more optimized for high load - fewer fields, fewer records
      const storyAlerts = await db.query.stories.findMany({
        columns: {
          id: true,
          title: true,
          url: true,
          position: true,
          score: true,
          descendants: true,
          by: true,
          isFromMonitoredUser: true,
        },
        where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
        orderBy: (stories, { asc }) => [asc(stories.position)],
        limit: 20, // Even fewer for extreme load scenarios
      });
      
      const timeMultiplier = 1000;
      
      return storyAlerts.map((story) => ({
        id: story.id,
        title: story.title,
        url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
        rank: story.position,
        points: story.score,
        comments: story.descendants,
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

    // 4. Optional: Warm up top 3 story snapshots (preload most accessed story graphs)
    // This is done with lower priority as it's less critical
    console.log("Preloading top story snapshots (limited to 3)...");
    
    // Get IDs of top 3 stories to warm their snapshots
    const topStories = await db.query.stories.findMany({
      columns: { id: true }, // Only retrieve the ID field to minimize memory use
      where: (stories, { eq }) => eq(stories.isOnLeaderboard, true),
      orderBy: (stories, { asc }) => [asc(stories.position)],
      limit: 3, // Further reduced from 5 to 3 to minimize initial load
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
  setTimeout(() => {
    preloadCaches().catch(err => {
      console.error("Error during cache preloading after invalidation:", err);
      Sentry.captureException(err);
    });
  }, 100); // Small delay to let any pending requests complete
}