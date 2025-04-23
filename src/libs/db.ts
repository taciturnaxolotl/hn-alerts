import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";

// Use environment variable for the database path in production
const dbPath = process.env.DATABASE_PATH || "./local.db";

// Create a SQLite database instance using Bun's built-in driver
const sqlite = new Database(dbPath);

// Create a Drizzle instance with the database and schema
export const db = drizzle(sqlite, { schema });

// Export the sqlite instance and schema for use in other files
export { sqlite, schema };
