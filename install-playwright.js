import { execSync } from "child_process";
import path from "path";

// Resolve the absolute path for Render persistence
const browsersPath = path.resolve(process.cwd(), ".playwright-browsers");
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

console.log(`[Build] Installing Playwright Chromium into absolute path: ${browsersPath}`);

try {
  execSync("npx playwright install chromium", { stdio: "inherit" });
  console.log("[Build] Playwright Chromium installed successfully.");
} catch (error) {
  console.error("[Build] Error installing Playwright Chromium:", error.message);
  process.exit(1);
}
