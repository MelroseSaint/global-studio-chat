import { Resend } from "resend";

/**
 * PureWire's email service client (Resend).
 *
 * Sends verification and password-reset emails through Resend using a single
 * API key (RESEND_API_KEY, set on the Convex deployment). The sender address
 * (EMAIL_FROM) must be a domain verified in the Resend dashboard — until a
 * domain is verified, Resend only allows sending to your own inbox from
 * onboarding@resend.dev. Used only inside Convex actions.
 *
 * sendEmail never throws: it returns { success, error } so callers decide how
 * to surface a failure.
 */
const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? "PureWire <noreply@purewire.com>";
const resend = apiKey ? new Resend(apiKey) : null;

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!resend) {
    return {
      success: false,
      error: "Email service is not configured (RESEND_API_KEY missing).",
    };
  }
  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html,
      text,
    });
    if (error || !data?.id) {
      return { success: false, error: error?.message ?? "Email send failed." };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
