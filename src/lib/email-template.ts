/**
 * PureWire branded email template.
 *
 * Renders the one-time-code emails (email verification and password reset)
 * in the platform's own visual identity — Wire Black, Paper, Oxide, Moss and
 * Copper — instead of the bare text they used to ship as.
 *
 * Gmail-compatible on purpose:
 *  - inline styles only (Gmail strips <style> in the body and ignores many
 *    embedded rules), table-based layout, no JavaScript, no flex/grid;
 *  - no SVG in the markup — the logo mark is hot-linked as a PNG so it
 *    renders in Gmail's client (which blocks SVG <img>);
 *  - a `color-scheme` meta so Gmail's dark mode can flip the background.
 *
 * The sender domain (EMAIL_FROM) and the site URL must be absolute for
 * images and links to resolve when the user opens the message.
 */

/** The platform's site URL, used for the logo, the Standard link and footer. */
function siteUrl(): string {
  return (
    process.env.SITE_URL ??
    process.env.CONVEX_SITE_URL ??
    "https://outgoing-seal-727.convex.site"
  );
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Build the full HTML document for a one-time code email.
 *
 * @param token  the 6-digit code the recipient must enter
 * @param kind   "verify" (email verification on sign-up) or "reset"
 * @param subject the email subject line, used as the in-body headline
 */
export function codeEmailHtml(
  token: string,
  kind: "verify" | "reset",
  subject: string,
): string {
  const base = siteUrl();
  const logo = `${base}/icon-192.png`;

  const headline = kind === "verify" ? "Confirm it's you" : "Reset your password";
  const intro =
    kind === "verify"
      ? "You're one step away from your PureWire account. Enter this code to verify your email and get in."
      : "A password reset was asked for on your PureWire account. Enter this code to choose a new password.";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${subject}</title>
<style>
  /* Dark-mode fallbacks for clients that honor embedded rules (Gmail in-app
     dark mode, Apple Mail). The light layout is inline-styled and primary. */
  @media (prefers-color-scheme: dark) {
    .pw-body { background-color: #171918 !important; }
    .pw-card { background-color: #1f2120 !important; border-color: #2a2d2b !important; }
    .pw-ink { color: #f4f0e8 !important; }
  }
</style>
</head>
<body class="pw-body" style="margin:0;padding:0;background-color:#F4F0E8;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F0E8;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
          <!-- Oxide rule -->
          <tr>
            <td style="height:4px;background-color:#B84A32;border-radius:2px 2px 0 0;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- Card -->
          <tr>
            <td class="pw-card" style="background-color:#FFFFFF;border:1px solid #E7E0D2;border-top:none;border-radius:0 0 16px 16px;padding:32px 32px 28px;">
              <!-- Header: mark + wordmark + tagline -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <img src="${logo}" alt="PureWire" width="44" height="44" style="display:block;margin:0 auto 12px;border:0;border-radius:10px;" />
                    <span class="pw-ink" style="font-family:${FONT_STACK};font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#171918;">PureWire</span>
                    <div style="font-family:${FONT_STACK};font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#B84A32;margin-top:6px;">Say it anyway.</div>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:20px 0 24px;">
                    <div style="border-top:1px solid #E7E0D2;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                </tr>
              </table>

              <!-- Headline + intro -->
              <h1 class="pw-ink" style="margin:0 0 12px;font-family:${FONT_STACK};font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#171918;text-align:center;">${headline}</h1>
              <p class="pw-ink" style="margin:0 0 24px;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:#4a4f4c;text-align:center;">${intro}</p>

              <!-- Code box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:0 8px 24px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="background-color:#171918;border:1px solid #171918;border-radius:12px;">
                      <tr>
                        <td style="padding:18px 36px;">
                          <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:30px;font-weight:700;letter-spacing:0.35em;color:#F4F0E8;text-align:center;text-indent:0.35em;">${token}</div>
                        </td>
                      </tr>
                    </table>
                    <div style="font-family:${FONT_STACK};font-size:12px;color:#6b6f6c;margin-top:12px;">This code expires in 10 minutes.</div>
                  </td>
                </tr>
              </table>

              <!-- The PureWire Standard -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#F4F0E8;border-radius:12px;padding:18px 20px;">
                    <div style="font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#465A4C;margin-bottom:6px;">The PureWire Standard</div>
                    <p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:14px;line-height:1.5;color:#171918;">Freedom with a reason. Say what you mean, create what you want, find your people — and never use freedom to take someone else's away.</p>
                    <a href="${base}/#standard" style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#B84A32;text-decoration:underline;">Read the Standard&nbsp;→</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 16px 8px;">
              <p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#465A4C;">
                This email was sent because someone tried to ${kind === "verify" ? "create a PureWire account" : "reset the password"} for this address.<br>
                Didn't do this? You can safely ignore this message.
              </p>
              <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#465A4C;">
                <a href="${base}/privacy" style="color:#465A4C;text-decoration:underline;">Privacy</a>
                &nbsp;·&nbsp;
                <a href="${base}/terms" style="color:#465A4C;text-decoration:underline;">Terms</a>
                &nbsp;·&nbsp;
                <a href="${base}/support" style="color:#465A4C;text-decoration:underline;">Support</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Plain-text fallback for clients that refuse HTML. */
export function codeEmailText(
  token: string,
  kind: "verify" | "reset",
): string {
  const base = siteUrl();
  const line =
    kind === "verify"
      ? "Your PureWire verification code is:"
      : "Your PureWire password reset code is:";
  return `${line} ${token}

It expires in 10 minutes.

PureWire — Say it anyway.
Freedom with a reason: read the PureWire Standard at ${base}/#standard

If you didn't request this, you can safely ignore this email.`;
}
