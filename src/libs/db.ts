import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { eq, and, notInArray, count } from "drizzle-orm";
import * as Sentry from "@sentry/bun";

// Define interface for snapshot data
interface Snapshot {
  id: number;
  timestamp: number;
  position: number;
  score: number;
}

interface StoryCount {
  story_id: number;
  snapshot_count: number;
}

// Use environment variable for the database path in production
const dbPath = process.env.DATABASE_PATH || "./local.db";

// Create a SQLite database instance using Bun's built-in driver with improved concurrency settings
const sqlite = new Database(dbPath, {
  // Use WAL mode for better concurrency
  readonly: false,
  create: true,
});

// Set a longer busy timeout to reduce "database is locked" errors
sqlite.exec("PRAGMA busy_timeout = 10000;");

// Enable Write-Ahead Logging mode for better concurrent performance
sqlite.exec("PRAGMA journal_mode = WAL;");
// Set synchronous mode for better performance (still safe in WAL mode)
sqlite.exec("PRAGMA synchronous = NORMAL;");
// Increase cache size for better performance (32MB instead of 16MB)
sqlite.exec("PRAGMA cache_size = -32000;");
// Enable memory-mapped I/O for better read performance
sqlite.exec("PRAGMA mmap_size = 268435456;"); // 256MB
// Optimize query planner
sqlite.exec("PRAGMA optimize;");
// Increase page size for better I/O efficiency
sqlite.exec("PRAGMA page_size = 8192;");

// Create a Drizzle instance with the database and schema
export const db = drizzle(sqlite, { schema });

/**
 * Optimizes leaderboard snapshots by removing redundant entries
 * Keeps important snapshots: first, last, and any showing position/score changes
 * Uses raw SQL for better performance on large datasets
 * Preserves data points showing significant changes
 * @param {number} batchSize - Number of stories to process in each batch (default: 50)
 * @param {boolean} conservative - If true, uses more conservative rules to keep snapshots (default: true)
 */
async function optimizeLeaderboardSnapshots(batchSize = 50, conservative = true) {
  try {
    console.log("Starting leaderboard snapshots optimization...");
    const startTime = Date.now();

    // Get count of stories with snapshots
    // Get count of eligible stories (more than 3 snapshots)
    const storyCountResult = sqlite.query(
      "SELECT COUNT(*) as count FROM (SELECT story_id FROM leaderboard_snapshots GROUP BY story_id HAVING COUNT(*) > 3)",
    );
    const storyCount = storyCountResult.get()
      ? (storyCountResult.get() as { count: number }).count
      : 0;

    if (storyCount === 0) {
      console.log("No stories with snapshots to optimize");
      return;
    }

    console.log(
      `Found ${storyCount} stories with leaderboard snapshots to analyze`,
    );
    let totalRedundantSnapshots = 0;
    let processedStories = 0;

    // Direct SQL approach for performance
    // Create temporary table for IDs to keep
    sqlite.exec(`
      DROP TABLE IF EXISTS temp_snapshots_to_keep;
      CREATE TEMPORARY TABLE temp_snapshots_to_keep (
        id INTEGER NOT NULL
      );
    `);

    // Get stories with more than 3 snapshots (optimization candidates)
    const candidateStories = sqlite
      .query(
        `SELECT story_id, COUNT(*) as snapshot_count
       FROM leaderboard_snapshots
       GROUP BY story_id
       HAVING COUNT(*) > 3
       ORDER BY snapshot_count DESC
       LIMIT ${batchSize}`,
      )
      .all() as StoryCount[];

    // Process each story in batches for memory efficiency
    for (const story of candidateStories) {
      const storyId = story.story_id;
      if (!storyId) continue;

      try {
        // Clear the temporary table
        sqlite.exec("DELETE FROM temp_snapshots_to_keep");

        // Get all snapshots for this story with direct SQL for better performance
        const snapshots = sqlite
          .prepare(
            `SELECT id, timestamp, position, score
           FROM leaderboard_snapshots
           WHERE story_id = ?
           ORDER BY timestamp`,
          )
          .all(storyId) as Snapshot[];

        if (!snapshots || snapshots.length <= 3) {
          console.log(`Skipping story ${storyId}: Only ${snapshots?.length || 0} snapshots (minimum 4 required)`);
          continue;
        }

        // Always keep first and last snapshots
        const firstId = snapshots[0]?.id;
        const lastId = snapshots[snapshots.length - 1]?.id;

        if (firstId) {
          sqlite.exec(`INSERT INTO temp_snapshots_to_keep VALUES (${firstId})`);
        }

        if (lastId && lastId !== firstId) {
          sqlite.exec(`INSERT INTO temp_snapshots_to_keep VALUES (${lastId})`);
        }

        let lastPosition = snapshots[0]?.position;
        let lastScore = snapshots[0]?.score;
        let lastKeptIndex = 0;

        // Track potential sharp changes
        let significantChanges = 0;
        let maxPositionJump = 0;
        let maxScoreJump = 0;
        
        // First pass - analyze change patterns to detect sharp/significant changes
        if (conservative) {
          for (let i = 1; i < snapshots.length; i++) {
            if (snapshots[i] && snapshots[i-1]) {
              const positionDiff = Math.abs((snapshots[i]?.position ?? 0) - (snapshots[i-1]?.position ?? 0));
              const scoreDiff = Math.abs((snapshots[i]?.score ?? 0) - (snapshots[i-1]?.score ?? 0));
              
              maxPositionJump = Math.max(maxPositionJump, positionDiff);
              maxScoreJump = Math.max(maxScoreJump, scoreDiff);
              
              // Count significant changes (position jumps of 3+ or score changes of 10%+)
              if (positionDiff >= 3 || scoreDiff >= Math.max(5, (snapshots[i-1]?.score ?? 0) * 0.1)) {
                significantChanges++;
              }
            }
          }
        }
        
        // Determine how aggressive to be based on the story's volatility
        const hasSharpChanges = significantChanges >= 2 || maxPositionJump >= 5 || maxScoreJump >= 20;
        const keepEveryNthPoint = hasSharpChanges ? 2 : 4; // Keep more points if story has sharp changes

        // Find snapshots to keep in one pass (changes and last before changes)
        for (let i = 1; i < snapshots.length - 1; i++) {
          const snapshot = snapshots[i];
          if (
            !snapshot ||
            typeof snapshot.position !== "number" ||
            typeof snapshot.score !== "number"
          )
            continue;
            
          // With conservative mode, we'll keep more snapshots
          if (conservative) {
            // Keep snapshots at regular intervals to preserve shape of the graph
            if (i % keepEveryNthPoint === 0) {
              if (snapshot.id) {
                sqlite.exec(
                  `INSERT INTO temp_snapshots_to_keep VALUES (${snapshot.id})`,
                );
              }
              continue;
            }
          }

          const positionChanged = snapshot.position !== lastPosition;
          const scoreChanged = snapshot.score !== lastScore;
          
          // For stories with sharp changes, be more sensitive to any change
          const significantPositionChange = Math.abs((snapshot.position ?? 0) - (lastPosition ?? 0)) >= 2;
          const significantScoreChange = Math.abs((snapshot.score ?? 0) - (lastScore ?? 0)) >= 3;
          
          if (positionChanged || scoreChanged || 
              (conservative && (significantPositionChange || significantScoreChange))) {
            // Keep last snapshot before change
            if (i - 1 > lastKeptIndex) {
              const prevId = snapshots[i - 1]?.id;
              if (prevId) {
                sqlite.exec(
                  `INSERT INTO temp_snapshots_to_keep VALUES (${prevId})`,
                );
              }
            }

            // Keep snapshot with change
            if (snapshot.id) {
              sqlite.exec(
                `INSERT INTO temp_snapshots_to_keep VALUES (${snapshot.id})`,
              );
            }

            lastPosition = snapshot.position;
            lastScore = snapshot.score;
            lastKeptIndex = i;
          }
        }

        // Delete redundant snapshots efficiently using NOT EXISTS
        const statement = sqlite.prepare(
          `DELETE FROM leaderboard_snapshots
           WHERE story_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM temp_snapshots_to_keep
             WHERE temp_snapshots_to_keep.id = leaderboard_snapshots.id
           )`,
        );

        // Run once and get changes
        const deletedCount = statement.run(storyId).changes;
        statement.finalize();

        // Count already calculated above
        totalRedundantSnapshots += deletedCount;
        processedStories++;

        // Log more details to help debug issues
        const keptCount = snapshots.length - deletedCount;
        const keepPercent = Math.round((keptCount / snapshots.length) * 100);
          
        console.log(
          `Story ${storyId}: ${keptCount}/${snapshots.length} snapshots kept (${keepPercent}%)${hasSharpChanges ? ' - SHARP CHANGES DETECTED' : ''} - Max jumps: pos=${maxPositionJump}, score=${maxScoreJump}`
        );

        if (processedStories % 10 === 0) {
          console.log(
            `Processed ${processedStories}/${storyCount} stories, removed ${totalRedundantSnapshots} redundant snapshots so far`,
          );
        }
      } catch (error) {
        console.error(
          `Error optimizing snapshots for story ${storyId}:`,
          error,
        );
        Sentry.captureException(error);
      }
    }

    // Clean up temporary table
    sqlite.exec("DROP TABLE IF EXISTS temp_snapshots_to_keep");

    const duration = (Date.now() - startTime) / 1000;
    console.log(
      `Leaderboard optimization complete: processed ${processedStories}/${storyCount} stories, removed ${totalRedundantSnapshots} redundant snapshots in ${duration.toFixed(2)}s`,
    );

    // If there are more stories to process, return how many are left
    return storyCount - processedStories;
  } catch (error) {
    console.error("Error during leaderboard snapshots optimization:", error);
    Sentry.captureException(error);
    return 0;
  }
}

// Export the sqlite instance and schema for use in other files
export { sqlite, schema, optimizeLeaderboardSnapshots };
