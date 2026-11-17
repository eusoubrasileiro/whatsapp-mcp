/**
 * What a spec needs to run a real server from a rendered compose service: the settings the app
 * reads that the compose file gives a number's container, and where the server finds its own
 * number's store (loopback, that store's pair) in place of the container name the file names.
 */
import type { RenderedService } from "./compose.ts";

/** The settings the app reads that the compose file gives a number's container. */
const APP_SETTINGS = [
  "INSTANCE_LABEL",
  "INSTANCE_DESCRIPTION",
  "TENANT_ID",
  "UPLOAD_PUBLIC_URL",
  "MEDIA_PUBLIC_BASE_URL",
  "STREAM_PUBLIC_URL",
  "PUBLIC_QR_URL",
  "EXPECTED_WA_NUMBER",
  "S3_BUCKET",
];

export function only(services: Record<string, RenderedService>, key: string): RenderedService {
  const service = services[key];
  if (!service) throw new Error(`no service ${key} in ${Object.keys(services)}`);
  return service;
}

/** The named settings of a rendered service; fails on one it does not have. */
export function pick(service: RenderedService, keys: string[]): Record<string, string> {
  const env = service.environment ?? {};
  return Object.fromEntries(
    keys.map((key) => {
      const value = env[key];
      if (value === undefined) throw new Error(`the rendered service has no ${key}`);
      return [key, value];
    }),
  );
}

/** The environment of a server that stands in for the rendered app, on the store at `port`. */
export function appServerEnv(
  app: RenderedService,
  store: { port: number },
): Record<string, string> {
  const env = app.environment ?? {};
  return {
    ...pick(app, APP_SETTINGS),
    S3_ENDPOINT: "127.0.0.1",
    S3_PORT: String(store.port),
    S3_USE_SSL: "false",
    S3_ACCESS_KEY: env.S3_ACCESS_KEY as string,
    S3_SECRET_KEY: env.S3_SECRET_KEY as string,
  };
}
