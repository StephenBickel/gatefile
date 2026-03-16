const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("records core planfile flow walkthrough", async ({ page }) => {
  const screenshotDir = path.resolve(__dirname, "output");
  const demoFile = pathToFileURL(path.resolve(__dirname, "index.html")).href;

  const clickAndWait = async (action) => {
    await page.click(`button[data-action="${action}"]`);
    await page.waitForTimeout(250);
  };

  await page.goto(demoFile);
  await expect(page.locator("h1")).toContainText("Approval and Tamper Detection Walkthrough");

  await clickAndWait("create");
  await clickAndWait("verify-initial");
  await expect(page.locator("#v-status")).toHaveText("not-ready");
  await page.screenshot({
    path: path.join(screenshotDir, "walkthrough-1-not-ready.png"),
    fullPage: true
  });

  await clickAndWait("approve");
  await clickAndWait("verify-ready");
  await expect(page.locator("#v-status")).toHaveText("ready");
  await page.screenshot({
    path: path.join(screenshotDir, "walkthrough-2-ready.png"),
    fullPage: true
  });

  await clickAndWait("tamper");
  await clickAndWait("verify-tampered");
  await expect(page.locator("#v-status")).toHaveText("not-ready");
  await clickAndWait("apply");

  await expect(page.locator("#log li").last()).toContainText("refused: verification failed");
  await page.screenshot({
    path: path.join(screenshotDir, "walkthrough-3-refusal.png"),
    fullPage: true
  });
});
