// Headless smoke test: drives the real web/runner.worker.js inside a Node
// worker thread with line-by-line input over SharedArrayBuffer, mirroring the
// browser launcher. Prints the game's stdout verbatim.
//
// Usage: node scripts/headless-test.mjs <path-to-oregon.js> <input-line>...

import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [wasmPath, ...lines] = process.argv.slice(2);
if (!wasmPath) {
  console.error("Usage: node scripts/headless-test.mjs <oregon.js> <line>...");
  process.exit(2);
}

const wasmUrl = pathToFileURL(resolve(wasmPath)).href;
const worker = new Worker(
  new URL("./worker-node-adapter.mjs", import.meta.url),
  { type: "module" },
);

const buffer = new SharedArrayBuffer(4);
const keys = new SharedArrayBuffer(256);
const sharedBuffer = new Int32Array(buffer);
const sharedKeys = new Uint8Array(keys);

let lineIndex = 0;

function sendLine(line) {
  const value = `${line}\n`;
  for (let index = 0; index < value.length; index++) {
    Atomics.store(sharedKeys, 2 + index, value.charCodeAt(index));
  }
  Atomics.store(sharedKeys, 0, value.length);
  Atomics.store(sharedBuffer, 0, 1);
  Atomics.notify(sharedBuffer, 0, 1);
}

function sendEof() {
  Atomics.store(sharedKeys, 0, 0);
  Atomics.store(sharedBuffer, 0, 1);
  Atomics.notify(sharedBuffer, 0, 1);
}

worker.on("message", (message) => {
  switch (message?.type) {
    case "READY":
      worker.postMessage({ type: "START", buffer, keys });
      break;
    case "STDOUT":
      process.stdout.write(message.text);
      break;
    case "REQUEST_INPUT":
      if (lineIndex < lines.length) {
        sendLine(lines[lineIndex++]);
      } else {
        // No more queued input: signal a genuine EOF (zero-length line). The
        // game treats a read EOF as end of input (ISTAT < 0 -> STOP).
        sendEof();
      }
      break;
    case "EXIT":
      worker.terminate();
      process.exit(0);
      break;
    case "ERROR":
      console.error(`Runner error: ${message.message}`);
      worker.terminate();
      process.exit(1);
      break;
  }
});

worker.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

worker.postMessage({ type: "INIT", wasmUrl });

setTimeout(() => {
  console.error("Timed out waiting for the game to exit.");
  worker.terminate();
  process.exit(1);
}, 30_000);
