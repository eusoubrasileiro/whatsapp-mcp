import http, { type Server } from "node:http";
import pino, { type Logger } from "pino";
import { createNtfy } from "../ntfy.ts";
import { createPinGate } from "./auth.ts";
import { HubConfigError, loadHubConfig } from "./config.ts";
import { createPoller } from "./poller.ts";
import { createHubListener } from "./server.ts";
import { stringsFor } from "./strings.ts";

/** A slow client must not hold a connection open for ever. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface RunningHub {
  server: Server;
  /** Stops polling and closes the listener and every open connection. */
  stop(): Promise<void>;
}

export interface StartHubOptions {
  logger?: Logger;
  now?: () => number;
}

/**
 * Reads the environment, builds the hub and starts listening. Throws {@link HubConfigError}
 * (before binding anything) when the settings are unusable.
 */
export async function startHub(
  env: Record<string, string | undefined>,
  options: StartHubOptions = {},
): Promise<RunningHub> {
  const config = loadHubConfig(env);
  const logger =
    options.logger ??
    pino({ level: env.LOG_LEVEL || "info", timestamp: pino.stdTimeFunctions.isoTime });

  const gate = createPinGate({
    pin: config.pin,
    cookieKey: config.cookieKey,
    stateDir: config.stateDir,
    now: options.now,
    sendNtfy: createNtfy(logger, config.ntfy),
  });
  const poller = createPoller({ instances: config.instances, now: options.now });
  const server = http.createServer(
    createHubListener({
      poller,
      gate,
      logger,
      publicUrl: config.publicUrl,
      t: stringsFor(config.lang),
    }),
  );
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  poller.start();
  logger.info(
    { host: config.host, port: config.port, instances: config.instances.map((i) => i.label) },
    "hub listening",
  );

  return {
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        poller.stop();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface StartupFailureIo {
  write(text: string): void;
  exit(code: number): never;
}

/**
 * The hub could not start: say why, without a value that was in the environment, and exit
 * non-zero. A bad setting names its variable; anything else prints only its message.
 */
export function reportStartupFailure(
  err: unknown,
  io: StartupFailureIo = {
    write: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  },
): never {
  const text = err instanceof HubConfigError ? err.message : `The hub cannot start: ${err}`;
  io.write(`${text}\n`);
  return io.exit(1);
}
