// @ts-check

/** @typedef {{type: "INIT", wasmUrl: string} | {type: "START", buffer: SharedArrayBuffer, keys: SharedArrayBuffer}} RunnerCommand */
/** @typedef {{type: "READY"} | {type: "STARTED"} | {type: "STDOUT", text: string} | {type: "REQUEST_INPUT"} | {type: "ERROR", message: string} | {type: "EXIT"}} RunnerEvent */

function messageRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runner protocol message must be an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

function requiredString(message, field) {
  const value = message[field];
  if (typeof value !== "string" || !value) {
    throw new TypeError(`Runner protocol field ${field} must be a string`);
  }
  return value;
}

/** Validates a command before it crosses the launcher-worker boundary. */
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

/** Validates an event before it crosses the launcher-worker boundary. */
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
