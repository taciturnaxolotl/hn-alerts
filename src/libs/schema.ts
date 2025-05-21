import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Define the users table
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    hackernewsUsername: text("hackernews_username"),
    challenge: text("challenge"),
    verified: integer("verified", { mode: "boolean" }).default(false).notNull(),
  },
  (table) => ({
    // Add index on verified status for faster lookup of verified users
    verifiedIdx: index("idx_users_verified").on(table.verified),
    // Add index on hackernews username for quick lookups
    usernameIdx: index("idx_users_username").on(table.hackernewsUsername),
  }),
);

export const stories = sqliteTable(
  "stories",
  {
    id: integer("id").primaryKey(),
    by: text("by").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    text: text("text"),
    time: integer("time").notNull(),
    score: integer("score"),
    position: integer("position"),
    descendants: integer("descendants"),

    // New tracking fields
    firstSeenAt: integer("first_seen_at").notNull(), // When we first saw it
    lastUpdatedAt: integer("last_updated_at").notNull(), // Last time we updated this record
    notifiedAt: integer("notified_at"), // When first notification was sent

    // Notification tracking flags - avoids duplicate notifications on restart
    notifiedNewStory: integer("notified_new_story", {
      mode: "boolean",
    }).default(false),
    notifiedFrontPage: integer("notified_front_page", {
      mode: "boolean",
    }).default(false),
    notifiedNumberOne: integer("notified_number_one", {
      mode: "boolean",
    }).default(false),

    // Leaderboard tracking
    isOnLeaderboard: integer("is_on_leaderboard", { mode: "boolean" }).default(
      false,
    ),
    enteredLeaderboardAt: integer("entered_leaderboard_at"),
    exitedLeaderboardAt: integer("exited_leaderboard_at"),
    peakPosition: integer("peak_position"),
    peakPositionAt: integer("peak_position_at"),
    peakScore: integer("peak_score"),
    peakScoreAt: integer("peak_score_at"),

    // Tracking if this is from a monitored user
    isFromMonitoredUser: integer("is_from_monitored_user", {
      mode: "boolean",
    }).default(false),

    // Cache management - TTL field for automatic cleanup
    expiresAt: integer("expires_at"), // NULL for monitored user stories (permanent)
  },
  (table) => {
    return {
      // Add index on leaderboard status
      leaderboardIdx: index("idx_stories_leaderboard").on(
        table.isOnLeaderboard,
      ),
      // Add index on monitored user stories
      monitoredUserIdx: index("idx_stories_monitored_user").on(
        table.isFromMonitoredUser,
      ),
      // Add compound index for sorting leaderboard stories by position
      leaderboardPosIdx: index("idx_stories_leaderboard_position").on(
        table.isOnLeaderboard,
        table.position,
      ),
      // Add covering index for the leaderboard API query
      leaderboardCoveringIdx: index("idx_stories_leaderboard_covering").on(
        table.isOnLeaderboard,
        table.position,
        table.title,
        table.url,
        table.score,
        table.peakScore,
        table.peakPosition,
        table.descendants,
        table.by,
        table.isFromMonitoredUser,
      ),
      // Add index on by field for user-specific queries
      byIdx: index("idx_stories_by").on(table.by),
      // Add index on expiration for cleanup queries
      expiresIdx: index("idx_stories_expires").on(table.expiresAt),
      // Add index on time for timeline queries
      timeIdx: index("idx_stories_time").on(table.time),
    };
  },
);

// For tracking leaderboard positions
export const leaderboardSnapshots = sqliteTable(
  "leaderboard_snapshots",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id),
    timestamp: integer("timestamp").notNull(),
    position: integer("position").notNull(),
    score: integer("score").notNull(),

    // TTL for cleanup
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => {
    return {
      // Add index on story ID for faster lookups of a story's snapshots
      storyIdx: index("idx_snapshots_story").on(table.storyId),
      // Add index on timestamp for chronological queries
      timestampIdx: index("idx_snapshots_timestamp").on(table.timestamp),
      // Add compound index for a story's chronological snapshots
      storyTimeIdx: index("idx_snapshots_story_time").on(
        table.storyId,
        table.timestamp,
      ),
      // Add index on expiration for cleanup queries
      expiresIdx: index("idx_snapshots_expires").on(table.expiresAt),
    };
  },
);
