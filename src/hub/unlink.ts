import type { HubInstance } from "./config.ts";

/** How long the hub waits for an instance to answer an unlink. */
export const UNLINK_TIMEOUT_MS = 10_000;

/** What the hub can say happened: the number was unlinked, was not connected, or we cannot tell. */
export type UnlinkOutcome = "unlinked" | "not_connected" | "failed";

export interface Unlinker {
  /** Asks the instance named `label`, and only that one, to unlink its number. Never throws. */
  run(label: string): Promise<UnlinkOutcome>;
}

export interface UnlinkerOptions {
  /** Shared with every instance's `HUB_INSTANCE_SECRET`. */
  secret: string;
  instances: HubInstance[];
  timeoutMs?: number;
}

export function createUnlinker(options: UnlinkerOptions): Unlinker {
  const { secret, instances } = options;
  const timeoutMs = options.timeoutMs ?? UNLINK_TIMEOUT_MS;

  return {
    async run(label) {
      const instance = instances.find((candidate) => candidate.label === label);
      if (!instance) return "failed";
      try {
        const res = await fetch(`${instance.baseUrl}/internal/unlink`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          // A redirect would carry the secret somewhere the operator never configured.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Only a 200 with the documented JSON counts. Nothing the instance says is passed on.
        if (res.status !== 200) {
          await res.body?.cancel();
          return "failed";
        }
        const body: unknown = await res.json();
        const unlinked = (body as { unlinked?: unknown } | null)?.unlinked;
        if (unlinked === true) return "unlinked";
        return unlinked === false ? "not_connected" : "failed";
      } catch {
        return "failed";
      }
    },
  };
}
