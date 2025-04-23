import type { Config } from "drizzle-kit";

export default {
  schema: "./src/libs/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./local.db",
  },
} satisfies Config;
