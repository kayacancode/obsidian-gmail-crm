// Run against npm run preview:intelligence. Point PLAYWRIGHT_MODULE to a local
// Playwright installation when it is not installed in this repository.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
import assert from "node:assert/strict";
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:4178");
await page.getByRole("heading", { name: "Your people, in context." }).waitFor();
await page.screenshot({ path: "/tmp/pi-attention.png", fullPage: true });
await page.getByRole("button", { name: "View Maya Chen", exact: true }).click();
await page.getByRole("heading", { name: "Maya Chen", exact: true }).waitFor();
await page.getByRole("button", { name: "★ Important", exact: true }).click();
await page.getByRole("button", { name: "Timeline", exact: true }).click();
assert.equal(await page.locator(".pi-timeline tbody tr").count(), 8);
await page.locator(".pi-heat-1").first().click();
await page.getByRole("heading", { name: /Week of/ }).waitFor();
await page.screenshot({ path: "/tmp/pi-timeline.png", fullPage: true });
await page.getByRole("button", { name: "Goals", exact: true }).click();
assert.equal(await page.locator(".pi-matrix tbody tr").count(), 8);
await page.locator(".pi-match-strong").first().click();
assert.ok(
  (await page
    .getByRole("button", { name: "Open source note", exact: true })
    .count()) > 0,
);
await page
  .getByRole("button", { name: "Open source note", exact: true })
  .last()
  .click();
assert.match(
  await page.locator("#source-status").textContent(),
  /Opened demo source/,
);
await page.locator("summary").click();
await page.getByLabel("Goal name", { exact: true }).fill("Security research");
await page
  .getByLabel("Keywords or phrases, separated by commas")
  .fill("security, privacy");
await page.getByRole("button", { name: "Add goal", exact: true }).click();
await page.getByRole("columnheader", { name: "Security research" }).waitFor();
await page.reload();
await page.getByRole("button", { name: "Goals", exact: true }).click();
await page.getByRole("columnheader", { name: "Security research" }).waitFor();
await page.getByRole("button", { name: "Paths", exact: true }).click();
await page.getByLabel("Focus person").selectOption("person0@example.com");
assert.equal(await page.locator(".pi-path").count(), 2);
await page.getByRole("button", { name: "Graph", exact: true }).click();
assert.equal(await page.locator("svg .pi-node").count(), 3);
await page.getByLabel("Search people").fill("Alex");
await page.getByRole("heading", { name: "Alex Rivera", exact: true }).waitFor();
await page.getByRole("button", { name: "Reset filters", exact: true }).click();
await page.getByLabel("Focus person").selectOption("person0@example.com");
await page
  .getByRole("button", { name: "Focus Alex Rivera", exact: true })
  .click();
await page.getByRole("heading", { name: "Alex Rivera", exact: true }).waitFor();
await page.screenshot({ path: "/tmp/pi-graph.png", fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole("button", { name: "Timeline", exact: true }).click();
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.screenshot({ path: "/tmp/pi-mobile.png", fullPage: true });
await page.goto("http://127.0.0.1:4178?calendarOnly=1");
await page.getByRole("button", { name: "Timeline", exact: true }).click();
assert.match(await page.locator(".pi-notice").textContent(), /Imported interaction history is available/);
await page.goto("http://127.0.0.1:4178?empty=1");
await page.getByText("No matching people.", { exact: false }).waitFor();
assert.equal(errors.length, 0, errors.join("\n"));
console.log(
  "Browser checks passed: all five views, timeline evidence, goal persistence, source links, feedback, graph selection, filter/detail consistency, narrow layout, empty index, no runtime errors.",
);
await browser.close();
