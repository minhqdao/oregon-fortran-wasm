// End-to-end mobile-layout test for the bounded-terminal fix. Uses the
// shared Chrome harness (scripts/chrome-e2e.mjs) to serve web/ and drive
// headless Chrome over CDP with a phone-sized viewport and touch, asserting
// the four invariants the bug violated:
//
//   1. The page never grows with the game output (no page scroll).
//   2. The terminal container's height is bounded (a constant across
//      turns, not a monotonically increasing number).
//   3. The terminal scrolls internally once the transcript overflows.
//   4. The prompt (the input line) is always within the visible viewport.
//
// Invariant 1 is what makes the mobile layout unusable if it breaks, and
// it is also the one that fights the browser's pull-to-refresh, which
// needs a scroll range to fire from. The page keeps a token range for it
// and nothing else, so the two hold at once.
//
// It then stubs visualViewport before the page scripts run to simulate the
// soft keyboard (headless Chrome has no native keyboard emulation) and
// asserts the keyboard inset keeps the prompt in view.
//
// Usage:
//   node --test scripts/mobile-layout.test.mjs [port]  (default 8903, web/ served)

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findChrome, startChromeE2E, waitUntil } from "./chrome-e2e.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 8903;

// Mirrors the main padding-bottom (min(Npx, keyboard-inset)) of the touch
// shell in web/index.html -- the device emulated below is portrait, so
// N is 16 (the short-landscape block uses 8). Keep in step with the CSS.
const BREATHING_ROOM_PX = 16;

const CHROME = findChrome();
const skipReason = CHROME
  ? existsSync(join(repoRoot, "web", "index.html"))
    ? false
    : "web/ is missing from the checkout"
  : "no Chrome found (set $CHROME to enable)";

// One snapshot returns every invariant we care about plus the current
// visualViewport so a test can decide whether the keyboard is "open" or
// "closed" without re-querying.
const SNAPSHOT = `(() => {
  const screen = document.getElementById('screen');
  const container = document.getElementById('terminal-container');
  const main = document.querySelector('main');
  const input = document.getElementById('terminal-input');
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top*100)/100, bottom: Math.round(b.bottom*100)/100, height: Math.round(b.height*100)/100 }; };
  const vv = window.visualViewport;
  const keyboardInset = main ? parseFloat(getComputedStyle(main).getPropertyValue('--keyboard-inset')) || 0 : 0;
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  // Probe the dynamic viewport height the CSS actually sees (viewport
  // units are resolved by the engine, not by window.visualViewport).
  const probe = document.createElement('div');
  probe.style.height = '100dvh';
  document.body.appendChild(probe);
  const dvh100 = probe.offsetHeight;
  probe.remove();
  const mainComputed = main ? getComputedStyle(main).height : null;
  return {
    doc: {
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: Math.round(document.documentElement.scrollTop),
      innerHeight: window.innerHeight,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      overflow: getComputedStyle(document.documentElement).overflow,
      overscrollY: getComputedStyle(document.documentElement).overscrollBehaviorY,
      scrollRange: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    },
    screenOverscrollY: getComputedStyle(screen).overscrollBehaviorY,
    vv: vv ? { height: Math.round(vv.height*100)/100, offsetTop: Math.round(vv.offsetTop*100)/100, scale: vv.scale } : null,
    dvh100, mainComputed, keyboardInset: Math.round(keyboardInset*100)/100,
    main: r(main),
    container: r(container),
    screen: { ...r(screen), clientHeight: Math.round(screen.clientHeight*100)/100, scrollHeight: Math.round(screen.scrollHeight*100)/100, scrollTop: Math.round(screen.scrollTop*100)/100, scrolls: screen.scrollHeight > screen.clientHeight + 1 },
    promptBottom: Math.round(input.getBoundingClientRect().bottom*100)/100,
    promptInView: input.getBoundingClientRect().bottom <= visibleBottom + 1,
    actionsGap: Math.round((visibleBottom - document.querySelector('.terminal-actions').getBoundingClientRect().bottom)*100)/100,
    waiting: window.oregonDebug ? window.oregonDebug.state.waitingForInput : null,
  };
})()`;

// Replaces window.visualViewport with a stub before any page script runs,
// so launcher.js wires its listeners to the stub from the start. The
// stub exposes __setHeight / __setOffsetTop so the test can simulate the
// keyboard and the panning that accompanies it.
const VIEWPORT_STUB = `
(() => {
  let height = 844;
  let offsetTop = 0;
  const scale = 1;
  const listeners = { resize: [], scroll: [] };
  const vv = {
    get height() { return height; },
    get offsetTop() { return offsetTop; },
    get scale() { return scale; },
    get pageLeft() { return 0; },
    get pageTop() { return 0; },
    get width() { return 390; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type]; if (!list) return;
      const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
    },
    __setHeight(h) { height = h; for (const fn of listeners.resize) fn(); },
    __setOffsetTop(t) { offsetTop = t; for (const fn of listeners.scroll) fn(); },
  };
  // A real visualViewport fires scroll when the document scrolls -- the
  // only way a page pan reaches the launcher. Forward it so a leaked
  // drag reproduces device behavior; offsetTop stays 0 as in Chrome.
  window.addEventListener('scroll', () => {
    for (const fn of listeners.scroll) fn();
  }, true);
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
})();
`;

/**
 * A deterministic touch drag via explicit Input.dispatchTouchEvent.
 * Input.synthesizeScrollGesture is unreliable in Linux headless Chrome
 * (its events can bypass the page's touch listeners), so gestures are
 * spelled out here: the driver only reacts to real touch events, and
 * dispatchTouchEvent goes through the real input pipeline on every
 * platform.
 * @param {object} e2e the CDP client from startChromeE2E
 * @param {{ x: number, y: number, dx?: number, dy: number, steps?: number, stepMs?: number }} opts
 */
async function touchDrag(e2e, { x, y, dx = 0, dy, steps = 8, stepMs = 16 }) {
  await e2e.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  for (let i = 1; i <= steps; i++) {
    await e2e.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: x + (dx * i) / steps,
          y: y + (dy * i) / steps,
          id: 1,
          radiusX: 1,
          radiusY: 1,
          force: 1,
        },
      ],
    });
    if (stepMs) await new Promise((r) => setTimeout(r, stepMs));
  }
  await e2e.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

test(
  "mobile terminal: bounded box with internal scroll and visible prompt",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    const e2e = await startChromeE2E({
      chrome: CHROME,
      port,
      serve: "web",
      debugPort: 9700 + (process.pid % 200),
      profilePrefix: "oregon-fortran-mobile-profile",
    });
    try {
      await e2e.send("Page.enable");
      await e2e.send("Runtime.enable");
      await e2e.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await e2e.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      // Install the visualViewport stub BEFORE the page scripts run, so
      // launcher.js wires its listeners to the stub from the start.
      await e2e.send("Page.addScriptToEvaluateOnNewDocument", {
        source: VIEWPORT_STUB,
      });
      await e2e.send("Page.navigate", { url: `http://localhost:${port}/` });

      // Boot. The page may still be mid-navigation when the first probe
      // runs, so a throwing evaluate just means "keep waiting".
      assert.ok(
        await waitUntil(async () => {
          try {
            const out = await e2e.evaluate(
              "document.getElementById('output').textContent || ''",
            );
            return /DO YOU NEED INSTRUCTIONS/.test(out);
          } catch {
            return false;
          }
        }, 180, 500),
        "game reached first output",
      );
      await new Promise((r) => setTimeout(r, 400));

      // "Y" plays the four-page instructions (three PRESS RETURN KEY
      // pauses; any keystroke carries one), whose body is long enough to
      // overflow the transcript for the internal-scroll and log-drag
      // assertions. The outfitting replies that follow each produce the
      // next provisioning prompt (skill menu -> oxen -> food ->
      // ammunition -> clothing), so every command grows the transcript
      // while the game stays in its deterministic setup phase.
      const commands = ["Y", ".", ".", ".", "3", "200", "100", "50", "50"];
      const containerHeights = [];
      const snapshots = [];
      for (const cmd of commands) {
        assert.ok(
          await waitUntil(
            () => e2e.evaluate("window.oregonDebug.state.waitingForInput"),
            60,
            150,
          ),
          `prompt visible before command "${cmd}"`,
        );
        await e2e.send("Input.insertText", { text: cmd });
        await new Promise((r) => setTimeout(r, 120));
        await e2e.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await e2e.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await new Promise((r) => setTimeout(r, 700));
        const snap = await e2e.evaluate(SNAPSHOT);
        snapshots.push({ cmd, ...snap });
        containerHeights.push(snap.container.height);
      }

      // Invariant 1: the page never grows with the output.
      for (const s of snapshots) {
        assert.equal(
          s.doc.pageScrolls,
          false,
          `page should not scroll after "${s.cmd}" (doc.scrollHeight=${s.doc.scrollHeight}, innerHeight=${s.doc.innerHeight})`,
        );
        // Pull-to-refresh contract: it fires from a top overscroll of the
        // document, so the root must be neither clipped nor opted out,
        // and must have a range to overscroll -- browsers drop it on a
        // page with nothing to scroll. The range stays a token (one px),
        // which is why invariant 1 still holds.
        assert.equal(
          s.doc.overflow,
          "visible",
          `clipping the root kills pull-to-refresh (overflow=${s.doc.overflow})`,
        );
        assert.equal(
          s.doc.overscrollY,
          "auto",
          `overscroll-behavior: none is the pull-to-refresh opt-out (overscrollY=${s.doc.overscrollY})`,
        );
        assert.ok(
          s.doc.scrollRange > 0,
          `document needs a scroll range for pull-to-refresh (scrollHeight=${s.doc.scrollHeight}, clientHeight=${s.doc.scrollHeight - s.doc.scrollRange})`,
        );
        assert.ok(
          s.doc.scrollRange <= 2,
          `the pull-to-refresh range should be a token, got ${s.doc.scrollRange} px`,
        );
        assert.equal(
          s.screenOverscrollY,
          "auto",
          `the terminal is most of the page: it must not opt out of pull-to-refresh (overscrollY=${s.screenOverscrollY})`,
        );
      }

      // Invariant 2: the terminal container's height is bounded (a
      // constant, not a monotonically growing number).
      const heightSet = new Set(containerHeights);
      assert.equal(
        heightSet.size,
        1,
        `terminal container height should be constant, got ${JSON.stringify(containerHeights)}`,
      );
      const containerHeight = containerHeights[0];
      assert.ok(
        containerHeight > 200 && containerHeight < 800,
        `container height ${containerHeight} should be a usable phone-sized value`,
      );

      // Invariant 3: the terminal scrolls internally once the transcript
      // overflows the viewport.
      const last = snapshots[snapshots.length - 1];
      assert.ok(
        last.screen.scrolls,
        `screen should scroll internally (scrollHeight=${last.screen.scrollHeight}, clientHeight=${last.screen.clientHeight})`,
      );
      assert.ok(
        last.screen.scrollTop > 0,
        `screen should be scrolled down (scrollTop=${last.screen.scrollTop})`,
      );

      // Invariant 4: the prompt is always within the visible viewport.
      for (const s of snapshots) {
        assert.equal(
          s.promptInView,
          true,
          `prompt should be visible after "${s.cmd}" (promptBottom=${s.promptBottom}, visibleBottom=${s.vv ? s.vv.offsetTop + s.vv.height : s.doc.innerHeight})`,
        );
      }

      // Keyboard simulation: shrink the visual viewport and assert the
      // terminal shrinks in lockstep so the prompt stays in view.
      const before = await e2e.evaluate(SNAPSHOT);
      assert.equal(before.keyboardInset, 0, "no inset with the keyboard closed");
      // Open the keyboard: drop the visual viewport to roughly a phone
      // soft-keyboard size (about 300 px on an 844-px viewport).
      await e2e.evaluate("window.visualViewport.__setHeight(544)");
      await new Promise((r) => setTimeout(r, 250));
      const withKeyboard = await e2e.evaluate(SNAPSHOT);
      assert.ok(
        withKeyboard.keyboardInset > 200,
        `keyboard inset should track the ~300 px keyboard, got ${withKeyboard.keyboardInset}`,
      );
      // The main column shrank by roughly the inset, so the prompt rides
      // just above the new visible bottom.
      assert.ok(
        withKeyboard.main.height < before.main.height,
        `main should shrink when the keyboard opens (before=${before.main.height}, after=${withKeyboard.main.height})`,
      );
      assert.equal(
        withKeyboard.promptInView,
        true,
        `prompt should remain visible with the keyboard open (promptBottom=${withKeyboard.promptBottom}, visibleBottom=${withKeyboard.vv.offsetTop + withKeyboard.vv.height})`,
      );
      // The buttons sit the padding-bottom clear of the keyboard, and
      // lose that padding again once it closes.
      assert.ok(
        withKeyboard.actionsGap >= BREATHING_ROOM_PX - 1 &&
          withKeyboard.actionsGap <= BREATHING_ROOM_PX + 1,
        `buttons should clear the keyboard by ${BREATHING_ROOM_PX} px, got ${withKeyboard.actionsGap}`,
      );
      // Close the keyboard: the inset must relax back to 0.
      await e2e.evaluate("window.visualViewport.__setHeight(844)");
      await new Promise((r) => setTimeout(r, 250));
      const after = await e2e.evaluate(SNAPSHOT);
      assert.equal(after.keyboardInset, 0, "inset should return to 0 when the keyboard closes");
      assert.equal(after.promptInView, true);
      assert.equal(
        after.actionsGap,
        before.actionsGap,
        `keyboard closing should restore the buttons' gap (before=${before.actionsGap}, after=${after.actionsGap})`,
      );

      // The inset is DRIVEN, not snapped: two staggered readings rehearse
      // the driver's decision paths (an interim reading that extends the
      // move, then the honest one that arrives mid-animation and is either
      // retargeted onto or dropped and corrected by the settle re-measure).
      // Either way the displayed inset must converge on the honest value
      // and never run past the interim reading's own target.
      await e2e.evaluate("window.visualViewport.__setHeight(300)");
      await new Promise((r) => setTimeout(r, 60));
      await e2e.evaluate("window.visualViewport.__setHeight(544)");
      let converged = false;
      let worst = 0;
      for (let i = 0; i < 20 && !converged; i++) {
        await new Promise((r) => setTimeout(r, 60));
        const s = await e2e.evaluate(SNAPSHOT);
        worst = Math.max(worst, s.keyboardInset);
        converged = Math.abs(s.keyboardInset - 284) <= 2;
      }
      assert.ok(
        converged,
        `inset should converge on the honest 284 px after a mid-flight reading (max seen ${worst})`,
      );
      assert.ok(
        worst <= 544,
        `inset should never run past the interim reading's target (max ${worst})`,
      );
      assert.equal(
        (await e2e.evaluate(SNAPSHOT)).promptInView,
        true,
        "prompt stays visible through the two-step keyboard move",
      );

      // Let the keyboard animation's slack (busyUntil) drain before the
      // log drag: on a slower CI runner the inset glue could still be
      // active and fight the touch driver's scrollTop writes.
      await new Promise((r) => setTimeout(r, 500));

      // The transcript is a driven, non-scrolling log (blue29/30): a touch
      // drag over it must move the text via scrollTop while the page and
      // the layout stay put, and the log must never leave its range (hard
      // ends, no rubber band). A southward drag from the pinned bottom
      // pulls toward the transcript's top; the emulated momentum then
      // coasts on and must also stop inside the range.
      const logBefore = await e2e.evaluate(SNAPSHOT);
      await touchDrag(e2e, { x: 195, y: 400, dy: 160 }); // southward: toward the top
      await new Promise((r) => setTimeout(r, 700)); // momentum settles
      const logAfter = await e2e.evaluate(SNAPSHOT);
      assert.ok(
        logAfter.screen.scrollTop < logBefore.screen.scrollTop,
        `a drag over the transcript should drive the log (before=${logBefore.screen.scrollTop}, after=${logAfter.screen.scrollTop})`,
      );
      assert.ok(
        logAfter.screen.scrollTop >= 0,
        "the log's top edge is hard (never negative)",
      );
      assert.ok(
        logAfter.screen.scrollTop <=
          logAfter.screen.scrollHeight - logAfter.screen.clientHeight,
        "the log's bottom edge is hard (never past its range)",
      );
      assert.equal(
        logAfter.doc.pageScrolls,
        false,
        "a drag over the log must not scroll the page",
      );
      assert.equal(
        logAfter.container.height,
        logBefore.container.height,
        "a drag over the log must not resize the terminal",
      );
      assert.equal(
        logAfter.keyboardInset,
        logBefore.keyboardInset,
        "a drag over the log must not move the keyboard inset",
      );

      // The gate + driver make the log's bottom a HARD END for a
      // northward drag (the "terminal not draggable north" contract,
      // blue5's failure, blue14/15's gate): dragging up at the end with
      // the keyboard open must neither move the page into WebKit's pan
      // slack nor let the log rubber-band. The driver claims the move
      // and clamps it to the end; the gate blocks the page pan.
      await e2e.evaluate(`
        const s = document.getElementById('screen');
        s.scrollTop = s.scrollHeight;
      `);
      await new Promise((r) => setTimeout(r, 50));
      const endBefore = await e2e.evaluate(SNAPSHOT);
      const roomAtEnd = endBefore.screen.scrollHeight - endBefore.screen.clientHeight;
      assert.equal(endBefore.screen.scrollTop, roomAtEnd, "log starts at its end");
      await touchDrag(e2e, { x: 195, y: 400, dy: -180 }); // northward: against the end
      await new Promise((r) => setTimeout(r, 700)); // momentum settles
      const endAfter = await e2e.evaluate(SNAPSHOT);
      assert.equal(
        endAfter.screen.scrollTop,
        roomAtEnd,
        `a northward drag at the end must hold the hard end (before=${endBefore.screen.scrollTop}, after=${endAfter.screen.scrollTop})`,
      );
      assert.equal(
        endAfter.doc.pageScrolls,
        false,
        "a northward drag over the log must not scroll the page",
      );
      assert.equal(
        endAfter.container.height,
        endBefore.container.height,
        "a northward drag over the log must not resize the terminal",
      );
      assert.equal(
        endAfter.keyboardInset,
        endBefore.keyboardInset,
        "a northward drag over the log must not move the keyboard inset",
      );

      // Regression: with the keyboard open, a background drag must not
      // resize the terminal -- a panned main reads to the inset
      // measurement as "the keyboard moved" (the phantom-resize bug).
      // The page is scrollable now (pull-to-refresh needs a range), so
      // what is left to prove is that spending it moves nothing: main is
      // sized off svh, which neither the scroll nor a retracting toolbar
      // can grow.
      await e2e.evaluate("window.visualViewport.__setHeight(544)");
      await new Promise((r) => setTimeout(r, 250));
      const beforeDrag = await e2e.evaluate(SNAPSHOT);
      // Body padding above the title: outside the terminal, on the page.
      await touchDrag(e2e, { x: 195, y: 8, dy: -220 }); // northward on the page background
      await new Promise((r) => setTimeout(r, 300));
      const afterDrag = await e2e.evaluate(SNAPSHOT);
      // Shifting by the scroll range is the gesture doing its job (and is
      // invisible at one px); anything beyond it is the bug.
      assert.ok(
        Math.abs(afterDrag.main.bottom - beforeDrag.main.bottom) <=
          Math.max(1, beforeDrag.doc.scrollRange),
        `background drag should not move the layout (before=${beforeDrag.main.bottom}, after=${afterDrag.main.bottom}, range=${beforeDrag.doc.scrollRange})`,
      );
      assert.equal(
        afterDrag.container.height,
        beforeDrag.container.height,
        `background drag should not resize the terminal (before=${beforeDrag.container.height}, after=${afterDrag.container.height})`,
      );
      assert.equal(
        afterDrag.keyboardInset,
        beforeDrag.keyboardInset,
        `background drag should not change the keyboard inset (before=${beforeDrag.keyboardInset}, after=${afterDrag.keyboardInset})`,
      );
    } finally {
      e2e.close();
    }
  },
);

// The touch shell pins main's top padding (see --pad-y in web/index.html)
// while only the height shrinks when the keyboard opens the layout. This
// rehearses exactly that on a live document: shrink the emulated viewport
// (what resizes-content does on Android when the keyboard opens) and
// require main's top edge to stay put -- the "same padding open or closed"
// contract. The geometries deliberately cross the old 500px line: any
// height-keyed rule would flip true mid-open and move main's top with it,
// which is the jump this test guards against.
test(
  "touch shell keeps the same top padding across viewport heights",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    const e2e = await startChromeE2E({
      chrome: CHROME,
      port: port + 2,
      serve: "web",
      debugPort: 9850 + (process.pid % 200),
      profilePrefix: "oregon-fortran-shell-profile",
    });
    try {
      await e2e.send("Page.enable");
      await e2e.send("Runtime.enable");
      const TOP_PROBE = `(() => {
        const main = document.querySelector('main');
        const b = main.getBoundingClientRect();
        const cs = getComputedStyle(main);
        return {
          rectTop: Math.round(b.top * 100) / 100,
          position: cs.position,
          padY: cs.getPropertyValue('--pad-y').trim(),
        };
      })()`;
      // The case that matters is the one that CROSSES the 500px mark: any
      // height-keyed rule flips true mid-open and main's top moves with
      // it. Geometries that stay on one side of the threshold never
      // exercised that, which is why the jump shipped.
      const geometries = [
        { name: "phone portrait", width: 390, tall: 844, short: 600 },
        { name: "huge phone, tall keyboard", width: 412, tall: 915, short: 495 },
        { name: "tablet landscape", width: 1280, tall: 800, short: 400 },
      ];
      for (const g of geometries) {
        await e2e.send("Emulation.setDeviceMetricsOverride", {
          width: g.width,
          height: g.tall,
          deviceScaleFactor: 2,
          mobile: true,
        });
        await e2e.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
        await e2e.send("Page.navigate", {
          url: `http://localhost:${port + 2}/`,
        });
        assert.ok(
          await waitUntil(async () => {
            try {
              return await e2e.evaluate("!!document.querySelector('main')");
            } catch {
              return false;
            }
          }, 60, 150),
          `${g.name}: page loaded`,
        );
        await new Promise((r) => setTimeout(r, 400));
        const tall = await e2e.evaluate(TOP_PROBE);
        assert.equal(
          tall.position,
          "fixed",
          `${g.name}: touch shell must pin main (got ${tall.position})`,
        );
        // Shrink live, without reload: this is the keyboard opening under
        // resizes-content -- layout and visual viewports shrink together.
        await e2e.send("Emulation.setDeviceMetricsOverride", {
          width: g.width,
          height: g.short,
          deviceScaleFactor: 2,
          mobile: true,
        });
        await new Promise((r) => setTimeout(r, 500));
        const short = await e2e.evaluate(TOP_PROBE);
        assert.ok(
          Math.abs(short.rectTop - tall.rectTop) <= 1,
          `${g.name}: same top padding open or closed (tall=${tall.rectTop}, short=${short.rectTop})`,
        );
        assert.equal(
          short.padY,
          tall.padY,
          `${g.name}: --pad-y must not retune (tall=${tall.padY}, short=${short.padY})`,
        );
      }
    } finally {
      e2e.close();
    }
  },
);
