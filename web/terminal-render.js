// @ts-check

/**
 * Coalesces repeated work into one browser animation frame.
 * @param {() => void} run
 * @param {{
 *   requestFrame?: (callback: () => void) => number,
 *   cancelFrame?: (handle: number) => void
 * }} [options]
 */
export function createFrameBatcher(
  run,
  {
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
  } = {},
) {
  /** @type {number | undefined} */
  let frame;

  return {
    schedule() {
      if (frame !== undefined) return;
      frame = requestFrame(() => {
        frame = undefined;
        run();
      });
    },

    flush() {
      if (frame !== undefined) {
        cancelFrame(frame);
        frame = undefined;
      }
      run();
    },

    cancel() {
      if (frame === undefined) return;
      cancelFrame(frame);
      frame = undefined;
    },
  };
}
