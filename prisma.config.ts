import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

// Load .env (default) plus .env.dev if present, without overriding real env.
dotenv.config({ path: ".env", quiet: true });
if (fs.existsSync(path.join(process.cwd(), ".env.dev"))) {
  dotenv.config({ path: ".env.dev", quiet: true });
}

// `prisma generate` does not require a live URL — but env() throws if missing.
// Provide a benign fallback so generate works without a dev Postgres up.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/placeholder";
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
