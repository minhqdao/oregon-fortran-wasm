// Oregon Trail regression suite.
//
// Runs scripted game sessions through the WebAssembly build (the same
// runner.worker.js the browser uses) and asserts on the transcript. When
// gfortran is available it also runs every session through a native build
// and requires byte-identical (normalized) output, catching compiler-level
// divergences without hand-writing every expected line.
//
// The game seeds its RNG from the wall clock (OREGON_SRAND(OREGON_TIME())),
// so unlike the fixed-seed Adventure port, parity is only meaningful while
// the RNG is unused. Every session here therefore ends with STOP during the
// deterministic setup phase (before the first turn resolves hunt results,
// weather, or breakdowns); assertions cover exactly that stretch.
//
// Usage:
//   node scripts/run-tests.mjs              # run everything
//   node scripts/run-tests.mjs outfitting   # only tests whose name matches
//   node scripts/run-tests.mjs --no-parity  # skip the native build/compare
//   node scripts/run-tests.mjs --native-only# skip wasm, test a native binary
//   node scripts/run-tests.mjs --show       # print output of failing tests
//
// Environment:
//   OREGON_NATIVE=path   use this prebuilt binary instead of compiling one
//                        with gfortran (for CI matrix jobs that each built
//                        the game with a different compiler).

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNative, runWasm, normalize } from "./game-driver.mjs";
import {
  createKeysBuffer,
  maxInputLength,
  readInputLine,
  writeInputLine,
} from "../web/runner-protocol.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const wasmPath = `${root}web/oregon.js`;
const nativeBinary = `${root}build/oregon-native`;
const sources = [`${root}src/oregon.f`, `${root}src/oregon_time.f`];

const STOP_LINE = 'TYPE "STOP" AT ANY TIME TO QUIT.';
const INSTRUCTIONS_PROMPT = "DO YOU NEED INSTRUCTIONS? (Y/N)";
const SKILL_MENU = "HOW GOOD A SHOT ARE YOU WITH YOUR RIFLE?";
const SKILL_TAIL =
  "ENTER ONE OF THE ABOVE -- THE BETTER YOU CLAIM YOU ARE, " +
  "THE FASTER YOU'LL HAVE TO BE WITH YOUR GUN TO BE SUCCESSFUL.";
const OXEN_PROMPT = "HOW MUCH DO YOU WANT TO SPEND ON YOUR OXEN TEAM?";
const FOOD_PROMPT = "HOW MUCH DO YOU WANT TO SPEND ON FOOD?";
const FIRST_TURN_HEADER = "MONDAY, MARCH 29 1847";
const FORT_MENU = "(1) STOP AT THE NEXT FORT, (2) HUNT, (3) CONTINUE";
const INSTRUCTIONS_BODY = "AMMUNITION - $1 BUYS A BELT OF 50 BULLETS.";

const tests = [
  // --- stop prompt ----------------------------------------------------
  {
    // A STOP before any game state exists ends the session immediately:
    // the opening banner prints and the instructions question quits.
    name: "stop-immediately",
    input: ["STOP"],
    expect: [STOP_LINE, INSTRUCTIONS_PROMPT],
    forbid: [SKILL_MENU],
  },
  {
    // STOP at the skill question quits after the menu has printed.
    name: "stop-at-skill-question",
    input: ["N", "STOP"],
    expect: [STOP_LINE, SKILL_MENU, SKILL_TAIL],
    forbid: [INSTRUCTIONS_BODY],
  },

  // --- instructions prompt ---------------------------------------------
  {
    name: "instructions-no",
    input: ["N", "3", "STOP"],
    expect: [SKILL_MENU],
    forbid: [INSTRUCTIONS_BODY, "INVALID", "TOO HIGH"],
  },
  {
    name: "instructions-lowercase-no",
    input: ["n", "STOP"],
    expect: [SKILL_MENU],
    forbid: [INSTRUCTIONS_BODY, "INVALID"],
  },
  {
    // The instruction text spans four pages with three "PRESS RETURN KEY."
    // pauses; any keystroke carries the pause. The STOP then quits at the
    // skill question like everywhere else.
    name: "instructions-yes",
    input: ["Y", ".", ".", ".", "STOP"],
    expect: [
      "5-6 MONTHS -- IF YOU MAKE IT ALIVE",
      INSTRUCTIONS_BODY,
      "PRESS RETURN KEY.",
      "HOW GOOD A SHOT ARE YOU WITH YOUR RIFLE?",
    ],
    forbid: ["INVALID"],
    counts: [[/PRESS RETURN KEY\./g, 3]],
  },

  // --- skill input validation ------------------------------------------
  {
    // Out-of-range skill is rejected with TOO HIGH; the next read is the
    // skill answer again (the menu is never re-printed).
    name: "skill-too-high-recovered",
    input: ["N", "9", "3", "STOP"],
    expect: [SKILL_TAIL, "TOO HIGH", "YOU HAVE 700 DOLLARS LEFT", OXEN_PROMPT],
    forbid: ["INVALID"],
  },
  {
    // Empty lines at the skill question count as INVALID but keep the
    // session alive: the next valid answer proceeds normally.
    name: "blank-input-invalid-but-recovers",
    input: ["N", "", "", "3", "STOP"],
    expect: [SKILL_TAIL, "INVALID", "INVALID", "YOU HAVE 700 DOLLARS LEFT"],
    forbid: ["TOO HIGH"],
  },

  // --- purchasing --------------------------------------------------------
  {
    // The complete deterministic purchase flow: each expense deducts from
    // $700, the totals line up exactly, and the first turn header, status
    // block and fort menu print before the STOP.
    name: "outfitting",
    input: ["N", "3", "200", "100", "50", "50", "50", "STOP"],
    expect: [
      "YOU HAVE 700 DOLLARS LEFT",
      OXEN_PROMPT,
      "YOU NOW HAVE 500 DOLLARS LEFT",
      FOOD_PROMPT,
      "YOU NOW HAVE 400 DOLLARS LEFT",
      "HOW MUCH DO YOU WANT TO SPEND ON AMMUNITION?",
      "YOU NOW HAVE 350 DOLLARS LEFT",
      "HOW MUCH DO YOU WANT TO SPEND ON CLOTHING?",
      "YOU NOW HAVE 300 DOLLARS LEFT",
      "HOW MUCH DO YOU WANT TO SPEND ON MISCELLANEOUS SUPPLIES?",
      "AFTER ALL YOUR PURCHASES, YOU NOW HAVE 250 DOLLARS LEFT",
      FIRST_TURN_HEADER,
      "TOTAL MILEAGE IS 0",
      "FOOD BULLETS CLOTHING MISC.SUPP. CASH",
      "100 2500 50 50 250",
      FORT_MENU,
    ],
    forbid: ["INVALID", "TOO HIGH"],
  },
  {
    // Overspending triggers TOO HIGH and the very next line is re-read as
    // the answer for the same expense (no repeated question).
    name: "overspend-recovered",
    input: ["N", "3", "1000", "200", "STOP"],
    expect: ["YOU HAVE 700 DOLLARS LEFT", OXEN_PROMPT, "TOO HIGH", "YOU NOW HAVE 500 DOLLARS LEFT", FOOD_PROMPT],
    forbid: ["INVALID"],
  },
  {
    // The instructions spell out the oxen band ($200-$300): both boundary
    // rejections are followed by a re-read, and the third answer lands in
    // range for the same question.
    name: "oxen-amount-bounds",
    input: ["N", "3", "350", "40", "200", "STOP"],
    expect: [
      OXEN_PROMPT,
      "TOO HIGH",
      "TOO LOW",
      "YOU NOW HAVE 500 DOLLARS LEFT",
      FOOD_PROMPT,
    ],
    forbid: ["INVALID"],
  },
];

// --- runner ------------------------------------------------------------------------

const args = process.argv.slice(2);
const showOutput = args.includes("--show");
const noParity = args.includes("--no-parity");
const nativeOnly = args.includes("--native-only");
const filter = args.find((arg) => !arg.startsWith("--"));

const envBinary = process.env.OREGON_NATIVE;
if (envBinary) {
  try {
    statSync(envBinary);
  } catch {
    console.error(`OREGON_NATIVE binary not found: ${envBinary}`);
    process.exit(2);
  }
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

// Returns the native binary path to use, or null when no native backend is
// available (gfortran missing and no OREGON_NATIVE override).
function resolveNativeBinary() {
  if (envBinary) return envBinary;

  const gfortran = spawnSync("gfortran", ["--version"], { encoding: "utf8" });
  if (gfortran.status !== 0) return null;

  let needsBuild = true;
  try {
    const binaryTime = statSync(nativeBinary).mtimeMs;
    needsBuild = sources.some((path) => statSync(path).mtimeMs > binaryTime);
  } catch {
    needsBuild = true;
  }

  if (needsBuild) {
    const build = spawnSync(
      "gfortran",
      [...sources, "-o", nativeBinary],
      { cwd: root, encoding: "utf8" },
    );
    if (build.status !== 0) {
      console.error(`gfortran failed:\n${build.stderr}`);
      process.exit(1);
    }
  }
  return nativeBinary;
}

function assertOutput(test, out) {
  const problems = [];
  const flow = collapse(out);

  let cursor = 0;
  for (const item of test.expect ?? []) {
    const needle = collapse(item);
    const index = flow.indexOf(needle, cursor);
    if (index === -1) {
      problems.push(`missing expected text: "${needle}"`);
    } else {
      cursor = index + needle.length;
    }
  }
  for (const item of test.forbid ?? []) {
    const needle = collapse(item);
    if (flow.includes(needle)) problems.push(`forbidden text present: "${needle}"`);
  }
  for (const [pattern, expected] of test.counts ?? []) {
    const actual = (out.match(pattern) || []).length;
    if (actual !== expected) {
      problems.push(`count of ${pattern} = ${actual}, expected ${expected}`);
    }
  }
  return problems;
}

// All sessions end with STOP, so a clean exit is part of the assertion: a
// run that was cut off by the timeout mask cannot be compared for parity.
function assertCleanRun(label, result, problems) {
  if (result.timedOut) problems.push(`${label} run timed out`);
  else if (result.exitCode !== 0) {
    problems.push(`${label} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
}

function firstDifference(a, b) {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const limit = Math.max(linesA.length, linesB.length);
  for (let index = 0; index < limit; index++) {
    if (linesA[index] !== linesB[index]) {
      const context = [];
      for (let offset = Math.max(0, index - 1); offset <= Math.min(limit - 1, index + 1); offset++) {
        context.push(`  wasm:   ${JSON.stringify(linesA[offset] ?? "<end>")}`);
        context.push(`  native: ${JSON.stringify(linesB[offset] ?? "<end>")}`);
      }
      return `first divergence at output line ${index + 1}:\n${context.join("\n")}`;
    }
  }
  return "";
}

const nativeBinaryPath = resolveNativeBinary();
const runNativeSide = nativeOnly
  ? nativeBinaryPath !== null
  : nativeBinaryPath !== null && !noParity;

if (nativeOnly && !nativeBinaryPath) {
  console.error("--native-only requires gfortran or OREGON_NATIVE");
  process.exit(2);
}
if (!nativeOnly && !runNativeSide) {
  console.log("-- native parity disabled (gfortran not found or --no-parity) --");
}

const protocolName = "protocol-input-buffer-invariants";
const runProtocol = !filter || protocolName.includes(filter);

let selected = tests.filter((test) => !test.skip);
if (filter) selected = selected.filter((test) => test.name.includes(filter));
if (selected.length === 0 && !runProtocol) {
  console.error(`no tests match "${filter ?? ""}"`);
  process.exit(2);
}

let passed = 0;
const failures = [];

// Fast synchronous invariant checks on the shared input-buffer protocol, run
// before any game session. The buffer that carries a submitted line must be
// large enough for a maximum-length line plus its newline: a max line is
// `maxInputLength` chars + '\n' written at offset 2, so the earlier bug (the
// trailing byte landing one index past a fixed 256-byte buffer) can never
// silently drop a newline again.
function protocolInvariants() {
  const problems = [];
  const view = new Uint8Array(createKeysBuffer());

  const roundTrip = (text) => {
    writeInputLine(view, text);
    const readBack = readInputLine(view);
    if (readBack !== text) {
      problems.push(
        `round trip lost data: wrote ${JSON.stringify(text)}, read ${JSON.stringify(readBack)}`,
      );
    }
  };

  // A zero-length write is the wire signal for EOF, read back as null.
  writeInputLine(view, "");
  if (readInputLine(view) !== null) {
    problems.push("a zero-length write should read back as EOF (null)");
  }
  roundTrip("\n");
  roundTrip("X".repeat(maxInputLength) + "\n");

  const maxLength = "X".repeat(maxInputLength + 1) + "\n";
  try {
    writeInputLine(view, maxLength);
    problems.push(`a ${maxLength.length}-char line should not fit the keys buffer`);
  } catch (error) {
    if (!(error instanceof RangeError)) problems.push(`overflow threw ${error}`);
  }
  return problems;
}

if (runProtocol) {
  const problems = protocolInvariants();
  if (problems.length === 0) {
    passed++;
    console.log(`PASS ${protocolName}`);
  } else {
    failures.push(protocolName);
    console.log(`FAIL ${protocolName}`);
    for (const problem of problems) console.log(`     ${problem}`);
  }
}

for (const test of selected) {
  const problems = [];
  let wasmOut = null;
  let wasmTimedOut = false;

  if (!nativeOnly) {
    const wasm = await runWasm(wasmPath, test.input, { timeoutMs: 15_000 });
    wasmOut = normalize(wasm.output);
    wasmTimedOut = wasm.timedOut;
    assertCleanRun("wasm", wasm, problems);
    problems.push(...assertOutput(test, wasmOut));
  }

  let nativeOut = null;
  if (runNativeSide) {
    const native = await runNative(nativeBinaryPath, test.input, {
      cwd: root,
      timeoutMs: 15_000,
    });
    nativeOut = normalize(native.output);
    assertCleanRun("native", native, problems);
    problems.push(
      ...assertOutput(test, nativeOut).map((p) => (nativeOnly ? p : `native: ${p}`)),
    );
    if (!nativeOnly && !wasmTimedOut && !native.timedOut && wasmOut !== nativeOut) {
      problems.push(`wasm and native output diverge\n${firstDifference(wasmOut, nativeOut)}`);
    }
  }

  if (problems.length === 0) {
    passed++;
    console.log(`PASS ${test.name}`);
  } else {
    failures.push(test.name);
    console.log(`FAIL ${test.name}`);
    for (const problem of problems) console.log(`     ${problem.split("\n").join("\n     ")}`);
    if (showOutput) {
      const toShow = wasmOut ?? nativeOut ?? "";
      console.log("     --- captured output ---");
      console.log(toShow.split("\n").map((l) => `     ${l}`).join("\n"));
    }
  }
}

console.log(`\n${passed}/${selected.length + (runProtocol ? 1 : 0)} tests passed` +
  (failures.length ? `; failures: ${failures.join(", ")}` : ""));
process.exit(failures.length ? 1 : 0);
