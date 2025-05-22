import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";

// Use environment variable for the database path in production
const dbPath = process.env.DATABASE_PATH || "./local.db";

// Create a SQLite database instance using Bun's built-in driver with improved concurrency settings
const sqlite = new Database(dbPath, {
  // Use WAL mode for better concurrency
  readonly: false,
  create: true
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

// Export the sqlite instance and schema for use in other files
export { sqlite, schema };
