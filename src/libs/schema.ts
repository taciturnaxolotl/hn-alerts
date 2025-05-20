import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Define the users table
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  hackernewsUsername: text("hackernews_username"),
  challenge: text("challenge"),
  verified: integer("verified", { mode: "boolean" }).default(false).notNull(),
});

export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey(),
  by: text("by").notNull(),
  title: text("title").notNull(),
  url: text("url"),
  text: text("text"),
  time: integer("time").notNull(),
  score: integer("score"),
  descendants: integer("descendants"),

  // New tracking fields
  firstSeenAt: integer("first_seen_at").notNull(), // When we first saw it
  lastUpdatedAt: integer("last_updated_at").notNull(), // Last time we updated this record
  notifiedAt: integer("notified_at"), // When first notification was sent
  
  // Notification tracking flags - avoids duplicate notifications on restart
  notifiedNewStory: integer("notified_new_story", { mode: "boolean" }).default(false),
  notifiedFrontPage: integer("notified_front_page", { mode: "boolean" }).default(false),
  notifiedNumberOne: integer("notified_number_one", { mode: "boolean" }).default(false),

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
});

// For tracking leaderboard positions
export const leaderboardSnapshots = sqliteTable("leaderboard_snapshots", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  storyId: integer("story_id")
    .notNull()
    .references(() => stories.id),
  timestamp: integer("timestamp").notNull(),
  position: integer("position").notNull(),
  score: integer("score").notNull(),

  // TTL for cleanup
  expiresAt: integer("expires_at").notNull(),
});
