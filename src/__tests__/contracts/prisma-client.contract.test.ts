import { describe, it, expect } from "vitest";

/**
 * Contract test pinning the @prisma/client API surface we depend on.
 * Constructs a client with the Pg driver adapter (Prisma 7 requirement) but
 * does NOT connect — all assertions are about the JS surface shape.
 *
 * Any breakage here (rename of PrismaClient, $disconnect, $transaction, or
 * $queryRawUnsafe) will fail this test BEFORE ingestion tests break.
 */

describe("@prisma/client contract", () => {
  it("exports PrismaClient as a constructor", async () => {
    const mod = await import("@prisma/client");
    expect(typeof mod.PrismaClient).toBe("function");
  });

  it("@prisma/adapter-pg PrismaPg constructs without error", async () => {
    const mod = await import("@prisma/adapter-pg");
    expect(typeof mod.PrismaPg).toBe("function");
  });

  it("PrismaClient({ adapter }) constructs with a Pg adapter and exposes $disconnect/$transaction/$queryRawUnsafe", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");

    // Connection string is fake — connection is lazy.
    const adapter = new PrismaPg({ connectionString: "postgresql://noop@localhost:65535/noop" });
    const client = new PrismaClient({ adapter });
    expect(client).toBeDefined();
    expect(typeof client.$disconnect).toBe("function");
    expect(typeof client.$transaction).toBe("function");
    expect(typeof client.$queryRawUnsafe).toBe("function");
    expect(typeof client.$executeRawUnsafe).toBe("function");
    await client.$disconnect().catch(() => {});
  });
});
