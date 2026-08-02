#!/usr/bin/env node
/**
 * PureWire secrets scan — runs locally and in CI (static-audit.yml) on every
 * push to `main`. Scans every git-tracked file for high-signal secret shapes
 * (Resend keys, Vercel tokens, private keys, and any of the server-side env
 * vars that must never live in a committed file). Exits non-zero on the first
 * batch of findings so a leaked key fails the pipeline before it deploys.
 *
 * Run:
 *   npm run qa:secrets
 *
 * Exit codes: 0 clean, 1 secrets found.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// High-signal shapes: anything that matches is almost certainly a live
// credential, not a false positive.
const PATTERNS = [
  [/re_[A-Za-z0-9]{16,}/, "Resend API key"],
  [/vcp_[A-Za-z0-9]{16,}/, "Vercel access token"],
  [/sk_[A-Za-z0-9]{16,}/, "VLY / OpenAI-style secret key"],
  [/ghp_[A-Za-z0-9]{36,}/, "GitHub personal access token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key ID"],
  [/AIza[0-9A-Za-z_-]{35,}/, "Google API key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "Private key block"],
];

// Server-side env vars that are secrets by definition: a non-empty value in
// any tracked file is a leak. (The .env.example placeholders are empty, so
// they never match; the public VITE_* vars in .env.production are not on
// this list — they ship in the client bundle by design.)
const SECRET_ENV = [
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "EMAIL_HASH_SALT",
  "JWT_PRIVATE_KEY",
  "ADMIN_PASSWORD",
];

let scanned = 0;
const findings = [];

function scanFile(file) {
  scanned++;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    // Binary or unreadable files simply can't contain text secrets.
    return;
  }
  const lines = content.split("\n");
  for (const [re, label] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        findings.push(`${file}:${i + 1} — possible ${label}`);
      }
    }
  }
  for (const name of SECRET_ENV) {
    const envRe = new RegExp(`^${name}=.+`);
    for (let i = 0; i < lines.length; i++) {
      if (envRe.test(lines[i])) {
        findings.push(`${file}:${i + 1} — ${name} is set to a real value in a tracked file`);
      }
    }
  }
}

const files = execSync("git ls-files", {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean);

for (const file of files) {
  scanFile(file);
}

if (findings.length > 0) {
  const unique = [...new Set(findings)];
  console.error(`\n❌ Secrets scan found ${unique.length} potential leak(s) across ${scanned} tracked files:\n`);
  for (const f of unique.slice(0, 50)) {
    console.error(`  - ${f}`);
  }
  if (unique.length > 50) {
    console.error(`  … and ${unique.length - 50} more.`);
  }
  console.error("\nRemove the secret from git, rotate it if it was ever pushed,");
  console.error("and add a fresh key — the CI pipeline stays red until this is clean.");
  process.exit(1);
}

console.log(`\n✅ Secrets scan clean — no secret shapes in ${scanned} tracked files.`);
