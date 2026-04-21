import type P from "pino";
import pLimit from "p-limit";

import { TenantConnection, type TenantRow } from "./tenant-connection.ts";
import { getPrisma } from "../db/client.ts";

export class TenantConnectionManager {
  private _connections = new Map<string, TenantConnection>();
  private _baseDir: string;
  private _logger: P.Logger;

  constructor(baseDir: string, logger: P.Logger) {
    this._baseDir = baseDir;
    this._logger = logger;
  }

  async loadFromDb(): Promise<void> {
    const prisma = getPrisma();
    const tenants = await prisma.tenant.findMany() as TenantRow[];
    this._logger.info(`Loading ${tenants.length} tenants from DB`);

    for (const tenant of tenants) {
      const tc = new TenantConnection(tenant, this._baseDir, this._logger);
      this._connections.set(tenant.id, tc);
    }
  }

  async startAll(concurrency: number = 5): Promise<void> {
    const limit = pLimit(concurrency);
    const entries = Array.from(this._connections.values());
    this._logger.info(`Starting ${entries.length} tenant connections (concurrency=${concurrency})`);

    await Promise.all(
      entries.map((tc) =>
        limit(async () => {
          try {
            await tc.start();
          } catch (err) {
            this._logger.error({ err, tenantId: tc.tenantId }, "Failed to start tenant connection");
          }
        }),
      ),
    );
  }

  async start(id: string): Promise<void> {
    const tc = this._connections.get(id);
    if (!tc) {
      throw new Error(`Tenant ${id} not found`);
    }
    await tc.start();
  }

  stop(id: string): void {
    const tc = this._connections.get(id);
    if (tc) {
      tc.stop();
    }
  }

  stopAll(): void {
    for (const tc of this._connections.values()) {
      tc.stop();
    }
  }

  get(id: string): TenantConnection | undefined {
    return this._connections.get(id);
  }

  list(): TenantConnection[] {
    return Array.from(this._connections.values());
  }

  statusSnapshot(): { id: string; displayName: string; status: string; hasQr: boolean; lastSeenAt: Date | null }[] {
    return this.list().map((tc) => ({
      id: tc.tenantId,
      ...tc.getStatus(),
    }));
  }
}
