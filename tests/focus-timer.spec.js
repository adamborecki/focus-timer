const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__FOCUS_TIMER_CONFIG__ = {
      focusAlarmFadeSeconds: 1,
      breakReturnFadeSeconds: 1,
    };
  });
});

test("shows the default focused-coach rhythm cues", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Block 1 of 3")).toBeVisible();
  await expect(page.getByText("Next break 5 min")).toBeVisible();
  await expect(page.getByText("Start with a clear verb")).toBeVisible();
  await expect(page.getByText("Start with a verb. Rename the block anytime if the day shifts.")).toBeVisible();
});

test("runs through a 3-block cycle and offers a long break", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Enable Audio" }).click();
  await page.getByLabel("I am focusing on").fill("write sprint plan");
  await page.getByRole("button", { name: "Start Focus" }).click();

  for (let block = 1; block <= 2; block += 1) {
    await page.getByRole("button", { name: "Wrap This Block" }).click();
    await expect(page.getByRole("button", { name: "Start Break" })).toBeVisible();
    await page.getByRole("button", { name: "Start Break" }).click();
    await page.getByRole("button", { name: "Wrap This Break" }).click();
    await expect(page.getByRole("button", { name: "Start Next Block" })).toBeVisible();
    await page.getByRole("button", { name: "Start Next Block" }).click();
    await expect(page.getByText(`Block ${block + 1} of 3`)).toBeVisible();
  }

  await page.getByRole("button", { name: "Wrap This Block" }).click();
  await expect(page.getByRole("button", { name: "Start Long Break" })).toBeVisible();
  await expect(page.getByText("Long Break Due")).toBeVisible();
  await expect(page.getByText("Long break 15+ min")).toBeVisible();
  await expect(page.getByText("Cycle complete. Take a real break now. Fifteen minutes is the floor, and lunch can be longer.")).toBeVisible();
});

test("restores an in-progress focus block after refresh within the restore window", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Enable Audio" }).click();
  await page.getByLabel("I am focusing on").fill("organize the apartment");
  await page.getByRole("button", { name: "Start Focus" }).click();

  await expect(page.getByText("Focus block started")).toBeVisible();
  await page.reload();

  await expect(page.getByText("Focus block restored. Tap Enable Audio if you want the soundscape back.")).toBeVisible();
  await expect(page.locator("#intentionPreview")).toContainText("organize the apartment");
  await expect(page.getByText("Block 1 of 3")).toBeVisible();
});

test("copies the AI check-in prompt after a completed block", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await page.getByRole("button", { name: "Enable Audio" }).click();
  await page.getByLabel("I am focusing on").fill("outline the homepage");
  await page.getByRole("button", { name: "Start Focus" }).click();
  await page.getByRole("button", { name: "Wrap This Block" }).click();

  await page.getByRole("button", { name: "Copy AI Check-In Prompt" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain("Current intention: outline the homepage.");
  expect(prompt).toContain("Should I take a short break, a long break, or make the next block smaller?");
});
