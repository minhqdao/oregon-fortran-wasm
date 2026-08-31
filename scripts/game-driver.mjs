// Shared driver: runs the Oregon Trail game headlessly under Node and returns
// its complete stdout for a given input transcript. Two backends share the
// same interface so tests can compare them byte-for-byte:
//
//   runNative(binary, lines)  -- spawns the compiled native binary and pipes
//                                the transcript to its stdin.
//   runWasm(wasmUrl, lines)   -- drives the real web/runner.worker.js inside
//                                a Node worker thread over SharedArrayBuffer,
//                                mirroring the browser launcher.
//
// Both return { output, exitCode, timedOut }. Output is captured verbatim;
// callers normalize it before asserting.

import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import {
  createKeysBuffer,
  writeInputLine,
} from "../web/runner-protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export function runNative(binary, lines, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd = process.cwd() } = opts;
  return new Promise((resolve) => {
    const child = spawn(binary, [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ output, stderr, exitCode: code, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output: String(error), stderr, exitCode: 1, timedOut });
    });

    // Write the whole transcript, then close stdin. The game treats the
    // resulting EOF as end of session (ISTAT < 0 -> STOP -> exit).
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

export function runWasm(wasmUrl, lines, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./worker-node-adapter.mjs", import.meta.url),
      { type: "module" },
    );

    const buffer = new SharedArrayBuffer(4);
    const keys = createKeysBuffer();
    const sharedBuffer = new Int32Array(buffer);
    const sharedKeys = new Uint8Array(keys);

    let output = "";
    let stderrBuf = "";
    let lineIndex = 0;
    let timedOut = false;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(payload);
    };

    const sendLine = (line) => {
      writeInputLine(sharedKeys, `${line}\n`);
      Atomics.store(sharedBuffer, 0, 1);
      Atomics.notify(sharedBuffer, 0, 1);
    };

    const sendEof = () => {
      Atomics.store(sharedKeys, 0, 0);
      Atomics.store(sharedBuffer, 0, 1);
      Atomics.notify(sharedBuffer, 0, 1);
    };

    worker.on("message", (message) => {
      switch (message?.type) {
        case "READY":
          worker.postMessage({ type: "START", buffer, keys });
          break;
        case "STDOUT":
          output += message.text;
          break;
        case "STDERR":
          stderrBuf += message.text;
          break;
        case "REQUEST_INPUT":
          try {
            if (lineIndex < lines.length) {
              sendLine(lines[lineIndex++]);
            } else {
              sendEof();
            }
          } catch (error) {
            // An input line the shared protocol cannot carry (e.g. over the
            // buffer cap) fails this session instead of crashing the runner.
            finish({
              output,
              stderr: `${stderrBuf}${error}\n`,
              exitCode: 1,
              timedOut,
            });
          }
          break;
        case "EXIT":
          finish({ output, stderr: stderrBuf, exitCode: message.code ?? 0, timedOut });
          break;
        case "ERROR":
          finish({
            output,
            stderr: `${stderrBuf}${message.message}`,
            exitCode: 1,
            timedOut,
          });
          break;
      }
    });

    worker.on("error", (error) => {
      finish({ output, stderr: `${stderrBuf}${String(error)}`, exitCode: 1, timedOut });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ output, stderr: stderrBuf, exitCode: null, timedOut });
    }, timeoutMs);

    worker.postMessage({ type: "INIT", wasmUrl });
  });
}

// Normalize captured output for comparison: drop carriage returns, collapse
// runs of spaces/tabs to a single space, and trim trailing blanks per line.
// Preserves line structure so substring assertions stay readable.
export function normalize(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
