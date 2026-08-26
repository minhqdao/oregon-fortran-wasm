/** Coalesces repeated work into one browser animation frame. */
export function createFrameBatcher(
  run,
  {
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
  } = {},
) {
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
