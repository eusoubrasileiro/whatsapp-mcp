import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  setPrismaClient,
  resetPrismaClient,
} from "../db/client.ts";

/**
 * Tests for the tenant seeding script.
 *
 * Requires a real Postgres instance (docker-compose.dev.yaml).
 *
 * Run with:
 *   docker compose -f docker-compose.dev.yaml up -d postgres
 *   pnpm exec prisma migrate deploy
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://whatsapp_mcp:whatsapp_mcp_dev@localhost:5432/whatsapp_mcp pnpm test src/__tests__/seed-tenants.test.ts
 */

const runDbTests = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!runDbTests)("seed-tenants", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
    setPrismaClient(prisma);
    await prisma.$queryRawUnsafe("SELECT 1");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    resetPrismaClient();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "messages", "chats", "contacts", "tenants" RESTART IDENTITY CASCADE`,
    );
  });

  it("creates tenants from a config array", async () => {
    const { seedTenants } = await import("../../scripts/seed-tenants.ts");

    const config = [
      {
        id: "t-alice",
        displayName: "Alice Store",
        expectedWaNumber: "5531999000001",
        writeToolsEnabled: true,
      },
      {
        id: "t-bob",
        displayName: "Bob Clinic",
        expectedWaNumber: "5511888000002",
        writeToolsEnabled: false,
        allowedWriteTools: ["send_message"],
        ntfyTopicUrl: "https://ntfy.sh/bob-topic",
      },
    ];

    const result = await seedTenants(prisma, config);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);

    const alice = await prisma.tenant.findUnique({ where: { id: "t-alice" } });
    expect(alice).not.toBeNull();
    expect(alice!.displayName).toBe("Alice Store");
    expect(alice!.writeToolsEnabled).toBe(true);
    expect(alice!.allowedWriteTools).toEqual([]);

    const bob = await prisma.tenant.findUnique({ where: { id: "t-bob" } });
    expect(bob).not.toBeNull();
    expect(bob!.ntfyTopicUrl).toBe("https://ntfy.sh/bob-topic");
    expect(bob!.allowedWriteTools).toEqual(["send_message"]);
  });

  it("upserts — updates existing tenants without losing data", async () => {
    const { seedTenants } = await import("../../scripts/seed-tenants.ts");

    await seedTenants(prisma, [
      {
        id: "t-alice",
        displayName: "Alice v1",
        expectedWaNumber: "5531",
        writeToolsEnabled: false,
      },
    ]);

    const result = await seedTenants(prisma, [
      {
        id: "t-alice",
        displayName: "Alice v2",
        expectedWaNumber: "5531",
        writeToolsEnabled: true,
      },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const alice = await prisma.tenant.findUnique({ where: { id: "t-alice" } });
    expect(alice!.displayName).toBe("Alice v2");
    expect(alice!.writeToolsEnabled).toBe(true);
  });

  it("handles empty config gracefully", async () => {
    const { seedTenants } = await import("../../scripts/seed-tenants.ts");
    const result = await seedTenants(prisma, []);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });
});
