import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { assertAdminIpVerified } from "./adminIp";
import { escalateSilently } from "./security";
import { mutation, query } from "./_generated/server";

/**
 * Server-side intake for the client's browser-automation score.
 *
 * The client runs an original automation-detection pass (see
 * lib/automation-signal.ts) and files the coarse 0–100 score + matched
 * signal names here. The server only ever sees the score and a list of
 * signal names — no raw fingerprint, no PII.
 *
 * Enforcement is proportional, never binary:
 *   - A clean real browser (score < 40) is untouched.
 *   - A high score (>= 70, several independent automation markers) adds
 *     points to the silent-flag pipeline — repeated automation attempts
 *     quietly shadowban, exactly like the other abuse signals. A single
 *     weird fingerprint can't convict anyone on its own.
 *   - Scores are recorded on the user so admins can see the trend in the
 *     Security tab (a jump from 0 to 90 after a device change is a clue).
 */

// One report per hour per user — the score changes rarely, and flooding the
// table serves no one.
const REPORT_COOLDOWN_MS = 60 * 60 * 1000;

export const report = mutation({
  args: {
    score: v.number(),
    signals: v.array(v.string()),
  },
  handler: async (ctx, { score, signals }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    if (!Number.isFinite(score)) return;
    const clamped = Math.max(0, Math.min(100, Math.round(score)));

    const me = await ctx.db.get(userId);
    if (me === null || me.role === "admin") return;

    // Cooldown: don't re-flag every page load.
    const last = me.automationReportedAt;
    if (last !== undefined && Date.now() - last < REPORT_COOLDOWN_MS) {
      return;
    }
    await ctx.db.patch(userId, {
      automationScore: clamped,
      automationSignals: signals.slice(0, 12),
      automationReportedAt: Date.now(),
    });

    // Proportional escalation: several independent automation markers
    // (webdriver + CDP injection + no plugins, etc.) are the shape of a
    // driven browser. One or two weak signals are just an unusual setup.
    if (clamped >= 70 && signals.length >= 2) {
      await escalateSilently(
        ctx,
        userId,
        4,
        "automation",
        `automation-score-${clamped}`,
      );
    } else if (clamped >= 90) {
      await escalateSilently(
        ctx,
        userId,
        2,
        "automation",
        `automation-score-${clamped}`,
      );
    }
  },
});

/** Admin: current automation signal for one account. */
export const getAutomation = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const meId = await getAuthUserId(ctx);
    if (meId === null) return null;
    const me = await ctx.db.get(meId);
    if (me?.role !== "admin") return null;
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    const target = await ctx.db.get(userId);
    if (target === null) return null;
    return {
      score: target.automationScore ?? null,
      signals: target.automationSignals ?? [],
      reportedAt: target.automationReportedAt ?? null,
    };
  },
});
