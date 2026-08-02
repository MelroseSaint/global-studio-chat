#!/usr/bin/env node
/**
 * Shared secret resolution for PureWire production QA scripts.
 *
 * Precedence:
 *   1. The ADMIN_PASSWORD environment variable (still supported — useful in
 *      CI, where a secret is injected, or when a caller wants to override).
 *   2. The gitignored local file `.freebuff/.admin-password` (a single line,
 *      trimmed). This is the recommended path for interactive runs so the
 *      real password never appears in shell history, this transcript, or a
 *      commit. `.freebuff/` is already in `.gitignore`.
 *
 * Never logs or exposes the value.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PASSWORD_FILE = join(ROOT, ".freebuff", ".admin-password");

/** Resolve the admin password without printing it. Returns undefined when unavailable. */
export function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) {
    return process.env.ADMIN_PASSWORD;
  }
  if (existsSync(PASSWORD_FILE)) {
    const value = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Human-readable hint for the "password not found" error message. */
export function passwordHint() {
  return [
    "No admin password available. Provide it one of two ways:",
    "  1. env:  ADMIN_PASSWORD=<admin password> npm run qa:admin-auth",
    "  2. file: put the password (one line) in .freebuff/.admin-password",
    "          (gitignored — never committed, never shown in chat)",
  ].join("\n");
}
