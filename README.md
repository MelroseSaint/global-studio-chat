# PureWire — Say it anyway.

A social platform built around expression, connection, and freedom — not
advertising, corporate sponsorships, or telling people how they're supposed
to participate.

Other platforms tell you what you can say. PureWire gives you the space to
say it.

**PureWire — Say It Anyway.**

A social platform built around expression, connection, and freedom — not
advertising, corporate sponsorships, or telling people how they're supposed
to participate.

That is the north star for the UI, color system, copy, onboarding, feeds,
profiles, creator tools, moderation, and everything in between.

---

## The PureWire promise

- **Say it anyway** — your voice, your words, your way. No ads, no
  algorithms, no corporate curation, no forced trends, no engagement-bait.
- **Verified original** — every post is fingerprinted and checked against
  the platform before it appears. Stolen work and copycats are blocked, and
  posts that pass carry the **Original** badge. Near-duplicates (mirrored
  media, light crops, speed shifts, lightly reworded text) are caught too.
- **Human-made only** — AI-generated text, images, audio, and video are not
  allowed. Content is scanned for AI text patterns, AI-generator metadata,
  and deepfake markers; suspicious content goes to a human review queue
  with an honest "why" shown to the author.
- **No scams or phishing** — links and phrasing that try to harvest
  accounts, passwords, or money are blocked platform-wide, including in
  profile links and before direct messages are encrypted.
- **Real people** — email verification at signup, verified badges for
  notable accounts, and no guest accounts. Sign in with your password;
  one-time email codes verify your account and secure password resets.
- **No algorithm, your choice** — the feed is **Global, Following, Latest,
  Local, and Photos & videos**. You choose what you see.
- **Freedom with a reason** — PureWire isn't "no rules." The PureWire
  Standard draws the lines (no impersonation, no stealing work, no spam, no
  harassment) so one person's freedom never costs another's.
- **Your profile, your way** — upload your photo and banner, write a bio,
  and link your other socials.
- **Highest-tier moderation & security** — new accounts are screened
  against bot and farm signals, every activity runs on a rate budget, and
  abusers are quietly limited or removed. Protecting users is the top
  priority.

## What you can do on PureWire

- Post your original text, photos, videos, and audio — media is
  re-encoded in your browser so it stays high quality but small
- Share 24-hour stories with a built-in viewer
- Follow people and build your own circle
- Like, comment, share, and @mention (multiple tags supported)
- Pick your feed: **Global | Following | Latest | Local | Photos & videos**
- The **Local** tab shows posts near you — from live browser location or a
  home location set in Settings, always coarsened to ~1 km so your exact
  point is never stored
- Send **direct messages** — end-to-end encrypted, readable only on the
  devices of the people in the conversation
- Get notified on likes, comments, follows, shares, and mentions
- Build a profile with a banner, bio, and links to your other platforms
- Open a **support ticket** — reports capture the post, the user, and the
  Standard principle violated
- **Verified badges** for authentic, notable accounts
- Install PureWire as a **PWA** — it works offline, on any device, with a
  layout that adapts from phones to tablets to desktops

## For admins

The admin dashboard (root admin: **monroedoses@gmail.com**) puts the whole
platform in one place:

- **Security queue** — suspicious signups, restricted, and banned accounts,
  newest first
- **Silenced tab** — quietly shadowbanned accounts, with each account's
  flag history, reason breakdown (duplicates vs AI flags vs rate limits vs
  farm signals), lifetime flag total, and bulk unsilence
- **Full audit trail** — every moderation action records who, when, and the
  cited Standard principle; every shadowban event records its trigger,
  points, and source
- **Remove account** — permanent removal with a required Standard citation,
  preceded by a one-way snapshot into the removal log ("who was removed,
  when, by whom") — nothing is ever resurrected
- **Reinstate** — restore a moderated account with a required reason; the
  member gets a "welcome back" system notification
- **Support tickets** — every report, bug, and question lands here with the
  post, author, and violated rule attached
- **Badge & role controls** — verify badges and manage admin roles, except
  for the owner account, which cannot be changed or altered in any way

## The PureWire Standard

Say what you mean. Create what you want. Find your people. Disagree without
destroying each other. Don't impersonate people. Don't steal people's work.
Don't spam the platform. Don't use freedom as an excuse to take someone
else's freedom away.

The Standard is wired into the actual moderation flow: every report dialog,
admin action, and removal cites the specific principle violated.

## Brand

- **Palette** — Wire Black `#171918` (independence and strength), Paper
  `#F4F0E8` (openness and space), Oxide `#B84A32` (rebellion and
  expression), Moss `#465A4C` (grounding), Copper `#C97952` (secondary
  accent).
- **Mark** — the "open wire P": a paper wire draws the letter P but the
  bowl never closes, with an oxide spark in the opening — the voice that
  completes the letter. A copper broadcast arc carries the signal outward.
- **Slogan** — *Say it anyway.*

---

## Architecture

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | React + Vite + TypeScript, Tailwind (shadcn/ui-style components) | PWA, served by Vercel |
| Backend | Convex (TypeScript functions + schema) | Database, auth, moderation, feeds, DMs |
| Media | Cloudinary (primary) with Convex storage fallback | Photos/videos/audio live outside the database |
| Email | Resend | Verification and password-reset codes, branded template |
| Bot check | Cloudflare Turnstile | Human-only email triggers |
| Delivery | Vercel (primary) + Convex static hosting (preview) | `purewire.vercel.app` / `outgoing-seal-727.convex.site` |

## Privacy, safety & network security

PureWire treats privacy and safety as architecture, not add-ons.

### Data privacy

- **Salted email hashes.** An address is stored only as
  `SHA-256(salt + normalized email)`. The salt is a random server-side
  secret from Convex env, never sent to clients, so a leaked database is
  useless against lookup tables. The salt is **versioned** — a compromised
  salt can be rotated and every existing hash re-salted in one pass:
  `npx convex run internal.migrations.rehashEmailHashes`.
- **One inbox = one badge.** Email identity is canonicalized before
  hashing — Gmail/Outlook dots and `+tag` sub-addressing are stripped, so
  `user@gmail.com`, `u.ser@gmail.com`, and `user+spam1@gmail.com` resolve
  to the same inbox and can only ever claim one verified account badge.
- **No identifying logs.** The application never writes IP addresses,
  browser headers, or connection metadata to storage.
- **Coordinates are treated like email.** Home-location labels are public,
  but the coordinates are sensitive: the Local feed uses a ~1 km coarsened
  anchor, and "show posts near me" works as a while-browsing mode that
  never persists your live position.

### Sessions

- **Sessions persist until you sign out** (up to 10 years) — PureWire does
  not log you out automatically. A "Keep me signed in" toggle opts a device
  into the permanent session; turning it off caps that device at 30 days.
  Settings shows when the current session was created and can end the
  session everywhere else at once.

### Media privacy (anti-doxing)

- **Client-side processing before upload.** Photos are re-encoded in the
  user's own browser: EXIF/GPS/device metadata is stripped, images are
  downscaled and compressed to stay high quality yet small — so thousands
  of uploads don't eat storage. Raw camera files with hidden location data
  never reach the servers.
- **Scan-before-strip.** The original bytes are scanned for AI-generator
  and deepfake markers *before* stripping, so removing metadata can never
  also remove the evidence that media was machine-made.
- **Videos get a server-side pass too.** MP4/MOV GPS and device atoms are
  stripped by a server-side remux step shortly after upload, closing the
  client-only gap. A tiny **"Metadata stripped"** note appears next to
  processed media.
- **Media lives outside the database.** With Cloudinary configured, the
  browser uploads straight to an unsigned preset and Convex stores only the
  secure URL — thousands of files never touch Convex storage. Without it,
  media falls back to Convex's built-in storage.

### Direct messages

- **End-to-end encrypted.** Message bodies are encrypted on the sender's
  device and decrypt only on recipients' devices — the server never holds
  plaintext, so DMs cannot be pulled by anyone, including platform staff or
  legal process.
- **Phishing check before encryption.** Outgoing messages are scanned
  client-side for scam links before they're encrypted, so blocked links
  can't be sent while the server still never sees the message.

### Anti-scraping & creator protection

- **Per-account rate limits** on posts, comments, likes, follows, shares,
  media uploads, DMs, and tickets.
- **Human-only bot checks** — Cloudflare Turnstile on every email trigger
  (signup, sign-in, forgot/reset password).
- **Signup risk scoring** flags bot/farm signals (disposable domains,
  pattern usernames, placeholder names) for human review; suspicious
  accounts are kept off public feeds until approved.

### Content integrity

- **Originality fingerprinting.** Exact text copies are caught by a
  fingerprint; near-duplicates by word-shingle similarity and perceptual
  hashing of media that survives mirror flips, light crops, re-encodes, and
  speed shifts.
- **AI detection.** Text is scored for machine patterns; media is checked
  for C2PA/SynthID-style generator metadata. Self-identified AI is blocked;
  suspicious content enters a human review queue — and the author is told
  honestly why their post is being checked, so genuine creators are never
  left wondering.
- **Phishing & account-integrity bans.** Known scam phrasing and untrusted
  link hosts are hard-blocked across posts, comments, stories, profile
  links, and DMs. Suspicious-but-unclear links go to human review. Members
  get a one-tap **Report phishing** action that files a ticket pre-attached
  to the content.

### Silent moderation

Accounts that keep tripping abuse signals are quietly limited — nothing
errors, their posts still "work" to them, but nothing they do reaches
anyone else until a human reviews. Flags carry points (duplicates, AI
attempts, rate-limit breaches, farm-network patterns like instant mutual
follows and follow/unfollow churn) that decay after clean behavior, and
every event lands in the audit trail. The Silenced tab makes all of it
visible to admins: history, reason breakdown, and lifetime totals.

---

## Setup

Two places hold configuration, and a deploy fails if either is incomplete.
See `.env.example` for the complete annotated reference.

**Frontend (Vercel, build-time, public `VITE_*`):**

| Variable | Purpose |
| --- | --- |
| `VITE_CONVEX_URL` | Convex backend URL (already committed in `.env.production`) |
| `VITE_SITE_URL` | Canonical site URL for share metadata |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (optional) |

**Backend (Convex, runtime, secret — set with `npx convex env set NAME value`):**

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Email delivery (verification + reset codes) |
| `EMAIL_FROM` | Verified sender address for PureWire emails |
| `EMAIL_HASH_SALT` | Long random hex for salted email hashing (required in production) |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification (required if the site key is set) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset for media (recommended) |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Signed deletes and video re-uploads |
| `TEST_HARNESS_ENABLED` / `TEST_HARNESS_SECRET` | QA harness — disabled in production on purpose |

## QA suite

The platform ships a production QA suite, runnable locally against the live
site:

| Command | Checks |
| --- | --- |
| `npm run qa:secrets` | Scans the repo for leaked secrets |
| `npm run qa:shadowban` | Silent-moderation escalation paths (duplicate, AI, rate limit) |
| `npm run qa:phishing` | Phishing scan tiers across surfaces |
| `npm run qa:reinstate` | Admin reinstate with required reason + audit trail |
| `npm run qa:salt` | Salt-rotation migration idempotency |
| `npm run qa:video-privacy` | GPS-atom stripping on uploaded video |
| `npm run qa:admin-auth` | Admin password sign-in round-trip + wrong-password rejection |
| `npm run qa:admin-auth-browser` | Browser-driven sign-in through the real auth UI |
| `npm run qa:admin-responsive` | Admin dashboard at 320/390/768 px widths |
| `npm run qa:signup-e2e` | Full sign-up → OTP → forgot/reset → post-with-media loop |
| `npm run qa:cloudinary-health` | Unsigned-preset upload probe |
| `npm run qa:session-lifetime` / `qa:session-audit` | Session-lifetime guarantees |
| `npm run qa:prod-pipeline` | End-to-end production pipeline verification |

## CI/CD

Three GitHub Actions workflows run on `main`:

- **Static Audit** — typecheck, lint, production build, Convex function
  typecheck, salt QA, and a secrets scan on every push.
- **Production Health Check** — the sign-up E2E auth loop against the live
  site, nightly and on every push, alerting on failure.
- **Deploy to Vercel** — ships the frontend to production on every push to
  `main`.

The backend deploys with `npx convex deploy`; a pre-push git hook verifies
commit authorship so a wrong email can never block a deploy.

---

© PureWire. Say it anyway — no ads, ever.

Legal contact: `legal@purewire.com` · DMCA: `dmca@purewire.com`
