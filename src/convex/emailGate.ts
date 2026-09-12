/**
 * Disposable / temporary / forwarding email domain gate.
 *
 * Pure string logic, no ctx — usable from the auth profile callback, the
 * after-user-created callback, and anywhere else a rejection needs to be
 * decided. Mirrors the spec: normalize the email → extract the domain →
 * compare against the maintained denylist → allow/reject. Matching is by
 * domain, never by full address, and a listed domain blocks its subdomains
 * too (services hand out per-user subdomains: anything.mailinator.com).
 *
 * The denylist itself lives in blocked-email-domains/*.txt (the maintained
 * source of truth) and is compiled into emailDomainList.ts by
 * scripts/generate-email-domain-list.mjs.
 *
 * This is ONE layer. It deliberately does not rely on DNS/MX (a disposable
 * provider can stand up legitimate-looking mail infrastructure) — it runs
 * alongside the existing layered controls: Turnstile bot/IP-reputation
 * gating before verification codes, email OTP verification, risk-score
 * farm/bot detection, quiet shadowban escalation, and the signup-velocity
 * limit in auth.ts.
 */
// `.js` suffix so both the Convex esbuild bundle AND Node's type-stripping
// (which the pure-function QA imports use) resolve it to emailDomainList.ts.
import type { EmailDomainEntry } from "./emailDomainList.js";

export type EmailDomainCategory =
  | "disposable"
  | "temporary"
  | "mail-forwarding"
  | "custom";

export interface EmailDomainVerdict {
  /** The listed domain that matched (the bare entry, for reporting). */
  domain: string;
  category: EmailDomainCategory;
  /** The actual domain of the submitted address (may be a subdomain). */
  matchedAs: string;
}

/**
 * Extract a normalized domain from an email address. Returns null for
 * addresses with no `@`, a missing/empty domain, or a domain with no dot
 * (can't be a real hostname — and `user@localhost`-style internal boxes
 * never pass the email layer anyway).
 */
export function emailDomainOf(email: string): string | null {
  const raw = email.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const domain = raw.slice(at + 1);
  if (
    domain.length < 4 ||
    !domain.includes(".") ||
    /\s/.test(domain) ||
    /[^a-z0-9.-]/.test(domain)
  ) {
    return null;
  }
  return domain.replace(/\.$/, "");
}

/**
 * The denylist verdict for an email address, or null when the domain is
 * clean. Exact match OR any subdomain of a listed domain blocks — that is
 * what covers both `user@mailinator.com` and `user@anything.mailinator.com`
 * from a single bare-domain entry.
 *
 * The list is a parameter (not an import) so this module stays a pure,
 * import-free unit: the backend passes the generated list in, and the QA
 * scripts can drive the same logic with the same list from Node.
 */
export function disposableEmailDomain(
  email: string,
  list: readonly EmailDomainEntry[],
): EmailDomainVerdict | null {
  const domain = emailDomainOf(email);
  if (domain === null) return null;
  for (const entry of list) {
    if (domain === entry.domain || domain.endsWith(`.${entry.domain}`)) {
      return {
        domain: entry.domain,
        category: entry.category,
        matchedAs: domain,
      };
    }
  }
  return null;
}

/** The human-facing reason a signup was rejected. */
export function disposableEmailReason(verdict: EmailDomainVerdict): string {
  const label: Record<EmailDomainCategory, string> = {
    disposable: "a disposable email service",
    temporary: "a temporary email service",
    "mail-forwarding": "a mail-forwarding service",
    custom: "an email provider PureWire has blocked",
  };
  return (
    `That address uses ${label[verdict.category]} (${verdict.matchedAs}), ` +
    `which isn't allowed on PureWire. Sign up with a permanent email address instead.`
  );
}
