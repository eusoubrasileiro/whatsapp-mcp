#!/usr/bin/env node --experimental-strip-types
/**
 * Seed or upsert tenants into the DB from a JSON file.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node --experimental-strip-types scripts/seed-tenants.ts tenants.json
 *
 * JSON format:
 *   [
 *     { "id": "acme", "displayName": "ACME Corp", "expectedWaNumber": "5531999999999" },
 *     { "id": "demo", "displayName": "Demo Tenant", "expectedWaNumber": "5511888888888" }
 *   ]
 */

import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";

export type TenantSeed = {
  id: string;
  displayName: string;
  expectedWaNumber: string;
  ntfyTopicUrl?: string;
  writeToolsEnabled?: boolean;
  allowedWriteTools?: string[];
};

export type SeedResult = {
  created: number;
  updated: number;
};

/**
 * Core seeding logic — testable without CLI boilerplate.
 *
 * Accepts an already-connected PrismaClient and a config array.
 * Upserts each tenant, returns counts of created vs updated.
 */
export async function seedTenants(
  prisma: PrismaClient,
  tenants: TenantSeed[],
): Promise<SeedResult> {
  let created = 0;
  let updated = 0;

  for (const t of tenants) {
    const existing = await prisma.tenant.findUnique({ where: { id: t.id } });

    await prisma.tenant.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        displayName: t.displayName,
        expectedWaNumber: t.expectedWaNumber,
        ntfyTopicUrl: t.ntfyTopicUrl ?? null,
        writeToolsEnabled: t.writeToolsEnabled ?? false,
        allowedWriteTools: t.allowedWriteTools ?? [],
      },
      update: {
        displayName: t.displayName,
        expectedWaNumber: t.expectedWaNumber,
        ...(t.ntfyTopicUrl !== undefined ? { ntfyTopicUrl: t.ntfyTopicUrl } : {}),
        ...(t.writeToolsEnabled !== undefined ? { writeToolsEnabled: t.writeToolsEnabled } : {}),
        ...(t.allowedWriteTools !== undefined ? { allowedWriteTools: t.allowedWriteTools } : {}),
      },
    });

    if (existing) {
      updated++;
    } else {
      created++;
    }
  }

  return { created, updated };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node --experimental-strip-types scripts/seed-tenants.ts <tenants.json>");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const tenants: TenantSeed[] = JSON.parse(raw);

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  await prisma.$queryRawUnsafe("SELECT 1");

  const result = await seedTenants(prisma, tenants);

  const total = await prisma.tenant.count();
  console.log(`\nDone. ${result.created} created, ${result.updated} updated. Total in DB: ${total}`);

  await prisma.$disconnect();
}

const isDirectExecution = process.argv[1]?.includes("seed-tenants");
if (isDirectExecution) {
  main().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
