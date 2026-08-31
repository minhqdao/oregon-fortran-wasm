// @ts-check

/** @typedef {{type: "INIT", wasmUrl: string} | {type: "START", buffer: SharedArrayBuffer, keys: SharedArrayBuffer}} RunnerCommand */
/** @typedef {{type: "READY"} | {type: "STARTED"} | {type: "STDOUT", text: string} | {type: "REQUEST_INPUT"} | {type: "ERROR", message: string} | {type: "EXIT"}} RunnerEvent */

/** @param {unknown} value */
function messageRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runner protocol message must be an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

// --- input line layout -------------------------------------------------------
//
// The keys SharedArrayBuffer carries one submitted line at a time:
// [0] character length, [1] padding, [2..] the characters including the
// trailing newline. The launcher, the runner worker and the Node test
// driver all share this layout, so the buffer size and the accessors live
// here; a maximum-length line must fit without Atomics silently dropping
// out-of-range writes.

export const maxInputLength = 254;
const keysLengthSlot = 0;
const keysTextOffset = 2;

export function createKeysBuffer() {
  return new SharedArrayBuffer(keysTextOffset + maxInputLength + 1);
}

/**
 * Writes one submitted line (including its trailing "\n") and its length.
 * The caller must keep the line within printable ASCII plus the newline;
 * the buffer stores single bytes, so other code points would wrap silently.
 * @param {Uint8Array} view @param {string} line
 */
export function writeInputLine(view, line) {
  if (line.length > 255 || keysTextOffset + line.length > view.length) {
    throw new RangeError(
      `input line of ${line.length} characters exceeds the keys buffer`,
    );
  }
  for (let index = 0; index < line.length; index++) {
    Atomics.store(view, keysTextOffset + index, line.charCodeAt(index));
  }
  Atomics.store(view, keysLengthSlot, line.length);
}

/** @param {Uint8Array} view @returns {string | null} null on EOF */
export function readInputLine(view) {
  const length = Atomics.load(view, keysLengthSlot);
  if (length === 0) return null;
  let text = "";
  for (let index = 0; index < length; index++) {
    text += String.fromCharCode(Atomics.load(view, keysTextOffset + index));
  }
  return text;
}

/**
 * @param {Record<string, unknown>} message
 * @param {string} field
 */
function requiredString(message, field) {
  const value = message[field];
  if (typeof value !== "string" || !value) {
    throw new TypeError(`Runner protocol field ${field} must be a string`);
  }
  return value;
}

/**
 * Validates a command before it crosses the launcher-worker boundary.
 * @param {unknown} value
 */
export function runnerCommand(value) {
  const message = messageRecord(value);
  const type = requiredString(message, "type");
  if (type === "INIT") {
    return /** @type {RunnerCommand} */ ({
      type,
      wasmUrl: requiredString(message, "wasmUrl"),
    });
  }
  if (type === "START") {
    if (!(message.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Runner protocol field buffer must be shared memory");
    }
    if (!(message.keys instanceof SharedArrayBuffer)) {
      throw new TypeError("Runner protocol field keys must be shared memory");
    }
    return /** @type {RunnerCommand} */ ({
      type,
      buffer: message.buffer,
      keys: message.keys,
    });
  }
  throw new TypeError(`Unknown runner command: ${type}`);
}

/**
 * Validates an event before it crosses the launcher-worker boundary.
 * @param {unknown} value
 */
export function runnerEvent(value) {
  const message = messageRecord(value);
  const type = requiredString(message, "type");
  if (
    type === "READY" ||
    type === "STARTED" ||
    type === "REQUEST_INPUT" ||
    type === "EXIT"
  ) {
    return /** @type {RunnerEvent} */ ({ type });
  }
  if (type === "STDOUT") {
    return /** @type {RunnerEvent} */ ({
      type,
      text: requiredString(message, "text"),
    });
  }
  if (type === "ERROR") {
    return /** @type {RunnerEvent} */ ({
      type,
      message: requiredString(message, "message"),
    });
  }
  throw new TypeError(`Unknown runner event: ${type}`);
}
