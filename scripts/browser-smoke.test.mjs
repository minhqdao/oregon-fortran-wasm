// Browser-level smoke test for the launcher's touch-gesture contract: the
// soft keyboard (modeled in jsdom as focus() calls on the hidden input) may
// only be raised by a released tap, never by touch-down or by a drag that is
// scrolling the terminal / panning a text selection. A browser regression
// that focuses on pointerdown -- the bug this test was written for -- fails
// here, not on someone's iPhone.
//
// It also pins the faithful input-forwarding contract: the field keeps
// whatever the IME produced and the live echo mirrors it, while the game's
// ASCII policy applies exactly once, at submit (composed accents must
// yield their base letter, never vanish).
//
// jsdom lives in a scratch node_modules (see scripts/browser-smoke.sh); the
// test skips gracefully when it has not been installed.
//
//   node --test scripts/browser-smoke.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

// jsdom is installed into a scratch directory that scripts/browser-smoke.sh
// points at with $SMOKE_NODE_MODULES, so no package.json or node_modules has
// to exist inside the repository.
function resolveJSDOM() {
  const scratch = process.env.SMOKE_NODE_MODULES;
  if (!scratch) return null;
  try {
    return require(join(scratch, "jsdom")).JSDOM;
  } catch {
    return null;
  }
}

const JSDOM = resolveJSDOM();

if (!JSDOM) {
  console.warn(
    "browser-smoke.test.mjs skipped: run scripts/browser-smoke.sh (installs jsdom into a scratch cache directory)",
  );
  test("jsdom scratch install missing", { skip: true }, () => {});
}

if (JSDOM) {
  const indexUrl = new URL("../web/index.html", import.meta.url);
  let scenarioCount = 0;

  async function openLauncherPage() {
    scenarioCount += 1;
    const html = readFileSync(indexUrl, "utf8");
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    const { window } = dom;

    window.crossOriginIsolated = true;
    window.matchMedia = (query) => ({
      matches: query.includes("coarse"),
      addEventListener() {},
      removeEventListener() {},
    });

    class FakeGameWorker {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.dead = false;
      }
      emit(data) {
        if (!this.dead) this.onmessage?.({ data });
      }
      postMessage(command) {
        if (command.type === "INIT") {
          setTimeout(() => this.emit({ type: "READY" }), 0);
        } else if (command.type === "START") {
          setTimeout(() => this.emit({ type: "STARTED" }), 0);
          setTimeout(() => this.emit({ type: "REQUEST_INPUT" }), 0);
        }
      }
      terminate() {
        this.dead = true;
      }
    }

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.sessionStorage = window.sessionStorage;
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    globalThis.Worker = FakeGameWorker;

    // Fresh module instance + fresh listener bindings per scenario.
    await import(`../web/launcher.js?smoke=${scenarioCount}`);

    const input = window.document.getElementById("terminal-input");
    const waitFor = async (predicate, attempts = 20) => {
      for (let i = 0; i < attempts; i++) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return predicate();
    };

    // The launcher auto-focuses the command field once the game asks for
    // input (the input event is a synthetic { data } so the runner protocol
    // accepts it). jsdom keeps focus without raising any keyboard, which is
    // exactly the iOS state a tap must recover from.
    assert.ok(
      await waitFor(() => window.oregonDebug.state.waitingForInput),
      "launcher did not reach the waiting-for-input prompt",
    );
    // jsdom's default activeElement is <body>, so the game's initial
    // focus() is what actually moves it onto the field; confirm both.
    assert.equal(window.document.activeElement, input);

    const calls = { focus: 0, blur: 0 };
    const nativeFocus = input.focus.bind(input);
    const nativeBlur = input.blur.bind(input);
    input.focus = (options) => {
      calls.focus += 1;
      return nativeFocus(options);
    };
    input.blur = () => {
      calls.blur += 1;
      return nativeBlur();
    };

    const mouseTypes = new Set(["click", "mousedown"]);
    const fire = (target, type, props = {}) => {
      // MouseEvent coordinates are readonly constructor properties; plain
      // Events accept expandos instead. The launcher compares event.target
      // against the scroll container, so force it on both shapes.
      const event = mouseTypes.has(type)
        ? new window.MouseEvent(type, { bubbles: true, cancelable: true, ...props })
        : Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), props);
      Object.defineProperty(event, "target", { value: target });
      target.dispatchEvent(event);
      return event;
    };
    const touch = (x, y, id = 1) => ({
      pointerType: "touch",
      pointerId: id,
      clientX: x,
      clientY: y,
    });

    return { window, input, calls, fire, touch };
  }

  test("touch-down alone does not open the keyboard", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    input.blur();
    calls.focus = 0;
    fire(window.document.getElementById("screen"), "pointerdown", touch(50, 300));
    assert.equal(calls.focus, 0, "pointerdown must not focus (old regression)");
    assert.notEqual(window.document.activeElement, input);
    fire(window.document.getElementById("screen"), "pointercancel", touch(50, 300));
  });

  test("tap on the terminal raises the keyboard", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    input.blur();
    calls.focus = 0;
    fire(screen, "pointerdown", touch(50, 300));
    fire(screen, "pointerup", touch(51, 301));
    fire(screen, "click", { clientX: 51, clientY: 301 });
    assert.ok(calls.focus >= 1, "tap must focus the command field");
    assert.equal(window.document.activeElement, input);
  });

  test("tap while focused-but-keyboard-closed re-activates on iOS", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    // State right after the game's auto-focus: field focused, no keyboard.
    assert.equal(window.document.activeElement, input);
    calls.focus = 0;
    calls.blur = 0;
    fire(screen, "pointerdown", touch(40, 250));
    fire(screen, "pointerup", touch(40, 250));
    fire(screen, "click", { clientX: 40, clientY: 250 });
    assert.ok(
      calls.blur >= 1 && calls.focus >= 1,
      "tapping a focused field with no keyboard must blur+refocus inside the gesture",
    );
    assert.equal(window.document.activeElement, input);
  });

  test("scroll drag over the terminal does not open the keyboard", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    input.blur();
    calls.focus = 0;
    // What iOS/Android send while the user scrolls: pointer events, no click.
    fire(screen, "pointerdown", touch(50, 400));
    for (let y = 380; y >= 200; y -= 20) {
      fire(screen, "pointermove", touch(50, y));
    }
    fire(screen, "pointerup", touch(50, 200));
    assert.equal(calls.focus, 0, "a scroll drag must never focus");
    assert.notEqual(window.document.activeElement, input);
  });

  test("cancelled gesture (browser scroll takeover) does not open the keyboard", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    input.blur();
    calls.focus = 0;
    fire(screen, "pointerdown", touch(50, 400));
    fire(screen, "pointercancel", touch(50, 320));
    assert.equal(calls.focus, 0);
    assert.notEqual(window.document.activeElement, input);
  });

  test("desktop click still focuses the command field", async (t) => {
    const { window, input, fire, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    input.blur();
    calls.focus = 0;
    fire(screen, "mousedown", { clientX: 50, clientY: 300 });
    fire(screen, "click", { clientX: 50, clientY: 300 });
    assert.equal(calls.focus, 1, "plain click focuses exactly once");
    assert.equal(window.document.activeElement, input);
  });

  test("typed text echoes faithfully and submits the normalized line", async (t) => {
    const { window, input } = await openLauncherPage();
    const live = window.document.getElementById("input");
    const output = window.document.getElementById("output");

    // What the Vietnamese Telex IME leaves in the field after "l","o","o",
    // "k": the second "o" was consumed to compose ô over the first.
    input.value = "loôk";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(live.textContent, "LOÔK", "the live echo shows the composed character");
    assert.equal(input.value, "loôk", "typing never rewrites the native value");

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    assert.ok(output.textContent.endsWith("LOOK\n"), "the transcript records the engine line");
    assert.ok(!output.textContent.includes("LOÔK"), "the echo and engine line agree");
    assert.equal(input.value, "", "submit clears the field");
  });

  test("đ, curly quotes and CJK normalize at submit, never while typing", async (t) => {
    const { window, input } = await openLauncherPage();
    const live = window.document.getElementById("input");
    const output = window.document.getElementById("output");

    input.value = "đ_on\u2019t 冒険";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(live.textContent, "Đ_ON’T 冒険", "nothing is stripped mid-typing");

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    assert.ok(
      output.textContent.endsWith("D_ON'T \n"),
      "stroke-d maps to D, curly quotes to ascii, CJK drops",
    );
  });

  /** Counts field-selection writes; a caret move is an edit under an IME. */
  function spyCaret(input) {
    let writes = 0;
    const native = input.setSelectionRange.bind(input);
    input.setSelectionRange = (...args) => {
      writes += 1;
      return native(...args);
    };
    return () => writes;
  }

  test("IME composition owns the caret; plain typing re-pins it", async (t) => {
    const { window, input } = await openLauncherPage();
    const live = window.document.getElementById("input");
    const caretWrites = spyCaret(input);

    // Plain typing re-pins the caret to the end (append-only contract).
    input.value = "OK";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(caretWrites(), 1, "plain typing re-pins the caret");

    // What macOS/Windows Telex IMEs hold as marked text while the user
    // types a,s,s,s,s -- each update REPLACES the marked range. A caret
    // write here instead corrupts the range, and every update re-inserts
    // the whole pending composition (AÁASASS...).
    input.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
    for (const marked of ["a", "á", "ás", "áss", "ásss"]) {
      input.value = marked;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(live.textContent, marked.toUpperCase());
    }
    assert.equal(caretWrites(), 1, "input events under composition must not move the caret");

    // Commit: the launcher takes the caret back, echo unchanged.
    input.dispatchEvent(new window.Event("compositionend", { bubbles: true }));
    assert.equal(caretWrites(), 2, "the commit re-takes the caret");
    assert.equal(live.textContent, "ÁSSS");
  });

  test("Enter inside a composition commits it; the next Enter submits", async (t) => {
    const { window, input } = await openLauncherPage();
    const output = window.document.getElementById("output");

    input.value = "loôk";
    input.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    // The committing Enter, in both shapes: the standard isComposing flag
    // and Android's legacy keyCode 229.
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
    assert.ok(!output.textContent.includes("LOOK\n"), "a composing Enter must not submit");

    input.dispatchEvent(new window.Event("compositionend", { bubbles: true }));
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    assert.ok(output.textContent.endsWith("LOOK\n"), "the line survives to submit");
  });

  test("tapping the terminal mid-composition leaves the field alone", async (t) => {
    const { window, input, fire, touch, calls } = await openLauncherPage();
    const screen = window.document.getElementById("screen");
    const caretWrites = spyCaret(input);

    input.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
    input.value = "ásss";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    calls.blur = 0;

    // The released tap refocuses the field on iOS (blur + focus + caret
    // re-pin); none of it may write the selection while the IME holds it --
    // the user's report: the click appended the pending composition (ASSS)
    // to the line one more time.
    fire(screen, "pointerdown", touch(40, 250));
    fire(screen, "pointerup", touch(40, 250));
    fire(screen, "click", { clientX: 40, clientY: 250 });
    assert.ok(calls.blur >= 1, "the tap must have taken the refocus path");
    assert.equal(caretWrites(), 0, "the refocus path must not touch the caret mid-composition");
    assert.equal(input.value, "ásss", "the field value is untouched");
  });
}
