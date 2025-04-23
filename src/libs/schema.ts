import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Define the users table
export const users = sqliteTable("users", {
	id: text("id").primaryKey(), // Slack user ID
	hackernewsUsername: text("hackernews_username"),
	createdAt: integer("created_at", { mode: "timestamp" }),
	lastUpdatedAt: integer("last_updated_at", { mode: "timestamp" }),
});
