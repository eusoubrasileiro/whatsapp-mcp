import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Singleton PrismaClient. Module-level so tests can substitute via setPrismaClient().
 *
 * Construction is lazy — we only build the client on first access so that
 * tests importing this file do not eagerly open connections.
 */
let client: PrismaClient | null = null;

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in .env.dev for local dev or in the container env.",
    );
  }
  return url;
}

export function getPrisma(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
    client = new PrismaClient({ adapter });
  }
  return client;
}

/**
 * Test helper — inject a pre-built PrismaClient (e.g. one talking to a
 * test-scoped DB) before any query function runs.
 */
export function setPrismaClient(c: PrismaClient): void {
  client = c;
}

/**
 * Test helper — clear the cached singleton (does NOT $disconnect to avoid
 * confusing tests that still hold a reference to the injected client).
 */
export function resetPrismaClient(): void {
  client = null;
}

/**
 * Graceful shutdown helper for main.ts.
 */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
