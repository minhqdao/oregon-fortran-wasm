// @ts-check
//
// Adapted from Basicade's runner.worker.js for a compiled Fortran WASM module.
// The game is compiled into the module (nothing is interpreted from a fetched
// source), so unlike the BASIC interpreter worker we never write files into
// the virtual FS; stdin/stdout are bridged through the same SharedArrayBuffer
// protocol as Basicade.

import { readInputLine, runnerCommand, runnerEvent } from "./runner-protocol.js";

/** @type {{ (options: object): Promise<{ callMain: (args: unknown[]) => void }> } | undefined} */
let createModule;

/** @param {object} message */
function send(message) {
  self.postMessage(runnerEvent(message));
}

self.onmessage = async (event) => {
  try {
    const data = runnerCommand(event.data);
    if (data.type === "INIT") {
      const mod = await import(/* @vite-ignore */ data.wasmUrl);
      createModule = mod.default;
      send({ type: "READY" });
      return;
    }

    if (data.type !== "START" || !createModule) return;

    const sharedBuffer = new Int32Array(data.buffer);
    const sharedKeys = new Uint8Array(data.keys);
    let stdoutBuffer = "";

    // The current input line plus the read cursor into it. `line` is null
    // when the previous line has been fully consumed and a new one must be
    // requested from the launcher.
    /** @type {string | null} */
    let line = null;
    let linePosition = 0;
    let reachedEof = false;

    function flushStdout() {
      if (!stdoutBuffer) return;
      send({ type: "STDOUT", text: stdoutBuffer });
      stdoutBuffer = "";
    }

    // Serve the next keystroke to stdin. Emscripten's TTY layer loops until
    // its read() buffer is completely full, so we must hand out exactly one
    // line per read and report the end of the line (null) afterwards --
    // blocking there would stall the game waiting for input nobody typed.
    function readStdinChar() {
      if (reachedEof) return null;

      if (line === null) {
        flushStdout();
        send({ type: "REQUEST_INPUT" });
        Atomics.wait(sharedBuffer, 0, 0);
        Atomics.store(sharedBuffer, 0, 0);

        const submitted = readInputLine(sharedKeys);
        if (submitted === null) {
          // Zero-length line: a genuine EOF (the game stops on IOSTAT < 0).
          reachedEof = true;
          return null;
        }
        line = submitted;
        linePosition = 0;
      }

      if (linePosition >= line.length) {
        // Line fully delivered: end this read. The next read starts a new
        // line, mirroring canonical (cooked) terminal behaviour.
        line = null;
        return null;
      }

      const charCode = line.charCodeAt(linePosition);
      linePosition++;
      return charCode;
    }

    const createGameModule = createModule;
    if (!createGameModule) return;
    const module = await createGameModule({
      noInitialRun: true,
      /** @param {any} emscriptenModule */
      preRun: (emscriptenModule) => {
        emscriptenModule.FS.init(
          readStdinChar,
          /** @param {number} charCode */
          (charCode) => {
            // Emscripten's stdout is line-buffered and every Fortran record
            // ends in a newline, so output arrives promptly without any
            // explicit flushing on our side.
            const character = String.fromCharCode(charCode);
            if (character === "\n") {
              send({ type: "STDOUT", text: `${stdoutBuffer}\n` });
              stdoutBuffer = "";
            } else if (character !== "\r") {
              stdoutBuffer += character;
            }
          },
          /** @param {number} charCode */
          (charCode) => console.warn(String.fromCharCode(charCode)),
        );
      },
    });

    send({ type: "STARTED" });
    module.callMain([]);
    flushStdout();
    send({ type: "EXIT" });
    self.close();
  } catch (error) {
    send({
      type: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    self.close();
  }
};
