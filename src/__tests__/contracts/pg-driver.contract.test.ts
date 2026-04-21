import { describe, it, expect } from "vitest";

/**
 * Contract test pinning the `pg` npm API surface we depend on.
 * Pure API-shape test — does NOT connect to a database.
 */

describe("pg driver contract", () => {
  it("exports Pool and Client as constructors", async () => {
    const pg = await import("pg");
    expect(typeof pg.Pool).toBe("function");
    expect(typeof pg.Client).toBe("function");
  });

  it("Pool exposes query/end methods", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: "postgresql://noop@localhost:65535/noop" });
    expect(typeof pool.query).toBe("function");
    expect(typeof pool.end).toBe("function");
    expect(typeof pool.connect).toBe("function");
    await pool.end().catch(() => {});
  });
});
