import { Email } from "@convex-dev/auth/providers/Email";

import { integrations } from "@/lib/email-service";

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
) {
  const result = await integrations.email.send({
    to,
    subject,
    html: `<p>Your PureWire code is</p>
<p style="font-size: 24px; font-weight: 700; letter-spacing: 4px;">${token}</p>
<p>This code expires in 10 minutes.</p>`,
    text: `Your PureWire code is ${token}. It expires in 10 minutes.`,
  });
  if (!result.success) {
    throw new Error(result.error ?? "Failed to send email.");
  }
}

/**
 * Shared email code provider used for email verification and password reset.
 * Sends a 6-digit code through PureWire's email service.
 */
function codeEmail(id: string, subject: string) {
  return Email({
    id,
    maxAge: 10 * 60, // 10 minutes
    generateVerificationToken: generateSixDigitToken,
    sendVerificationRequest: ({ identifier, token }) =>
      sendCodeEmail(identifier, subject, token),
  });
}

export const EmailVerification = codeEmail(
  "email-verification",
  "Verify your PureWire email",
);

export const PasswordReset = codeEmail(
  "password-reset",
  "Reset your PureWire password",
);
