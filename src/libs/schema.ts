import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

// Define the users table
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  hackernewsUsername: text("hackernews_username"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull(),
});

export async function setupTriggers(pool: Pool) {
  await pool.query(`
    -- Create or replace the update function
    CREATE OR REPLACE FUNCTION update_user_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Drop trigger if exists and create a new one
    DROP TRIGGER IF EXISTS update_user_updated_at_trigger ON users;

    CREATE TRIGGER update_user_updated_at_trigger
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_user_updated_at();
  `);
}
