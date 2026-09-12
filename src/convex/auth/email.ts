import { Email } from "@convex-dev/auth/providers/Email";

import { sendEmail } from "@/lib/email-service";
import { codeEmailHtml, codeEmailText } from "@/lib/email-template";

/** Generate a random 6-digit one-time code. */
export async function generateSixDigitToken(): Promise<string> {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

/** Email a one-time code through PureWire's email service. */
export async function sendCodeEmail(
  to: string,
  subject: string,
  token: string,
  kind: "verify" | "reset",
) {
  // Fail with a clear, human message instead of leaking the provider's raw
  // rejection (e.g. an invalid API key, an unverified sender domain, or a
  // provider outage) — that string surfacing in the auth flow reads like a
  // broken login, not an email outage. Translate any failure here so
  // sign-up/verify/reset show the real story.
  const result = await sendEmail({
    to,
    subject,
    html: codeEmailHtml(token, kind, subject),
    text: codeEmailText(token, kind),
  });
  if (!result.success) {
    throw new Error(
      "PureWire can't send emails right now. Please try again in a moment.",
    );
  }
}

/**
 * Shared email code provider used for email verification and password reset.
 * Sends a 6-digit code through PureWire's email service.
 */
function codeEmail(id: string, subject: string, kind: "verify" | "reset") {
  return Email({
    id,
    maxAge: 10 * 60, // 10 minutes
    generateVerificationToken: generateSixDigitToken,
    sendVerificationRequest: ({ identifier, token }) =>
      sendCodeEmail(identifier, subject, token, kind),
  });
}

export const EmailVerification = codeEmail(
  "email-verification",
  "Verify your PureWire email",
  "verify",
);

export const PasswordReset = codeEmail(
  "password-reset",
  "Reset your PureWire password",
  "reset",
);
