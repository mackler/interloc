import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Finding 7 of docs/gui-review.md, decision Q3: the layout adapts. At M3's expanded width (840 px and wider) the rail
// and both panels are side by side; below it, one panel at a time, chosen by its title, with a badge for the other's
// new messages, and a prompt selects "You and plan-review". The "tabs" server asks two decisions in a row.
const URL = "http://127.0.0.1:8106/";
const LEFT = "You and plan-review";
const RIGHT = "Claude Code and Codex";
const panel = (page: Page, name: string) => page.getByRole("region", { name });
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("the element is not visible");
  return b;
};
const startTask = async (page: Page, task: string) => {
  await page.goto(URL);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  // The form, an ended run, or a run left by an earlier test on the shared server, which is stopped first.
  await expect(page.locator("textarea[name=task], button[name=new], button[name=stop]:not([disabled])").first()).toBeVisible();
  const stop = page.locator("button[name=stop]");
  const again = page.locator("button[name=new]");
  if (await stop.isEnabled()) {
    await stop.click();
    await again.click();
  } else if (await again.isVisible()) await again.click();
  await page.locator("textarea[name=task]").fill(task);
  await page.locator("button[name=start]").click();
};
const FIRST = "Decision on: question from Claude Code: Which database should the service use?";
const SECOND = "Decision on: question from Claude Code: Which cache should the service use?";

/** The assertions of a compact window: no horizontal overflow, a usable panel and answer field, the panel switch. */
const compactChecks = async (page: Page, context: import("@playwright/test").BrowserContext, minHeight: number) => {
  await startTask(page, "Add a database in a narrow window");
  await expect(panel(page, LEFT).getByText(FIRST)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
  const left = await box(panel(page, LEFT));
  expect(left.width, "the panel's width").toBeGreaterThanOrEqual(300);
  expect(left.height, "the panel's height").toBeGreaterThanOrEqual(minHeight);
  expect((await box(page.locator("[name=answer]"))).width, "the answer field's width").toBeGreaterThanOrEqual(280);
  await expect(panel(page, RIGHT)).toBeHidden();

  // The other panel by its title; a prompt brings "You and plan-review" back.
  await page.getByRole("button", { name: new RegExp(RIGHT) }).click();
  await expect(panel(page, RIGHT)).toBeVisible();
  await expect(panel(page, LEFT)).toBeHidden();
  const other = await context.newPage();
  await other.goto(URL);
  await other.getByRole("button", { name: "No decision" }).click();
  await expect(panel(page, LEFT).getByText(SECOND)).toBeVisible();
  await expect(panel(page, RIGHT)).toBeHidden();

  // Messages that arrive in the hidden panel are counted on its button.
  await other.getByRole("button", { name: "No decision" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`${RIGHT}.*[1-9][0-9]* new`) })).toBeVisible();
  await expect(panel(page, LEFT).getByText(/finished after 1 execution phase/)).toBeVisible();
  await other.close();
};

test("(L1) a phone-sized window, 390 × 844: one usable panel at a time, no horizontal overflow", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await compactChecks(page, context, 400);
});

test("(L2) a desktop window at 200 % zoom (a 640 × 400 CSS viewport): the same, with a smaller height", async ({ page, context }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  await compactChecks(page, context, 200);
});

test("(L3) a desktop window, 1280 × 800: the rail and both panels side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startTask(page, "Add a database in a wide window");
  await expect(panel(page, LEFT).getByText(FIRST)).toBeVisible();
  const rail = await box(page.getByRole("navigation", { name: "Progress of the run" }));
  const left = await box(panel(page, LEFT));
  const right = await box(panel(page, RIGHT));
  expect(rail.x + rail.width).toBeLessThanOrEqual(left.x);
  expect(left.x + left.width).toBeLessThanOrEqual(right.x);
  await expect(page.getByRole("button", { name: new RegExp(RIGHT) })).toHaveCount(0);
  await page.getByRole("button", { name: "No decision" }).click();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(panel(page, LEFT).getByText(/finished after 1 execution phase/)).toBeVisible();
});
