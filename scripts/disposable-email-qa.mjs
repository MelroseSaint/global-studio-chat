#!/usr/bin/env node
/**
 * PureWire disposable-email gate QA.
 *
 * Proves the anti-abuse layer from the spec: at signup the submitted email
 * is normalized, the domain extracted, compared against the maintained
 * denylist (blocked-email-domains/*.txt → src/convex/emailDomainList.ts),
 * and known disposable/temporary/forwarding domains rejected BEFORE the
 * account is created.
 *
 * Part 1 — pure (always runs, no deployment needed):
 *   - domain normalization (case, tags, whitespace, subdomains)
 *   - exact + subdomain denylist matching across every category
 *   - clean domains pass
 *   - the generated module is in sync with the maintained txt files
 *     (the same drift guard the static-audit workflow runs)
 *
 * Part 2 — live (harness-gated): drives the REAL signup action
 * (api.auth.signIn, flow "signUp") against the deployment with disposable
 * addresses and asserts the signup is rejected and no account row is ever
 * created. Requires TEST_HARNESS_SECRET; skipped (exit 0, loud note) when
 * absent so the static-audit job can run Part 1 alone.
 *
 * Run:
 *   npm run qa:email-domains
 *   TEST_HARNESS_SECRET=<secret> npm run qa:email-domains
 *
 * Overrides: CONVEX_URL (default the production deployment).
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import {
  disposableEmailDomain,
  disposableEmailReason,
  emailDomainOf,
} from "../src/convex/emailGate.ts";
import {
  DISPOSABLE_EMAIL_DOMAINS,
  EMAIL_DOMAIN_COUNT,
} from "../src/convex/emailDomainList.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u274c ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Same normalization the generator applies to blocked-email-domains/*.txt. */
function normalizeLine(line) {
  let domain = line.trim().toLowerCase().replace(/\.$/, "");
  if (domain.startsWith("*.")) domain = domain.slice(2);
  if (domain.startsWith(".")) domain = domain.slice(1);
  if (
    domain.length < 4 ||
    !domain.includes(".") ||
    /\s/.test(domain) ||
    /[^a-z0-9.-]/.test(domain)
  ) {
    return null;
  }
  return domain;
}

/** Rebuild the denylist from the maintained txt files (generator logic). */
function listFromTxtFiles() {
  const categories = ["disposable", "temporary", "mail-forwarding", "custom"];
  const entries = new Map();
  for (const category of categories) {
    const text = readFileSync(
      join(ROOT, "blocked-email-domains", `${category}.txt`),
      "utf8",
    );
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.trim().length === 0 || rawLine.trim().startsWith("#")) continue;
      const domain = normalizeLine(rawLine);
      if (domain !== null && !entries.has(domain)) {
        entries.set(domain, category);
      }
    }
  }
  return [...entries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, category]) => ({ domain, category }));
}

async function run() {
  console.log(`\nDisposable-email gate QA (${CONVEX_URL})\n`);

  // ── Part 1: pure gate logic ────────────────────────────────────────────
  console.log("Part 1 — gate logic and denylist integrity\n");

  check(
    "domain extraction lowercases and strips tags/whitespace",
    emailDomainOf("User+Tag@Mailinator.COM") === "mailinator.com" &&
      emailDomainOf("  user@example.org  ") === "example.org",
  );
  check(
    "subdomain emails extract their full host",
    emailDomainOf("user@sub.example.co.uk") === "sub.example.co.uk",
  );
  check(
    "malformed addresses yield no domain",
    emailDomainOf("no-at-sign") === null &&
      emailDomainOf("user@") === null &&
      emailDomainOf("user@localhost") === null &&
      emailDomainOf("user@no-dot") === null,
  );

  const mailinator = disposableEmailDomain(
    "user@mailinator.com",
    DISPOSABLE_EMAIL_DOMAINS,
  );
  check(
    "exact denylist match blocks (disposable)",
    mailinator?.domain === "mailinator.com" &&
      mailinator?.category === "disposable",
  );
  const subdomain = disposableEmailDomain(
    "user@anything.mailinator.com",
    DISPOSABLE_EMAIL_DOMAINS,
  );
  check(
    "subdomain of a listed domain blocks",
    subdomain?.domain === "mailinator.com" && subdomain?.matchedAs === "anything.mailinator.com",
  );
  const categories = new Set(
    DISPOSABLE_EMAIL_DOMAINS.map((e) => e.category),
  );
  check(
    "curated denylist categories are represented",
    ["disposable", "temporary", "mail-forwarding"].every((c) =>
      categories.has(c),
    ),
    [...categories].join(","),
  );
  check(
    "custom.txt exists for additive entries (may be empty)",
    readFileSync(join(ROOT, "blocked-email-domains", "custom.txt"), "utf8") !==
      undefined,
  );
  check(
    "denylist is non-trivial (>= 100 domains)",
    DISPOSABLE_EMAIL_DOMAINS.length >= 100,
    `${DISPOSABLE_EMAIL_DOMAINS.length} domains`,
  );
  check(
    "EMAIL_DOMAIN_COUNT matches the compiled list",
    EMAIL_DOMAIN_COUNT === DISPOSABLE_EMAIL_DOMAINS.length,
  );
  check(
    "generated list matches the maintained txt files (no drift)",
    JSON.stringify(listFromTxtFiles()) ===
      JSON.stringify([...DISPOSABLE_EMAIL_DOMAINS]),
  );

  const clean = disposableEmailDomain("user@gmail.com", DISPOSABLE_EMAIL_DOMAINS);
  check("clean permanent domain passes", clean === null);
  const reason = disposableEmailReason(
    disposableEmailDomain("x@guerrillamail.com", DISPOSABLE_EMAIL_DOMAINS),
  );
  check(
    "rejection reason names the category and domain",
    /disposable email service \(guerrillamail\.com\)/.test(reason),
  );

  // ── Part 2: live signup rejection (harness-gated) ───────────────────────
  if (!HARNESS_SECRET) {
    console.log(
      "\nPart 2 (live signup rejection) SKIPPED — TEST_HARNESS_SECRET not set.",
    );
    console.log("This job is for the static-audit workflow; the live checks run in production-healthcheck.\n");
    finish();
    return;
  }

  console.log("\nPart 2 — live signup rejection against the deployment\n");

  const client = new ConvexHttpClient(CONVEX_URL);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // One probe per category, each from a DIFFERENT listed domain so a
  // category collapse (e.g. the temporary list emptying out) is caught.
  const probes = [
    { domain: "mailinator.com", category: "disposable" },
    { domain: "guerrillamail.com", category: "disposable" },
    { domain: "10minutemail.com", category: "temporary" },
    { domain: "spamgourmet.com", category: "mail-forwarding" },
  ];

  for (const probe of probes) {
    const email = `qa_dispo_${stamp}@${probe.domain}`;
    let threw = false;
    let message = "";
    try {
      await client.action(api.auth.signIn, {
        provider: "password",
        params: {
          email,
          password: "DispoTest#2026",
          name: "QA Dispo",
          username: `qa_dispo_${stamp}`,
          flow: "signUp",
        },
      });
    } catch (err) {
      threw = true;
      // Mirror the Auth page (authErrorMessage): the ConvexError payload
      // crosses the boundary in `err.data` — `.message` stays masked.
      const errData =
        err instanceof Error && "data" in err
          ? String(err.data ?? "")
          : "";
      message =
        errData || (err instanceof Error ? err.message : String(err));
    }
    check(
      `signup with ${probe.domain} (${probe.category}) is rejected`,
      threw,
      message.slice(0, 120),
    );
    if (threw) {
      check(
        `rejection message names the ${probe.category} reason`,
        /disposable email service|temporary email service|mail-forwarding service|has blocked/i.test(message),
        message.slice(0, 120),
      );
    }
    // The account must never exist: mintSessionForEmail throws for a
    // missing user, so a non-throw here would mean the signup leaked a row.
    let accountLeaked = false;
    try {
      await client.mutation(api.testHarness.mintSessionForEmail, {
        email,
        secret: HARNESS_SECRET,
      });
      accountLeaked = true;
    } catch {
      // Expected — no account with that email.
    }
    check(
      `no account row created for ${probe.domain}`,
      !accountLeaked,
      accountLeaked ? "signup leaked an account row" : "",
    );
  }

  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error(`Failed checks:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
