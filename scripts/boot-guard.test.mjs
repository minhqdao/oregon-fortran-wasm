// Boot-phase guard tests: the inline script in web/index.html is the only
// thing that can observe module-load failures, because launcher.js has not
// run when they happen. These scenarios load the real index.html in jsdom
// (with scripts enabled) and drive the guard's three nets:
//
//   1. module instantiation errors (message-bearing) trigger one guarded
//      recovery reload, then a visible diagnosis on the retry;
//   2. message-less fetch failures get the same single guarded reload
//      (transient blips usually clear on retry), then visible text;
//      non-script resource errors (favicons, images) are ignored;
//   3. unhandled promise rejections fold into the same reload-then-report
//      path;
//   4. the watchdog reports a terminal stuck on LOADING... after 20 s;
//   5. the guard disarms itself once the game produces first output, so
//      boot errors never misfire later in the session.
//
// jsdom lives in a scratch node_modules (see scripts/browser-smoke.sh); the
// test skips gracefully when it has not been installed.
//
//   node --test scripts/boot-guard.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

function resolveJSDOM() {
  const scratch = process.env.SMOKE_NODE_MODULES;
  if (!scratch) return null;
  try {
    return require(join(scratch, "jsdom"));
  } catch {
    return null;
  }
}

const jsdomModule = resolveJSDOM();
const JSDOM = jsdomModule?.JSDOM;
const VirtualConsole = jsdomModule?.VirtualConsole;

if (!JSDOM) {
  console.warn(
    "boot-guard.test.mjs skipped: run scripts/browser-smoke.sh (installs jsdom into a scratch cache directory)",
  );
  test("jsdom scratch install missing", { skip: true }, () => {});
}

if (JSDOM) {
  const indexUrl = new URL("../web/index.html", import.meta.url);
  const html = readFileSync(indexUrl, "utf8");

  /**
   * Loads index.html with the inline boot guard executing and nothing else.
   * runScripts: "dangerously" runs the guard's own <script> block; the
   * module <script> is inert in jsdom, which is exactly the pre-launcher
   * window the guard exists for.
   *
   * jsdom's location.reload() is read-only and "not implemented", but each
   * call surfaces on the virtual console's jsdomError channel; that is how
   * reloads are counted. Timers the guard schedules are captured through
   * beforeParse so the watchdog can be expired deterministically.
   */
  async function openBootPage() {
    const reloads = [];
    const timers = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => {
      if (/Not implemented: navigation/.test(error.message ?? "")) {
        reloads.push("reload");
      }
    });
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      pretendToBeVisual: true,
      runScripts: "dangerously",
      virtualConsole,
      beforeParse(window) {
        const originalSetTimeout = window.setTimeout;
        window.setTimeout = (fn, ms, ...rest) => {
          timers.push({ fn, ms });
          return originalSetTimeout(fn, ms, ...rest);
        };
      },
    });
    const { window } = dom;

    return {
      window,
      reloads,
      timers,
      status: () => window.document.getElementById("status"),
      output: () => window.document.getElementById("output"),
      waitFor: async (predicate, attempts = 50) => {
        for (let i = 0; i < attempts; i++) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return predicate();
      },
      fireError: (props) => {
        const event = Object.assign(new window.Event("error"), props);
        window.dispatchEvent(event);
      },
      fireResourceError: (tagName) => {
        // Resource load failures carry the failed element as target and
        // reach the window listener via capture. Dispatching on the element
        // itself reproduces that (target = element, empty message).
        const el = window.document.createElement(tagName);
        window.document.body.appendChild(el);
        const event = new window.Event("error");
        el.dispatchEvent(event);
        el.remove();
      },
      fireRejection: (reason) => {
        const event = Object.assign(
          new window.Event("unhandledrejection"),
          { reason },
        );
        // jsdom's Event lacks preventDefault wiring for this synthetic
        // type; the guard try/catches it, so a no-op suffices here.
        event.preventDefault = () => {};
        window.dispatchEvent(event);
      },
    };
  }

  test("module instantiation error reloads once, then reports", async () => {
    const page = await openBootPage();
    page.fireError({
      message:
        "SyntaxError: Importing binding name 'terminalActiveLineOverlap' is not found.",
    });
    assert.equal(
      page.reloads.length,
      1,
      "first module error triggers exactly one recovery reload",
    );
    assert.equal(
      page.status().textContent,
      "",
      "no error text shown while the recovery reload is pending",
    );

    // The reload is not real in jsdom: simulate the retried load by
    // marking the session as one that already reloaded, then firing
    // again as that session would experience it.
    page.window.sessionStorage.setItem("oregon-module-reload", "1");
    page.fireError({
      message: "SyntaxError: Importing binding name 'x' is not found.",
    });
    assert.equal(page.reloads.length, 1, "a second reload is never issued");
    assert.match(
      page.status().textContent,
      /Failed to load: .*hard reload/,
      "persistent module error surfaces as visible status text",
    );
    assert.equal(page.status().hidden, false);
  });

  test("message-less load failure reloads once, then reports", async () => {
    const page = await openBootPage();
    // Fetch-type failures (404, network, transient blip) fire error events
    // with no message; the first gets the same guarded reload as a module
    // skew error, since a retry usually clears a blip.
    page.fireError({});
    assert.equal(
      page.reloads.length,
      1,
      "first message-less failure triggers exactly one recovery reload",
    );
    assert.equal(
      page.status().textContent,
      "",
      "no error text shown while the recovery reload is pending",
    );

    // Simulate the retried load: the guard already spent its one reload,
    // so a persistent failure now surfaces as text instead of looping.
    page.window.sessionStorage.setItem("oregon-module-reload", "1");
    page.fireError({});
    assert.equal(page.reloads.length, 1, "a second reload is never issued");
    assert.match(
      page.status().textContent,
      /failed to load.*Reload the page to retry/,
      "persistent load failure surfaces as actionable text",
    );
    assert.equal(page.status().hidden, false);
  });

  test("non-script resource errors are ignored", async () => {
    const page = await openBootPage();
    // Favicons, images and fonts fire the identical capture-phase error
    // event; they cannot fail the boot and must not trip the guard.
    page.fireResourceError("img");
    page.fireResourceError("link");
    assert.equal(
      page.reloads.length,
      0,
      "favicon/image failures must not trigger a recovery reload",
    );
    assert.equal(
      page.status().textContent,
      "",
      "favicon/image failures must not write boot status",
    );
    assert.equal(page.status().hidden, true);
  });

  test("unhandled rejection reloads once, then reports", async () => {
    const page = await openBootPage();
    page.fireRejection(
      new page.window.Error(
        "SyntaxError: Importing binding name 'x' is not found.",
      ),
    );
    assert.equal(
      page.reloads.length,
      1,
      "first rejection triggers exactly one recovery reload",
    );
    assert.equal(
      page.status().textContent,
      "",
      "no error text shown while the recovery reload is pending",
    );

    page.window.sessionStorage.setItem("oregon-module-reload", "1");
    page.fireRejection(new page.window.Error("boom"));
    assert.equal(page.reloads.length, 1, "a second reload is never issued");
    assert.match(
      page.status().textContent,
      /Failed to load: boom.*hard reload/,
      "persistent rejection surfaces as visible status text",
    );
  });

  test("message-less rejection reloads once, then reports", async () => {
    const page = await openBootPage();
    page.fireRejection(undefined);
    assert.equal(
      page.reloads.length,
      1,
      "first message-less rejection triggers a recovery reload",
    );
    page.window.sessionStorage.setItem("oregon-module-reload", "1");
    page.fireRejection(undefined);
    assert.match(
      page.status().textContent,
      /failed to load.*Reload the page to retry/,
      "persistent message-less rejection surfaces as actionable text",
    );
  });

  test("watchdog reports a terminal stuck on LOADING...", async () => {
    const page = await openBootPage();
    const watchdog = page.timers.find((t) => t.ms === 20_000);
    assert.ok(watchdog, "guard registers a 20s watchdog timer");
    // Expire it deterministically instead of waiting 20 wall-clock seconds.
    watchdog.fn();
    assert.match(
      page.status().textContent,
      /Still loading after 20 seconds/,
      "stuck boot shows the watchdog hint",
    );
    assert.equal(page.status().hidden, false);
  });

  test("watchdog fires while the launcher shows its own LOADING line", async () => {
    const page = await openBootPage();
    // The launcher painted its initial "LOADING...\n" (trailing newline,
    // unlike the static HTML) but the worker never delivered game output:
    // the common stall. The guard must compare trimmed text, or this state
    // would slip past silently.
    page.output().textContent = "LOADING...\n";
    const watchdog = page.timers.find((t) => t.ms === 20_000);
    assert.ok(watchdog, "watchdog is registered");
    watchdog.fn();
    assert.match(
      page.status().textContent,
      /Still loading after 20 seconds/,
      "stall before the first game output surfaces via the watchdog",
    );
  });

  test("first game output disarms the guard", async () => {
    const page = await openBootPage();
    // Simulate the launcher handshake: boot done + first output replaced.
    page.window.document.documentElement.dataset.oregonBootDone = "1";
    page.output().textContent = "HOW GOOD A SHOT ARE YOU WITH YOUR RIFLE?";
    page.fireError({ message: "late, harmless module error" });
    const watchdog = page.timers.find((t) => t.ms === 20_000);
    assert.ok(watchdog, "watchdog is registered");
    watchdog.fn();
    assert.equal(page.reloads.length, 0, "disarmed guard never reloads");
    assert.equal(
      page.status().textContent,
      "",
      "disarmed guard writes no status for post-boot errors",
    );
  });

  test("watchdog stays silent when the game already produced output", async () => {
    const page = await openBootPage();
    page.window.document.documentElement.dataset.oregonBootDone = "1";
    page.output().textContent = "HOW GOOD A SHOT ARE YOU WITH YOUR RIFLE?";
    const watchdog = page.timers.find((t) => t.ms === 20_000);
    assert.ok(watchdog, "watchdog is registered");
    watchdog.fn();
    assert.equal(
      page.status().textContent,
      "",
      "watchdog must not fire once output replaced the loading line",
    );
    assert.equal(page.status().hidden, true);
  });
}
