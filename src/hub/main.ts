import { reportStartupFailure, startHub } from "./start.ts";

const hub = await startHub(process.env).catch(reportStartupFailure);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => hub.stop().then(() => process.exit(0)));
}
