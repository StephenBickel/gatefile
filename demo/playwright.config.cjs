/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: ".",
  testMatch: /walkthrough\.spec\.js/,
  outputDir: "output/test-results",
  timeout: 30000,
  retries: 0,
  use: {
    viewport: { width: 1440, height: 900 },
    video: "on"
  }
};
