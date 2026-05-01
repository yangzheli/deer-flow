import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, type Page } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_ROOT = path.resolve(__dirname, "__screenshots__");

const SAMPLE_THREAD_ID = "3b25b2f7-7641-4a8d-bb14-d486bd5571b8";

const ROUTES: Array<{ name: string; path: string; noAuth?: boolean }> = [
  { name: "01-landing", path: "/" },
  { name: "02-login", path: "/login", noAuth: true },
  { name: "03-setup", path: "/setup", noAuth: true },
  { name: "04-workspace", path: "/workspace" },
  { name: "05-workspace-chats", path: "/workspace/chats" },
  { name: "06-workspace-chats-new", path: "/workspace/chats/new" },
  {
    name: "07-workspace-chat-thread",
    path: `/workspace/chats/${SAMPLE_THREAD_ID}`,
  },
  { name: "08-workspace-agents", path: "/workspace/agents" },
  { name: "09-workspace-agents-new", path: "/workspace/agents/new" },
  { name: "10-blog", path: "/blog" },
  { name: "11-blog-posts", path: "/blog/posts" },
  { name: "12-docs", path: "/en/docs" },
];

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function applyTheme(page: Page, theme: Theme) {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("theme", t);
    } catch {}
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(t);
    document.documentElement.style.colorScheme = t;
  }, theme);
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 });
  } catch {}
  await page.waitForTimeout(400);
}

async function capture(page: Page, file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
}

for (const theme of THEMES) {
  test.describe(`visual-tour [${theme}]`, () => {
    test.use({ colorScheme: theme === "dark" ? "dark" : "light" });

    test.beforeEach(async ({ page }) => {
      await applyTheme(page, theme);
    });

    for (const route of ROUTES) {
      test(`route ${route.name}`, async ({ page, context }, testInfo) => {
        const project = testInfo.project.name;
        const dir = path.join(SHOTS_ROOT, project, theme);
        if (route.noAuth) {
          await context.clearCookies();
        }
        try {
          await page.goto(route.path, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
        } catch (err) {
          console.warn(`[visual] navigation failed for ${route.path}:`, err);
        }
        await settle(page);
        await capture(page, path.join(dir, `${route.name}.png`));
      });
    }

    test("interactions", async ({ page }, testInfo) => {
      const project = testInfo.project.name;
      const dir = path.join(SHOTS_ROOT, project, theme, "interactions");

      // Base — workspace chat, where ⌘K / ⌘, are wired up.
      await page.goto(`/workspace/chats/new`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await settle(page);
      await capture(page, path.join(dir, "00-workspace-base.png"));

      // 1. Command palette (⌘K)
      try {
        await page.keyboard.press("Meta+k");
        await page.waitForTimeout(500);
        await capture(page, path.join(dir, "01-command-palette.png"));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      } catch (err) {
        console.warn("[visual] command palette:", err);
      }

      // 2. Settings dialog — open via ⌘, shortcut, then walk every section
      const SECTIONS = [
        "Account",
        "Appearance",
        "Notification",
        "Memory",
        "Tools",
        "Skills",
        "About",
      ] as const;

      try {
        await page.keyboard.press("Meta+,");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ state: "visible", timeout: 4000 });
        await page.waitForTimeout(500);
        await capture(page, path.join(dir, "02-settings-default.png"));

        for (const section of SECTIONS) {
          try {
            const navBtn = dialog
              .getByRole("button", { name: new RegExp(`^${section}$`, "i") })
              .first();
            await navBtn.click({ timeout: 2500 });
            await page.waitForTimeout(450);
            await capture(
              page,
              path.join(dir, `02-settings-${section.toLowerCase()}.png`),
            );
          } catch (err) {
            console.warn(`[visual] settings ${section}:`, err);
          }
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      } catch (err) {
        console.warn("[visual] settings open:", err);
      }
    });

    test("chat-actions", async ({ page }, testInfo) => {
      const project = testInfo.project.name;
      const dir = path.join(SHOTS_ROOT, project, theme, "chat-actions");

      // Land on a workspace page so the sidebar with recent chats is rendered.
      await page.goto("/workspace/chats/new", {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await settle(page);

      // First *thread* row — must have the More action button (skips "New chat" / "Chats" nav rows).
      const firstThreadItem = page
        .locator('[data-sidebar="menu-item"]')
        .filter({ has: page.locator('[data-sidebar="menu-action"]') })
        .first();
      const moreBtn = firstThreadItem
        .locator('[data-sidebar="menu-action"]')
        .first();

      try {
        await firstThreadItem.waitFor({ state: "visible", timeout: 6000 });
        await firstThreadItem.hover();
        await page.waitForTimeout(300);
        await capture(page, path.join(dir, "00-chat-row-hover.png"));

        // Open the "..." dropdown — force-click since the action is opacity-0 until hover.
        await moreBtn.click({ timeout: 2500, force: true });
        const menu = page.getByRole("menu").first();
        await menu.waitFor({ state: "visible", timeout: 3000 });
        await page.waitForTimeout(300);
        await capture(page, path.join(dir, "01-dropdown-open.png"));

        // Hover "Export" submenu trigger to reveal Markdown / JSON
        try {
          const exportTrigger = menu
            .getByRole("menuitem", { name: /^export$/i })
            .first();
          await exportTrigger.hover();
          await page.waitForTimeout(450);
          await capture(page, path.join(dir, "02-export-submenu.png"));
        } catch (err) {
          console.warn("[visual] export submenu:", err);
        }

        // Close and reopen for a clean Rename dialog capture.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        await firstThreadItem.hover();
        await page.waitForTimeout(200);
        await moreBtn.click({ timeout: 2500, force: true });
        await page
          .getByRole("menu")
          .first()
          .waitFor({ state: "visible", timeout: 3000 });

        const renameItem = page
          .getByRole("menuitem", { name: /^rename$/i })
          .first();
        await renameItem.click({ timeout: 2500 });

        const renameDialog = page.getByRole("dialog");
        await renameDialog.waitFor({ state: "visible", timeout: 3000 });
        await page.waitForTimeout(400);
        await capture(page, path.join(dir, "03-rename-dialog.png"));

        // Cancel — never actually rename / delete real user data.
        await renameDialog
          .getByRole("button", { name: /cancel/i })
          .click({ timeout: 2500 });
        await page.waitForTimeout(200);
      } catch (err) {
        console.warn("[visual] chat-actions:", err);
      }
    });
  });
}
