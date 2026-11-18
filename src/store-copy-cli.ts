/**
 * Entry point of the media-store copy tool; everything with a decision in it is in
 * `store-copy.ts`. Run as: node --experimental-strip-types src/store-copy-cli.ts <command>
 * with the STORE_COPY_* environment described there.
 */
import { runCli } from "./store-copy.ts";

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
