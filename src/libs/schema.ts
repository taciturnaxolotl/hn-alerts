import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Define the users table
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  hackernewsUsername: text("hackernews_username"),
  challenge: text("challenge"),
  verified: integer("verified", { mode: "boolean" }).default(false).notNull(),
});
