import type { Config } from "drizzle-kit";

// Parse connection string from environment variable
const databaseUrl = process.env.DATABASE_URL || "";
const url = new URL(databaseUrl);

export default {
  schema: "./src/libs/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    host: url.hostname,
    port: Number.parseInt(url.port),
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
    ssl: url.searchParams.get("sslmode") === "require",
  },
} satisfies Config;
