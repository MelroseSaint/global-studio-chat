# PureWire — Say it anyway.

A social platform built around expression, connection, and freedom — not
advertising, corporate sponsorships, or telling people how they're supposed
to participate.

Other platforms tell you what you can say. PureWire gives you the space to
say it.

## The PureWire promise

- **Say it anyway** — your voice, your words, your way. No ads, no
  algorithms, no corporate curation, no forced trends.
- **Verified original** — every post is fingerprinted and checked against the
  platform before it appears. Stolen work and copycats are blocked, and posts
  that pass carry the **Original** badge.
- **Human-made only** — AI-generated text, images, audio, and video are not
  allowed. Posts are scanned for AI text patterns and AI-generator image
  metadata at creation; suspicious content goes to a human review queue.
- **Highest-moderation trust & safety** — new accounts are screened against
  bot and farm signals at signup, every activity runs on a rate budget, media
  is checked for deepfake and AI-generator markers, and anyone can block
  harassers. Restricted or banned accounts are hidden platform-wide, and
  accounts that keep tripping abuse signals are quietly limited — nothing
  errors, their content simply stops reaching anyone until a human reviews.
- **Freedom with a reason** — PureWire isn't "no rules." The PureWire
  Standard draws the lines (no impersonation, no stealing work, no spam, no
  harassment) so one person's freedom never costs another's.
- **No algorithm, your choice** — the feed is Global, Following, Latest, and
  Photos & videos. You choose what you see.
- **Real people** — email verification at signup, verified badges for notable
  accounts, and no guest accounts. Sign in with your password; one-time codes
  verify your account and secure password resets.
- **Your profile, your way** — upload your photo and banner, write a bio, and
  link your other socials.

## What you can do on PureWire

- Post your original text, photos, videos, and audio
- Share 24-hour stories with a built-in viewer
- Follow people and build your own circle
- Like, comment, share, and @mention
- Pick your feed: Global, Following, Latest, Photos & videos
- Get notified on likes, comments, follows, shares, and mentions
- Build a profile with a banner, bio, and links to your other platforms
- Open a support ticket — reports include the post, the user, and what was
  violated
- Verified badges for authentic, notable accounts

## The PureWire Standard

Say what you mean. Create what you want. Find your people. Disagree without
destroying each other. Don't impersonate people. Don't steal people's work.
Don't spam the platform. Don't use freedom as an excuse to take someone
else's freedom away.

## Brand

- **Palette** — Wire Black `#171918` (strength), Paper `#F4F0E8` (space),
  Oxide `#B84A32` (expression), Moss `#465A4C` (grounding), Copper `#C97952`
  (accent).
- **Slogan** — *Say it anyway.*

## Bot & identity defenses

PureWire stops inbox-abuse at signup with two layered defenses:

- **One inbox = one badge.** Email identity is canonicalized before it is
  hashed — Gmail/Googlemail dots and `+tag` sub-addressing are stripped, so
  `user@gmail.com`, `u.ser@gmail.com`, and `user+spam1@gmail.com` all resolve
  to the same inbox and can only ever claim one verified account badge.
- **Human-only email triggers.** Sign-up, sign-in, forgot-password, and
  password-reset flows run through a Cloudflare Turnstile check when it is
  configured. To enable:
  1. Create a free Turnstile widget at
     https://dash.cloudflare.com/?to=/:account/turnstile (one site key + one
     secret key).
  2. Add the **site key** to the deploy environment as `VITE_TURNSTILE_SITE_KEY`
     (in `.env.production` or your Vercel env).
  3. Add the **secret key** to Convex env — never to the repo:
     `npx convex env set TURNSTILE_SECRET_KEY <secret-key>`

  Until the site key is set the widget is not loaded and signups are still
  protected by email normalization, signup risk scoring, and per-account rate
  limits. With the keys set, the widget renders on the auth forms and the
  server verifies each token before any verification or reset email is sent.

## Privacy, safety & network security

PureWire treats privacy and safety as architecture, not add-ons. How each
layer works:

### Data privacy

- **Salted email hashes.** An address is stored only as `SHA-256(salt + email)`.
  The salt is a random server-side secret from Convex env, never sent to
  clients, so a leaked database is useless against lookup tables. Configure it:

      npx convex env set EMAIL_HASH_SALT <long random hex>

  Without a salt the hash degrades to plain SHA-256 so local dev keeps working
  — production must set one.

- **No persistent identifying logs.** The application never writes IP
  addresses, browser headers, or connection metadata to storage. Edge-level
  logging (if any) is configured at the hosting layer, not in the app.

- **Ephemeral auth state.** Sign-in sessions and one-time codes are short-lived
  and scoped to the auth service; nothing user-identifying is persisted beyond
  what the platform needs to function.

### Media privacy (anti-doxing)

- **Client-side processing before upload.** Photos are re-encoded in the user's
  own browser (`src/lib/media.ts`): EXIF/GPS/device metadata is stripped, the
  image is downscaled to at most 2048px and compressed.  Raw camera files with
  hidden location data never reach PureWire's servers.
- **Scan-before-strip.** The original bytes are scanned for AI-generator and
  deepfake markers *before* stripping (`src/lib/ai-media-scan.ts`, shared with
  the server action), so removing metadata can never also remove the evidence
  that media was machine-made.
- **Videos/audio** pass through client-side (no heavy browser transcoding) and
  are scanned server-side for AI-generator markers before going live. Video
  container metadata (e.g. MP4 GPS atoms) is not stripped in the browser — a
  known, documented limitation of client-only processing.

### Anti-scraping & creator protection

- **Per-account rate limits** on posts, comments, likes, follows, shares, and
  media uploads (`src/convex/security.ts`) blunt automated floods.
- **Human-only bot checks** — Cloudflare Turnstile on every email trigger
  (signup, sign-in, forgot/reset password).
- **Signup risk scoring** flags bot/farm signals (disposable domains, pattern
  usernames, placeholder names) for human review; suspicious accounts are kept
  off public feeds until approved.
- **IP reputation and headless-crawler defenses** require edge/hosting
  configuration (Cloudflare or Vercel Firewall bot/IP rules) where the network
  signals live. That config lives at the hosting provider, not in this repo;
  in-app protections cover the write path (Turnstile, risk scoring, rate
  limits), while read-side scraping defense is a hosting-edge item.

### Storage isolation & delivery

- **Media lives in isolated storage, not the database.** The DB holds only
  `storageId` references; files are stored separately and delivered through
  read-only signed CDN URLs (`ctx.storage.getUrl`). Users never touch the core
  database when viewing media.

### Network hardening

- **TLS 1.3 end-to-end** and **DDoS scrubbing** are provided by the hosting
  edge (Vercel/Convex).
- **Security headers** are set in `vercel.json` (Vercel host): HSTS
  (`max-age=63072000; includeSubDomains; preload`), `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a
  `Permissions-Policy` that denies camera/microphone and interest cohort.
  The `convex.site` static-hosting host is a preview surface and does not
  carry custom headers.

© PureWire. Say it anyway — no ads, ever.
