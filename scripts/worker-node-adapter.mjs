// Test-only adapter: polyfills the browser WorkerGlobalScope API so the real
// web/runner.worker.js can execute inside a Node worker thread. Console
// output from the worker (LFortran runtime diagnostics written one
// character at a time, such as the STOP notice) is forwarded as STDERR
// messages instead of leaking into the test runner's terminal.
import { parentPort } from "node:worker_threads";

globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.close = () => process.exit(0);

for (const channel of ["warn", "error"]) {
  console[channel] = (...args) => {
    const text = args.map(String).join(" ");
    parentPort.postMessage({ type: "STDERR", text });
  };
}

parentPort.on("message", (data) => {
  if (globalThis.onmessage) globalThis.onmessage({ data });
});

await import(new URL("../web/runner.worker.js", import.meta.url));

// Keep the worker alive; it reacts to messages via onmessage.
setInterval(() => {}, 1e9);
