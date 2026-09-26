import { expect, type Page, test } from "@playwright/test";

// Plan step 5.2: the page against the server over scripted agents (e2e/server.ts), one server per scenario.
const url = (scenario: "converge" | "decision" | "stop") => `http://127.0.0.1:${{ converge: 8101, decision: 8102, stop: 8103 }[scenario]}/`;
const left = (page: Page) => page.getByRole("region", { name: "You and plan-review" });
const right = (page: Page) => page.getByRole("region", { name: "Claude Code and Codex" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Progress of the run" });

/** Opens the page, returns to the form if a run has ended, and starts a task. */
const startTask = async (page: Page, scenario: "converge" | "decision" | "stop", task: string) => {
  await page.goto(url(scenario));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  const again = page.locator("button[name=new]");
  if (await again.isVisible()) await again.click();
  await page.locator("textarea[name=task]").fill(task);
  await page.locator("button[name=start]").click();
};

test("(1) a run from the form: the timeline shows its phases and the right panel the agents' exchange", async ({ page }) => {
  await startTask(page, "converge", "Document the service");
  await expect(rail(page).getByText("Planning 1", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Execution 1", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Work review 1", { exact: true })).toBeVisible();
  await expect(right(page).getByText("The step names no file.")).toBeVisible();
  await expect(right(page).getByText(/accepted: rationale P1-R1-1/)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
  await expect(page.locator("button[name=new]")).toBeVisible();
});

test("(2) a decision prompt with its buttons: No decision continues, and the answer is the user's message", async ({ page }) => {
  await startTask(page, "decision", "Add a database");
  await expect(left(page).getByText("Decision on: question from Claude Code: Which database should the service use?")).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).locator("[data-author=user]").getByText("No decision")).toBeVisible();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
});

test("(3) a reload during a run shows the same messages and the pending prompt", async ({ page }) => {
  await startTask(page, "decision", "Add a database again");
  const prompt = left(page).getByText("Decision on: question from Claude Code: Which database should the service use?");
  await expect(prompt).toBeVisible();
  const before = await left(page).locator("article").allTextContents();
  await page.reload();
  await expect(prompt).toBeVisible();
  expect(await left(page).locator("article").allTextContents()).toEqual(before);
  await expect(page.getByRole("button", { name: "No decision" })).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
});

test("(4) one click on Stop interrupts the task, and the page offers a new one", async ({ page }) => {
  await startTask(page, "stop", "A task to stop");
  await expect(left(page).getByText(/round 1: Claude Code response/)).toBeVisible();
  await page.locator("button[name=stop]").click();
  await expect(left(page).getByText(/INTERRUPTED by the user\. State is preserved in/)).toBeVisible();
  await expect(page.locator("button[name=stop]")).toBeDisabled();
  await page.locator("button[name=new]").click();
  await expect(page.locator("textarea[name=task]")).toBeVisible();
});
