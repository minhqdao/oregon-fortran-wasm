// @ts-check
//
// Adapted from Basicade's runner.worker.js for a compiled Fortran WASM module.
// The game is compiled into the module (nothing is interpreted from a fetched
// source), so unlike the BASIC interpreter worker we never write files into
// the virtual FS; stdin/stdout are bridged through the same SharedArrayBuffer
// protocol as Basicade.

import { runnerCommand, runnerEvent } from "./runner-protocol.js";

let createModule;

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

    // Current input line as character codes, plus the read cursor into it.
    // `line` is null when the previous line has been fully consumed and a new
    // one must be requested from the launcher.
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

        const length = Atomics.load(sharedKeys, 0);
        if (length === 0) {
          // Zero-length line: a genuine EOF (the game stops on IOSTAT < 0).
          reachedEof = true;
          return null;
        }

        line = [];
        for (let index = 0; index < length; index++) {
          line.push(Atomics.load(sharedKeys, 2 + index));
        }
        linePosition = 0;
      }

      if (linePosition >= line.length) {
        // Line fully delivered: end this read. The next read starts a new
        // line, mirroring canonical (cooked) terminal behaviour.
        line = null;
        return null;
      }

      const charCode = line[linePosition];
      linePosition++;
      return charCode;
    }

    const module = await createModule({
      noInitialRun: true,
      preRun: (emscriptenModule) => {
        emscriptenModule.FS.init(
          readStdinChar,
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
