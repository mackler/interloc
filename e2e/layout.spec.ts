import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Finding 7 of docs/gui-review.md, decision Q3: the layout adapts. At M3's expanded width (840 px and wider) the rail
// and both panels are side by side; below it, one panel at a time, chosen by its title, with a badge for the other's
// new messages, and a prompt selects "You and Interloq". The "tabs" server asks two decisions in a row.
const URL = "http://127.0.0.1:8106/";
const LEFT = "You and Interloq";
const RIGHT = "Claude Code and Codex";
const panel = (page: Page, name: string) => page.getByRole("region", { name });
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("the element is not visible");
  return b;
};
const startTask = async (page: Page, task: string, url = URL) => {
  await page.goto(url);
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

  // The other panel by its title; a prompt brings "You and Interloq" back.
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

// W2-R1-3 and P3-R1-1 (work review 2 and planning 3): a panel keeps its reading position across a switch and a resize,
// and a panel that was hidden follows its end when it is shown again, unless the user had scrolled it up.
const LONG_URL = "http://127.0.0.1:8108/";
const list = (page: Page, name: string) => panel(page, name).locator(".list");
const fromEnd = (l: Locator) => l.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const toTop = (l: Locator) =>
  l.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
const showPanel = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
const longRunAtItsPrompt = async (page: Page, task: string) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await startTask(page, task, LONG_URL);
  await expect(page.getByRole("button", { name: "No decision" })).toBeVisible({ timeout: 30_000 });
};

test("(L4) a panel's reading position survives a switch of panels and a resize across 840 px", async ({ page }) => {
  await longRunAtItsPrompt(page, "Keep my place");
  await toTop(list(page, LEFT));
  await showPanel(page, RIGHT);
  await showPanel(page, LEFT);
  expect(await list(page, LEFT).evaluate((el) => el.scrollTop), "after a switch").toBe(0);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await list(page, LEFT).evaluate((el) => el.scrollTop), "after a resize").toBe(0);
});

test("(L5) a hidden panel opens at its end, and follows the messages that arrived while it was hidden", async ({ page }) => {
  await longRunAtItsPrompt(page, "Follow the review");
  await showPanel(page, RIGHT);
  await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "hidden from the start" }).toBeLessThan(32);
  await showPanel(page, LEFT);
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${RIGHT}.*new`) })).toBeVisible();
  await showPanel(page, RIGHT);
  await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "following after the reveal" }).toBeLessThan(32);
});

test("(L6) a panel scrolled up keeps its position while hidden, and its chip counts what arrived", async ({ page }) => {
  await longRunAtItsPrompt(page, "Read the review from the start");
  await showPanel(page, RIGHT);
  await expect.poll(() => fromEnd(list(page, RIGHT))).toBeLessThan(32);
  await toTop(list(page, RIGHT));
  await showPanel(page, LEFT);
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${RIGHT}.*new`) })).toBeVisible();
  await showPanel(page, RIGHT);
  expect(await list(page, RIGHT).evaluate((el) => el.scrollTop)).toBe(0);
  await expect(panel(page, RIGHT).getByRole("button", { name: /new message/ })).toBeVisible();
});

// W2-R1-2: a notice is visible whichever panel is shown; here the server's own end (finding 15).
test("(L7) with the right panel shown, the page still says that the server has ended", async ({ page }) => {
  let route: import("@playwright/test").WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    route = ws;
    ws.connectToServer();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await startTask(page, "Watch the review");
  await expect(panel(page, LEFT).getByText(FIRST)).toBeVisible();
  await showPanel(page, RIGHT);
  await expect(panel(page, RIGHT)).toBeVisible();
  route!.send(JSON.stringify({ type: "closing" }));
  await expect(page.getByText("The server has ended. The page reconnects when it is started again.")).toBeVisible();
  await expect(panel(page, RIGHT)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// W2-R1-1: prompt 1 of a new run is a new prompt, although its number is that of the old run's prompt. The page is
// disconnected while run 1 ends and run 2 starts, so the replay brings run 2's prompt 1 with no step without a prompt.
test("(L8) a new run's first prompt selects 'You and Interloq' although the old run waited on a prompt of the same number", async ({ page, context }) => {
  let hold = false;
  let current: import("@playwright/test").WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (hold) {
      ws.close();
      return;
    }
    current = ws;
    ws.connectToServer();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await startTask(page, "The first run");
  await expect(panel(page, LEFT).getByText(FIRST)).toBeVisible();
  await showPanel(page, RIGHT);
  hold = true;
  await current!.close();
  const other = await context.newPage();
  await other.goto(URL);
  await other.locator("button[name=stop]").click();
  await other.locator("button[name=new]").click();
  await other.locator("textarea[name=task]").fill("The second run");
  await other.locator("button[name=start]").click();
  await expect(panel(other, LEFT).getByText(FIRST)).toBeVisible();
  hold = false;
  await expect(page.getByText("connected", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("The second run").first()).toBeVisible();
  await expect(panel(page, LEFT)).toBeVisible();
  await expect(page.locator("[name=answer]")).toBeVisible();
  await other.close();
});
