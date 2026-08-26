// Test-only adapter: polyfills the browser WorkerGlobalScope API so the real
// web/runner.worker.js can execute inside a Node worker thread.
import { parentPort } from "node:worker_threads";

globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.close = () => process.exit(0);

parentPort.on("message", (data) => {
  if (globalThis.onmessage) globalThis.onmessage({ data });
});

await import(new URL("../web/runner.worker.js", import.meta.url));

// Keep the worker alive; it reacts to messages via onmessage.
setInterval(() => {}, 1e9);
