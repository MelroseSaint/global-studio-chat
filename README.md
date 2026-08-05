# PureWire — Say it anyway.

A social platform built around expression, connection, and freedom — not
advertising, corporate sponsorships, or telling people how they're supposed
to participate.

Other platforms tell you what you can say. PureWire gives you the space to
say it.

---

## The PureWire promise

- **Say it anyway** — your voice, your words, your way. No ads, no
  algorithms, no corporate curation, no forced trends, no engagement-bait.
- **Verified original** — every post is fingerprinted and checked against
  the platform before it appears. Stolen work and copycats are blocked, and
  posts that pass carry the **Original** badge. Near-duplicates (mirrored
  media, light crops, speed shifts, lightly reworded text) are caught too.
- **Human-made only** — AI-generated text, images, audio, and video are not
  allowed. Every post requires a creator disclosure (**Human-made / AI-assisted
  / AI-generated**). AI-generated is rejected; AI-assisted carries a visible
  disclosure chip and enters human review.
- **No adult platforms** — adult subscription, cam, video, clip, chat, and
  redirect sites are blocked platform-wide with a data-driven domain
  blocklist. Every URL in posts, comments, bios, profile links, stories,
  and DMs is scanned — including redirect chains and obfuscation attempts.
- **No scams or phishing** — links and phrasing that try to harvest
  accounts, passwords, or money are blocked platform-wide, including in
  profile links and before direct messages are encrypted.
- **No racial or ethnic hate** — a multi-layered prevention engine with
  Unicode confusable detection, leetspeak normalization, spacing/obfuscation
  detection, and contextual analysis. Prohibited content is blocked before
  it goes live; ambiguous content enters human review.
- **Real people** — email verification at signup, verified badges for
  notable accounts, and no guest accounts. Sign in with your password;
  one-time email codes verify your account and secure password resets.
- **Sessions persist until you sign out** (up to 10 years) — PureWire does
  not log you out automatically.
- **No algorithm, your choice** — the feed is **Global, Following, Latest,
  Local, and Photos & videos**. You choose what you see.
- **Freedom with a reason** — PureWire isn't "no rules." The PureWire
  Standard draws the lines so one person's freedom never costs another's.

## What you can do on PureWire

- Post your original text, photos, videos, and audio
- Share 24-hour stories with a built-in viewer
- Follow people and build your own circle — search followers and following
- Like, comment, share, and @mention (multiple tags supported)
- Pick your feed: **Global | Following | Latest | Local | Photos & videos**
- Send **direct messages** — end-to-end encrypted, readable only on the
  devices of the people in the conversation
- Get notified on likes, comments, follows, shares, and mentions
- Build a profile with a banner, bio, and links to your other platforms
- Open a **support ticket** — reports capture the post, the user, and the
  Standard principle violated
- Report AI content, phishing, racism, and other violations with one tap
- **Verified badges** for authentic, notable accounts
- Install PureWire as a **PWA** — works offline, on any device, adapts from
  phones to tablets to desktops

## Content moderation pipeline

Every piece of content goes through the same pipeline before it goes live:

```
User submits content
       ↓
AI / originality / safety / phishing / prohibited-domain / racism checks
       ↓
Clean → publish
Suspicious → quarantine / human review
Blocked → rejected with an honest reason
```

### AI & deepfake detection

- **Byte-level metadata scan** — structured container parsing for PNG,
  JPEG/EXIF/XMP, MP4 atoms, ID3v2 frames, FLAC Vorbis comments, WebP, GIF.
  Detects AI-generator markers (Midjourney, Stable Diffusion, DALL·E,
  Imagen, etc.) in the file's own metadata.
- **Resemble v2 API** — deepfake detection for images, audio, and video
  with confidence scoring, per-media-type metrics, and audio source tracing
  (identifies ElevenLabs, Resemble, etc.). Gracefully degrades when the
  API key is absent.
- **C2PA / Content Credentials** — verifies C2PA manifests in JPEG APP11,
  PNG iTXt, MP4 jumb, and WebP jumb containers. Camera-capture manifests
  earn a "Content Credentials verified" chip; `trainedAlgorithmicMedia`
  manifests block the file on its own admission.
- **AI evidence panel** — every flagged post/story shows structured
  evidence in the admin review queue: byte scan verdict, Resemble confidence
  bar with source tracing, C2PA provenance + credential issuer, OCR racism
  detection, AI detector signal, creator disclosure, and user report count.
- **Preview media evidence** — admins can run a self-test from the dashboard
  that creates 3 synthetic test images (AI-generated, clean phone photo,
  C2PA camera capture) and runs the full scan pipeline — verifying the
  system is healthy with one click, no file upload needed.

### Prohibited-domain enforcement

- **Data-driven blocklist** — `blockedDomains` table with 12 adult-content
  categories (creator, porn, cam, clips, chat, escort, dating, fetish,
  community, redirect, explicit, other).
- **Domain matching** — exact match, subdomain match, punycode/IDN
  normalization, redirect-chain inspection (up to 5 hops). Every URL in
  posts, comments, stories, bios, profile links, and DMs is scanned.
- **Obfuscation detection** — catches "onlyfans dot com", onlyfans[.]com,
  and other textual evasion attempts.
- **URL shortener resolution** — shorteners are resolved to their
  destination; blocked destinations are caught, clean ones pass through.
- **Admin management** — domain feeds section with enable/disable toggles,
  sync timestamps, per-feed error status, and manual add domain.

### Racism & hate prevention

- **Unicode confusable detection** — catches homoglyph substitutions
  (Cyrillic, Greek, mathematical, full-width lookalikes).
- **Normalization pipeline** — case folding, zero-width character removal,
  whitespace/punctuation normalization, repeated-character collapse,
  leetspeak decoding.
- **Context analysis** — distinguishes hate speech from
  discussion/quotation/reporting/educational context using proximity +
  sentence-boundary detection.
- **Evasion scoring** — combined score from confusable detection,
  fragmentation, leetspeak, character manipulation, and known variant
  matches.
- **Racism review queue** — admin tab showing flagged posts with matched
  category, evasion score, and clear/remove actions citing the Standard.

### Silent moderation

Accounts that keep tripping abuse signals are quietly limited — nothing
errors, their posts still "work" to them, but nothing they do reaches
anyone else until a human reviews. Flags carry points that decay after
clean behavior, and every event lands in the audit trail.

### Data integrity

- **Counter drift detection** — nightly audit verifies `followersCount`,
  `followingCount`, `likeCount`, `commentCount` match their respective
  tables. Orphan rows and stale counters are surfaced and reconciled.
- **Full-spectrum orphan audit** — walks every FK table (notifications,
  tickets, blocks, DMs, likes, comments, follows, stories, removal log)
  and reports rows whose target no longer exists.

## Admin dashboard

The admin dashboard (root admin: **monroedoses@gmail.com**, immutable —
cannot be changed or altered in any way) puts the whole platform in one
place:

| Tab | What it shows |
| --- | --- |
| **Users** | All accounts with role management, verify/unverify, and owner protection |
| **Tickets** | Support tickets with violation, post, author, and AI evidence inline |
| **Content** | Recent posts with moderation actions |
| **AI review** | Flagged posts with structured evidence panel (byte scan, Resemble, C2PA, OCR, AI detector, reports) |
| **Racism** | Posts flagged for racial/ethnic hate with category, evasion score, evidence panel |
| **Stories** | Flagged stories with the same evidence panel as posts |
| **Security** | Suspicious/restricted/banned accounts with audit trail |
| **Silenced** | Shadowbanned accounts with flag history, reason breakdown, lifetime totals |
| **Blocklist** | Domain feeds with toggles, sync status, and manual domain management |

- **Stats strip** — Users, Posts, AI review, Open tickets, Stories at a
  glance. "More stats" expands to show Follows, Likes, Comments, Racism,
  and Security counts.
- **Responsive layout** — scrollable tab row on narrow screens, clean grid
  on tablets and desktops. PWA-native with offline mutation queue.
- **Removal log** — one-way snapshot of removed accounts (username, name,
  email hash, timestamp, admin) — auditable, never resurrectable.
- **Reinstate** — restore moderated accounts with a required reason; the
  member gets a system notification.

## Architecture

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | React + Vite + TypeScript, Tailwind (shadcn/ui components) | PWA, served by Vercel |
| Backend | Convex (TypeScript functions + schema) | Database, auth, moderation, feeds, DMs |
| Media | Cloudinary (primary) with Convex storage fallback | Photos/videos/audio live outside the database |
| Deepfake detection | Resemble v2 API | Image, audio, and video deepfake detection |
| Email | Resend | Verification and password-reset codes |
| Bot check | Cloudflare Turnstile | Human-only email triggers |
| Delivery | Vercel (primary) | `purewire.vercel.app` |

## Privacy & security

- **Salted email hashes** — `SHA-256(salt + normalized email)`, salt
  versioned and rotatable
- **E2E encrypted DMs** — message bodies encrypted on sender's device,
  decrypt only on recipients' devices; server never holds plaintext
- **Client-side media processing** — EXIF/GPS/device metadata stripped
  before upload; videos get a server-side remux pass too
- **No identifying logs** — IP addresses, browser headers, and connection
  metadata are never written to storage
- **Location coarsened to ~1 km** — Local feed works from live browser
  position or home location, never precise
- **Sessions persist until sign-out** — up to 10 years with "Keep me
  signed in" toggle
- **Anti-scraping** — per-account rate limits on all activities

## Setup

Two places hold configuration. See `.env.example` for the complete
annotated reference.

**Frontend (Vercel, build-time):**

| Variable | Purpose |
| --- | --- |
| `VITE_CONVEX_URL` | Convex backend URL |
| `VITE_SITE_URL` | Canonical site URL for share metadata |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |

**Backend (Convex, runtime — `npx convex env set NAME value`):**

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Email delivery |
| `EMAIL_FROM` | Verified sender address |
| `EMAIL_HASH_SALT` | Salt for email hashing |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Signed deletes + video re-uploads |
| `RESEMBLE_API_KEY` | Resemble v2 Bearer token for deepfake detection |
| `TEST_HARNESS_ENABLED` / `TEST_HARNESS_SECRET` | QA harness (disabled in production) |

## QA suite

All scripts runnable locally against the live site:

| Command | What it verifies |
| --- | --- |
| `npm run typecheck` | TypeScript across all source |
| `npm run lint` | ESLint across all source |
| `npm run build` | Production Vite build |
| `npm run qa:secrets` | Scans repo for leaked secrets |
| `npm run qa:ai-scan` | AI scanner byte-level checks (C2PA, EXIF, PNG, MP4, WebP, ID3, FLAC) |
| `npm run qa:ai-scan-integration` | End-to-end upload → scan → evidence pipeline (harness-gated) |
| `npm run qa:racism` | Racism prevention engine (72 adversarial test cases) |
| `npm run qa:phishing` | Phishing scan tiers across all surfaces |
| `npm run qa:blocklist` | Domain blocklist engine (49 checks, harness-gated) |
| `npm run qa:blocklist-sync` | External source synchronization |
| `npm run qa:shadowban` | Silent-moderation escalation paths |
| `npm run qa:reinstate` | Admin reinstatement with audit trail |
| `npm run qa:salt` | Salt-rotation migration idempotency |
| `npm run qa:video-privacy` | GPS-atom stripping on uploaded video |
| `npm run qa:admin-auth` | Admin password sign-in round-trip |
| `npm run qa:admin-responsive` | Admin dashboard at 320/390/768 px widths |
| `npm run qa:pages-inflation` | Page inflation at 800px with root-font-size scaling |
| `npm run qa:cloudinary-health` | Unsigned-preset upload probe |
| `npm run qa:resemble-health` | Resemble v2 API connectivity probe |
| `npm run qa:session-audit` | Session-lifetime guarantees |
| `npm run qa:count-drift` | Data-integrity DQS audit (harness-gated) |
| `npm run qa:cleanup-test-users` | Sweep leftover QA accounts (harness-gated) |

## CI/CD

- **Static Audit** — typecheck, lint, build, secrets scan, and 10+ parallel
  QA jobs on every push to `main`
- **Vercel** — auto-deploys frontend on every push to `main`

---

© PureWire. Say it anyway — no ads, ever.
