#!/usr/bin/env node
/**
 * PureWire production evidence-drawer QA — confirms the AI review Evidence
 * drawer renders the in-house signals (byte scan, C2PA provenance, AI
 * detector) and NO Resemble section, after the Resemble v2 API was removed
 * in favor of the fully in-house detector.
 *
 * Walk:
 *   1. Sign in as the admin through the real Auth form (Turnstile handled).
 *   2. Craft a tiny MP3 whose ID3v2 TSSE frame carries a review-tier AI
 *      marker ("Suno" — deliberately NOT a block-tier compound marker, so
 *      the server scan lands the post in the AI review queue instead of
 *      rejecting it outright). ID3v2 frames use syncsafe sizes the scanner
 *      parses reliably (a WAV LIST INFO chunk is skipped because WAV sizes
 *      are little-endian while the scanner's u32 helper reads big-endian).
 *   3. Upload it through the real composer UI (hidden file input), post it.
 *   4. Open /admin → AI review tab, expand the Evidence drawer on the test
 *      post, and assert:
 *        - "Byte scan" row renders (with a verdict badge)
 *        - "C2PA provenance" row renders
 *        - "AI detector" row renders
 *        - the word "Resemble" appears NOWHERE on the page (drawer or tab)
 *   5. Clean up: remove the test post via the admin trash → Standard
 *      principle citation dialog, so no test data stays on the live site.
 *
 * Run (password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:evidence-no-resemble
 *   # or: printf '%s' '<admin password>' > .freebuff/.admin-password
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app),
 * HEADED=1 to watch the browser, BROWSER_TIMEOUT_MS (default 30000).
 * Exit codes: 0 all checks passed, 1 a check failed or the walk crashed,
 * 2 missing password.
 */
import { createReporter, launchBrowser, signIn } from "./lib/qa-browser.mjs";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const NAV_TIMEOUT = 45000;
const WAIT_MS = 20000;
const POLL_MS = 250;
const reporter = createReporter();
const { check } = reporter;

/** Marker caption so the QA can find its own row in the admin queue. */
const CAPTION = `evidence-check-audio-${Date.now()}`;

/**
 * Build a minimal MP3 with an ID3v2.3 tag: one TSSE frame whose text is
 * "Suno". "suno" is a review-tier marker — the server scan reports review
 * (human queue) instead of blocking the upload — so the post lands in the
 * AI review tab with byte-scan evidence.
 */
function buildMarkerMp3() {
  const syncsafe = (n) =>
    Buffer.from([
      (n >> 21) & 0x7f,
      (n >> 14) & 0x7f,
      (n >> 7) & 0x7f,
      n & 0x7f,
    ]);
  const text = "Suno"; // review-tier marker
  const frameData = Buffer.concat([
    Buffer.from([0]), // encoding: ISO-8859-1
    Buffer.from(text, "latin1"),
  ]);
  const frame = Buffer.concat([
    Buffer.from("TSSE", "latin1"), // software/encoder frame
    syncsafe(frameData.length),
    Buffer.from([0, 0]), // frame flags
    frameData,
  ]);
  return Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([3, 0, 0]), // v2.3, no flags
    syncsafe(frame.length),
    frame,
  ]);
}

/** Poll until a locator count passes or the deadline expires. */
async function waitFor(page, locator, what) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if ((await locator.count()) > 0) return true;
    await page.waitForTimeout(POLL_MS);
  }
  console.log(`  ⏳ waited for ${what} without success`);
  return false;
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire evidence drawer QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(TIMEOUT);

    // ── 1. Sign in ─────────────────────────────────────────────
    await signIn(page, {
      siteUrl: SITE_URL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      timeoutMs: TIMEOUT,
      navTimeoutMs: NAV_TIMEOUT,
    });
    check("signed in and landed on /home", page.url().includes("/home"));

    // ── 2. Upload the marker WAV through the real composer ──────
    await page.goto(`${SITE_URL}/home`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('textarea[placeholder="Say it anyway…"]', { timeout: TIMEOUT });
    await page.fill('textarea[placeholder="Say it anyway…"]', CAPTION);
    // The MediaUpload file input is hidden but real — Playwright can set
    // files on it directly, exactly like a user picking a file.
    const mp3 = buildMarkerMp3();
    await page.setInputFiles('input[type="file"][accept*="audio"]', {
      name: "evidence-check.mp3",
      mimeType: "audio/mpeg",
      buffer: mp3,
    });
    // Give the upload a moment to ticket + POST before submitting.
    await page.waitForTimeout(3000);
    check(
      "audio file attached to the composer",
      (await page.locator('button[aria-label="Remove media"]').count()) === 1,
    );
    await page.getByRole("button", { name: "Post", exact: true }).click();
    // The createPost action uploads + scans + writes — it can take seconds.
    // Wait for the success toast (review path or posted path) before leaving
    // /home, so the in-flight action isn't aborted by navigation.
    const postedToast = page.locator(
      '[data-sonner-toast]',
    );
    const posted = await waitFor(
      page,
      postedToast,
      "the composer toast (post created or under review)",
    );
    check("composer confirmed the post was submitted", posted);

    // ── 3. Land in the AI review queue ─────────────────────────
    await page.goto(`${SITE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-slot="tabs-list"]', { timeout: TIMEOUT });
    await page.getByRole("tab", { name: "AI review" }).click();
    const row = page.locator("div").filter({ hasText: CAPTION }).first();
    check(
      "test post appears in the AI review queue",
      await waitFor(page, row, "the test post to enter AI review"),
    );

    // ── 4. Expand the Evidence drawer and assert its contents ──
    // The Evidence toggle sits in the same row as the caption.
    const rowRoot = page
      .locator('div[class*="rounded-xl border p-3"]')
      .filter({ has: page.locator(`text=${CAPTION}`) })
      .first();
    const evidenceBtn = rowRoot.getByRole("button", { name: "Evidence", exact: true });
    if ((await evidenceBtn.count()) > 0) {
      await evidenceBtn.click();
      await page.waitForTimeout(800);
    }
    const drawerRoot = rowRoot;

    check(
      "Byte scan row renders in the evidence drawer",
      (await drawerRoot.getByText("Byte scan").count()) > 0,
    );
    check(
      "C2PA provenance row renders in the evidence drawer",
      (await drawerRoot.getByText("C2PA provenance").count()) > 0,
    );
    check(
      "AI detector row renders in the evidence drawer",
      (await drawerRoot.getByText("AI detector").count()) > 0,
    );
    const pageText = await page.evaluate(() => document.body.innerText);
    check(
      "no Resemble text anywhere on the admin page",
      !/resemble/i.test(pageText),
      /resemble/i.test(pageText) ? "Resemble still rendered!" : "",
    );
    const drawerText = await drawerRoot.innerText().catch(() => "");
    check(
      "no Resemble text inside the evidence drawer",
      !/resemble/i.test(drawerText),
    );

    // ── 5. Clean up: remove the test post (Standard citation) ──
    const removeBtn = rowRoot.getByRole("button", { name: "Remove post" });
    if ((await removeBtn.count()) > 0) {
      await removeBtn.click();
      await page.waitForTimeout(600);
      // StandardViolationDialog: pick the first principle, confirm.
      await page.locator('[data-slot="select-trigger"]').click();
      await page.waitForTimeout(400);
      await page.locator('[data-slot="select-item"]').first().click();
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: "Remove post" }).click();
      // Wait for the row to actually disappear from the queue.
      const deadline = Date.now() + WAIT_MS;
      let gone = false;
      while (Date.now() < deadline) {
        if ((await page.locator("div").filter({ hasText: CAPTION }).count()) === 0) {
          gone = true;
          break;
        }
        await page.waitForTimeout(POLL_MS);
      }
      check("test post removed from the AI review queue (cleanup)", gone);
    } else {
      check("test post removed from the AI review queue (cleanup)", false, "no remove button found");
    }

    await page.close();
  } finally {
    await browser.close();
  }
  reporter.summary();
  if (reporter.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nEvidence drawer QA crashed:", e.message ?? e);
  process.exit(1);
});
