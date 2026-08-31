// Headless smoke test: drives the real web/runner.worker.js inside a Node
// worker thread with line-by-line input over SharedArrayBuffer, mirroring the
// browser launcher. Prints the game's stdout verbatim.
//
// Usage: node scripts/headless-test.mjs <path-to-oregon.js> <input-line>...
//
// The full regression suite lives in scripts/run-tests.mjs; this CLI exists
// for quick one-off checks and CI smoke tests.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runWasm } from "./game-driver.mjs";

const [wasmPath, ...lines] = process.argv.slice(2);
if (!wasmPath) {
  console.error("Usage: node scripts/headless-test.mjs <oregon.js> <line>...");
  process.exit(2);
}

const result = await runWasm(pathToFileURL(resolve(wasmPath)).href, lines);
process.stdout.write(result.output);
// A clean run still carries LFortran's STOP notice on stderr; only surface
// stderr when the run actually failed.
if (result.stderr && (result.timedOut || result.exitCode !== 0)) {
  console.error(`Runner error: ${result.stderr}`);
}
process.exit(result.timedOut || result.exitCode !== 0 ? 1 : 0);
