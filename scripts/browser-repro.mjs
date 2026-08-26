// Throwaway reproduction: load the real page in Chromium, wait for the game
// prompt, type an answer, press Enter, and dump everything observed.
import { chromium } from "../Basicade/node_modules/playwright-core/index.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:8123";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (message) =>
  console.log(`[console:${message.type()}] ${message.text()}`),
);
page.on("pageerror", (error) => console.log(`[pageerror] ${error}`));

await page.goto(baseUrl, { waitUntil: "load" });
console.log(`crossOriginIsolated = ${await page.evaluate(() => window.crossOriginIsolated)}`);

// Wait until the game prints the instructions question.
try {
  await page.waitForFunction(
    () =>
      document.getElementById("output")?.textContent.includes(
        "DO YOU NEED INSTRUCTIONS",
      ),
    { timeout: 20000 },
  );
  console.log("[ok] instructions question is visible");
} catch {
  console.log(
    `[timeout] output so far:\n${await page
      .getElementById("output")
      .then((el) => el?.textContent())
      .catch(() => "<element missing>")}`,
  );
}

await page.click("#terminal-container");
// Play through the opening sequence like the CI smoke test.
const answers = ["N", "3", "200", "100", "50", "50", "50", "2"];
for (const answer of answers) {
  await page.waitForTimeout(700);
  await page.keyboard.type(answer);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(4000);

const output = await page.evaluate(() => document.getElementById("output").textContent);
console.log("---- terminal tail ----");
console.log(output.slice(-1200));
console.log("status:", await page.evaluate(() => document.getElementById("status").textContent));
console.log(
  "reached game turn:",
  output.includes("TOTAL MILEAGE IS") || output.includes("DO YOU WANT TO"),
);

await browser.close();
