# PureWire — Say it anyway.

A social platform built around expression, connection, and freedom — not
advertising, corporate sponsorships, or telling people how they're supposed
to participate.

Other platforms tell you what you can say. PureWire gives you the space to
say it.

---

## Documentation

Beyond this README, the repo keeps its knowledge structured:

| Where | What |
| --- | --- |
| [`docs/`](docs/) | Documentation index — architecture, setup, CI/CD, and the ADR log |
| [`docs/architecture.md`](docs/architecture.md) | System overview: layers, source map, content pipeline, deployment topology, invariants |
| [`docs/setup.md`](docs/setup.md) | Straightforward setup steps — clone → install → run → QA → deploy |
| [`docs/ci-cd.md`](docs/ci-cd.md) | The six GitHub Actions workflows, the alert model, and required secrets/vars |
| [`docs/adr/`](docs/adr/) | Architectural decision records — every consequential decision and why |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | PR workflow, commit conventions, and clean-history rules |

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
- **Profile identity, your declaration** — every account picks a profile
  type (**Creator** or **User**) during onboarding; the choice is required,
  never assigned silently, and changeable any time in Settings. A small
  badge next to the name shows the declaration across profiles, posts,
  comments, replies, search results, follow lists, and messaging — and it
  implies nothing about verification, originality, fame, or endorsement
  (those stay separate systems).
- **Sessions persist until you sign out** (up to 10 years) — PureWire does
  not log you out automatically.
- **No algorithm, your choice** — the feed is **Global, Following, Latest,
  Local, and Photos & videos**. You choose what you see.
- **Free, no hidden fees** — PureWire is free to join and use: no
  subscription, no paywall, no premium tier, no ads, no sponsorships, and
  no pay-to-post anywhere.
- **Freedom with a reason** — PureWire isn't "no rules." The PureWire
  Standard draws the lines so one person's freedom never costs another's.

## What you can do on PureWire

- Post your original text, photos, videos, and audio
- Share 24-hour stories with a built-in viewer
- Follow people and build your own circle — search followers and following
- Like, comment, share, and @mention (multiple tags supported)
- Comment from an in-place **popup** — no page redirect — with a preview of
  the thread's best replies, **Top** (ranked by likes) and **Newest**
  sorts, comment likes shown as plain language ("3 likes" / "Like"),
  threaded replies, and edit/delete for your own comments
- Share a post **into another post's comments** as a preview card — attach
  it from any comment composer (paste a PureWire post link and it is
  **auto-detected**), the Share dialog, or a `?share=` deep link
- Search **every registered member** by their exact **@handle** — or by
  name or partial handle — from Messages and Discover, even accounts that
  registered after the first few hundred
- Pick your feed: **Global | Following | Latest | Local | Photos & videos**
- Send **direct messages** — end-to-end encrypted, readable only on the
  devices of the people in the conversation — from a **popup composer**
  (no redirect), and share any post into a message with a live preview
  card
- Get notified on likes, comments, replies, follows, shares, DMs, and
  post-shares into your DMs or your post's comments
- Build a profile with a banner, bio, and links to your other platforms
- Open a **support ticket** — reports capture the post, the user, and the
  Standard principle violated
- Report AI content, phishing, racism, and other violations with one tap
- **Verified badges** for authentic, notable accounts
- Install PureWire as a **PWA** — works offline, on any device, adapts from
  phones to tablets to desktops, and ships store-style install screenshots
  in its manifest

> Everything you can do on PureWire — and what it costs (nothing) — is
> spelled out on the public [`/about`](https://purewire.vercel.app/about)
> page, reachable from the Landing, Settings, and Help without an account.

## Comments & threads

Commenting is a first-class conversation surface, not a redirect:

- **Comment popup** — opens over the post (from any post card) with a
  preview of the thread's best replies, the post's own like and comment
  counts, and a composer. A small **View comments** link next to the
  comment count still takes you to the full post page for the whole thread.
- **Top sort** — ranks comments by like count (highest first) with a
  deterministic tiebreak, so the preview and the thread surface the best
  replies. A **Newest** sort is one tap away. The like tally is
  denormalized per comment (same counter discipline as posts) and kept
  consistent by an automated backfill migration.
- **Engage** — like/unlike any comment, reply to comments (replies hang
  one level deep under the top-level comment), and edit or delete your own
  comments, with reply counts kept in sync.
- **Voice notes** — record up to 60 seconds from the mic or attach an
  audio file (under 10 MB) in any comment composer — popup, post page, or
  inline replies. The clip is scanned for AI/deepfake markers before
  upload, stored in Cloudinary (Convex holds only the reference), and
  plays back in the thread with the native PureWire audio player. Each
  voice note shows a measured **duration chip** (e.g. `0:42`) next to the
  player and can carry an optional **description** typed by the author,
  rendered beneath the player. A voice-note-only comment is allowed —
  empty husks are not.
- **Audio post titles** — audio posts carry an optional title (the
  author's chosen text always wins over file metadata) shown prominently
  above the post's player.

## Editing content

- **Posts** — the original poster can edit a post's text body from the
  card's overflow menu (media and the creator disclosure stay as posted).
  Edits are re-scanned through the same AI / blocklist / adult / racism
  gates as new posts — an edit is never a way to smuggle content past
  moderation — and the card shows a small **"· edited"** note next to the
  timestamp.
- **Comments** — the author can edit their own comments from the comment
  menu; voice notes stay attached, and the thread shows an "edited" note.

## Sharing posts

Posts travel as preview cards — in DMs and in comments — with one shared
component and one privacy model: the post *id* travels as public metadata
(like the sender or timestamp); any caption stays encrypted in DMs or plain
text in comments.

- **Share into a DM** — "Send via message" on any post (Share dialog) opens a
  **popup New message composer** over the current page: pick a conversation
  or search any user, see the live preview card (with a remove button),
  and send end-to-end encrypted without leaving the page. The recipient's
  thread renders the card with its media (video autoplays muted with full
  user controls) and a working **View post** link. The profile page's
  Message button opens the same popup pre-targeted at that user.
- **Share into a comment** — "Share in a comment" (Share dialog) or
  **Attach a post** in any comment composer (post page, comment popup,
  inline replies). Paste a PureWire post link straight into the comment
  text and it is **auto-detected** and offered as a card: attach strips
  the link from the draft, dismiss hides the offer until the link leaves
  the text. `?share=<postId>` deep links arm the composer directly, and a
  card-only comment (no text) is allowed — empty husks are not.
- **Cards degrade gracefully** — a shared post deleted, blocked, or
  silenced later shows "This post is no longer available" through the
  normal visibility rules instead of a broken link.
- **Bell notifications** — sharing a post into a DM pings the recipient
  with "shared a post with you" (Open lands on the exact conversation);
  sharing into your post's comments pings you with "shared a post in your
  post's comments" (previewing the shared post, View opens the thread).
  Both are distinct notification types (`dm-share` / `comment-share`) that
  light the unread badge like any other notification.

## Sharing comments

Comments travel as cards too — any kind (text, voice note, or reply) can
be shared into another post's comments or sent directly into a DM:

- **Share button on every comment** — popup dialog, post page, and inline
  replies all offer **Share** next to Reply, so no matter where a comment
  lives it can be passed along.
- **Pick from your recent comments** — the Share dialog lists your most
  recent comments (newest first, with voice-note and reply markers);
  opening Share on a specific comment preselects it, and a switcher lets
  you choose a different one.
- **Into another post's comments** — paste a PureWire post link (or
  quick-pick a recent post) and the original comment lands as a card in
  that thread, rendered through the normal visibility rules (a deleted or
  blocked original shows "no longer available", never a broken card).
  Sharing onto the comment's own post is rejected — it would be a
  pointless self-copy.
- **Into a DM** — "Send via message" opens the same popup composer as
  post-shares with the comment card attached; only the reference is
  metadata, any caption stays end-to-end encrypted.
- **Bell notifications** — sharing a comment into a DM or your post's
  comments pings the recipient with "shared a comment with you" / "shared
  a comment in your post's comments" (previewing the original comment).
- **No dangling cards** — deleting a comment sweeps every reference to it
  (thread cards and DM cards), and the nightly purge covers the same
  class for notification previews.

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
  JPEG/EXIF/XMP, MP4 atoms, ID3v2 frames, FLAC Vorbis comments, WebP, GIF,
  and WAV LIST-INFO. Detects AI-generator markers (Midjourney, Stable
  Diffusion, DALL·E, Imagen, etc.) in the file's own metadata, with the
  audio side covering TTS/voice-clone watermarks too — ElevenLabs,
  PlayHT, Resemble, Speechify, Amazon Polly, Azure/Google/OpenAI neural
  TTS, and voice-clone phrasing — tiered so unambiguous tool signatures
  block while bare brand mentions go to human review. ID3 TXXX/COMM and
  UTF-16 text are decoded so those watermarks can't hide.
- **C2PA / Content Credentials** — verifies C2PA manifests in JPEG APP11,
  PNG iTXt, MP4 jumb, and WebP jumb containers. Camera-capture manifests
  earn a "Content Credentials verified" chip; `trainedAlgorithmicMedia`
  manifests block the file on its own admission.
- **AI evidence panel** — every flagged post/story shows structured
  evidence in the admin review queue: byte scan verdict, C2PA provenance +
  credential issuer, OCR racism detection, AI detector signal, creator
  disclosure, and user report count.
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
| **AI review** | Flagged posts with structured evidence panel (byte scan, C2PA, OCR, AI detector, reports) |
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
- **Backend-verified IP binding** — admin power is bound to the IP the
  Convex edge *actually observed* on the request (cf-connecting-ip /
  x-forwarded-for), verified through the `/admin/ip/verify` HTTP action
  after a fresh admin sign-in. The admin can never claim an IP — the
  backend records what it saw, stores only a salted one-way hash, and
  silently revokes the binding (and admin power) when it goes stale or a
  session shows up from a different network.

## SEO & indexability

The site is built to be crawlable and to win social cards — no JavaScript
required for the important pages:

- **Server-rendered OG pages** — `/og/post/:id`, `/og/profile/:handle`,
  and `/og/about` (Convex HTTP actions) render the real post/profile and
  the About page's fee/feature disclosure as static HTML with Article /
  ProfilePage / AboutPage JSON-LD, a real-host canonical, and `index,follow`
  (the Convex mirror gets `noindex`). Vercel middleware serves them to
  crawlers and social unfurlers for `/post/:id`, `/u/:handle`, and
  `/about`; browsers get the SPA, whose per-route metadata module
  (`src/lib/seo.ts`) applies the matching tags at runtime. Dynamic
  rendering is CI-verified — a Googlebot fetch must never return the SPA
  shell, and `/about` must always carry the "no hidden fees" disclosure
  text.
- **Dynamic sitemap** — `/sitemap.xml` is generated from Convex: the six
  fixed public pages (from `src/lib/routes.ts`, a routes manifest shared
  with the router — add a public page there and it appears automatically)
  plus the newest public posts and profiles, excluding content that 404s
  for an anonymous crawler (posts in AI review, shadowbanned profiles).
  CDN-cached and refreshed on a schedule.
- **robots.txt + manifest** — a real `robots.txt` (wired through Vercel so
  the SPA fallback never swallows it), a trimmed ≤160-char meta
  description, `og:locale` + `twitter:image:alt`, a 180 px apple-touch
  icon, and store-style install screenshots in the web manifest.
- **Canonical host is repo-owned** — `vite.config.ts` substitutes
  `%PUREWIRE_SITE_URL%` from the `PUREWIRE_SITE_URL` Vercel env var,
  defaulting to `https://purewire.vercel.app`, so the canonical/OG tags can
  never regress to a preview or mirror hostname. A CI env guard fails if a
  stale `VITE_SITE_URL` ever reappears, and a build-log guard fails if the
  shipped deploy's log carries the "ignored" warning.
- **SEO audit suite** — nightly lints and quality scoring across the live
  sitemap (claude-seo's gbp-deprecation, structural HTML, and content
  quality), with a committed flag baseline so a *new* issue fails CI;
  sitemap URLs are sampled (configurable, `--all` for a full sweep) and
  each must return HTTP 200 with real content, a same-host canonical, and
  no redirect drift. An opt-in IPTC `DigitalSourceType` label check
  (`REQUIRE_IPTC_LABEL=1`) covers Google Merchant Center compliance.

## Architecture

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | React + Vite + TypeScript, Tailwind (shadcn/ui components) | PWA, served by Vercel |
| Backend | Convex (TypeScript functions + schema) | Database, auth, moderation, feeds, DMs |
| Media | Cloudinary (primary) with Convex storage fallback | Photos/videos/audio live outside the database |
| AI content detection | In-house byte-level scanner + C2PA verification | AI-generator metadata, provenance, deepfake markers, TTS/voice-clone watermarks |
| Email | Resend | Verification and password-reset codes |
| Bot check | Cloudflare Turnstile | Human-only email triggers |
| Delivery | Vercel (primary) + Convex static-hosting mirror | `purewire.vercel.app` / `outgoing-seal-727.convex.site` |

### Media storage architecture

PureWire's media pipeline is **Cloudinary-first end to end**: Cloudinary
stores the actual bytes; Convex stores only the reference (a `url` +
`key`/public_id) plus the metadata needed to render and manage the asset.
This holds for **every** upload path — posts, stories, direct messages,
avatars/banners, and comment voice notes. Convex is never used as a
binary media store:

1. **Client-side validation** — the file is re-encoded for privacy (GPS /
   device metadata stripped) and scanned for AI/deepfake markers before
   it leaves the browser.
2. **Cloudinary upload** — `prepareUpload` mints a server-signed upload
   ticket (or an unsigned preset in legacy mode); the browser POSTs the
   bytes straight to Cloudinary. They never pass through Convex.
3. **Convex record** — only after Cloudinary confirms the upload with a
   `secure_url` + `public_id` does the app create the Convex row, storing
   the reference and metadata (`kind`, `format`, `stripped`, audio `title`,
   etc.). No successful record is ever created without that confirmation.
4. **Rendering** — `<img>` / `<video>` / the audio player load the
   Cloudinary URL directly; Convex never proxies the bytes.
5. **Cleanup** — deletions remove the Cloudinary asset via a signed
   `destroy` call (fire-and-forget) on top of deleting the row; a failed
   delete leaves a cheap orphan, never a broken row.

**Fallback discipline** — when the `CLOUDINARY_*` env vars are absent (or a
Cloudinary upload fails), the same ticket includes a Convex storage upload
URL and the client re-posts there, so uploads never break — but that path
stores a Convex `storageId` *instead of* a URL, and rows created through it
are deleted through the same dual-mode cleanup. Enabling Cloudinary is a
config change, not a code change.

**Comment voice notes** — comment audio follows the exact same pipeline:
record or attach, scan, upload to Cloudinary, store only the reference,
play back with the native player. Each clip also records its measured
length (the duration chip) and optional description alongside the
reference. The data export resolves these references to downloadable URLs
and drops them in the ZIP alongside the post media.

## Privacy & security

- **Disposable-email blocking** — signup normalizes the address, extracts
  the domain, and rejects known disposable / temporary / mail-forwarding
  domains against a maintained denylist
  (`blocked-email-domains/*.txt` → `src/convex/emailDomainList.ts`)
  before the account is created; a domain added after signup is caught at
  verification and routed to human review instead of being verified.
  Compiles to a typed module by `scripts/generate-email-domain-list.mjs`
  (a CI drift guard fails if the two fall out of sync), sits alongside
  Turnstile, OTP verification, risk scoring, and a signup-velocity
  ceiling, and never relies on DNS/MX alone
- **Salted email hashes** — `SHA-256(salt + normalized email)`, salt
  versioned and rotatable
- **E2E encrypted DMs** — message bodies encrypted on sender's device,
  decrypt only on recipients' devices; server never holds plaintext. A
  shared post travels as its *id* (public metadata like sender/time); the
  caption stays encrypted
- **Client-side media processing** — EXIF/GPS/device metadata stripped
  before upload; videos get a server-side remux pass too
- **No identifying logs** — IP addresses, browser headers, and connection
  metadata are never written to storage
- **Location coarsened to ~1 km** — Local feed works from live browser
  position or home location, never precise
- **Sessions persist until sign-out** — up to 10 years with "Keep me
  signed in" toggle
- **Anti-scraping** — per-account rate limits on all activities
- **Proof-of-work (hashcash)** — the browser solves a ~50 ms SHA-256
  puzzle before every post, comment, and DM send, verified server-side
  before any DB work. Bots pay real compute per attempt on top of the
  rate limits; humans never notice
- **Browser-automation detection** — the browser scores itself for
  headless/CDP/Playwright/Puppeteer markers (an original module; see
  `src/lib/automation-signal.ts`) and files a coarse 0–100 score. Strong
  multi-marker scores feed the silent-flag pipeline; only the score and
  signal names ever reach the server — never a raw fingerprint
- **Self-auditing sessions** — a one-way UA hash + coarse timezone/language
  token is filed per session; a wildly different fingerprint on a later
  load silently revokes the session (stolen-cookie protection)
- **Anti-bot challenge detection** — link previews run
  [`is-antibot`](https://github.com/microlinkhq/is-antibot) (MIT) on every
  fetched URL; a destination answering with a Cloudflare/DataDome/…
  challenge is recorded as `challenged` and never carded
- **Backend-verified admin IP binding** — admin sessions are bound to the
  IP the backend observed (salted hash only, never the raw address), so a
  stolen admin session used from a different network is revoked; see the
  Admin dashboard section
- **Search visibility is exact** — every registered member is findable by
  their exact @handle via an indexed lookup (the same visibility gate as
  everywhere else keeps shadowbanned/restricted/banned accounts out), and
  the newest accounts are always inside the partial-search window

### User control & transparency

- **Personal keyword muting** — a Unicode-aware term list hides matching
  posts from your feed (Settings → Muted words & phrases)
- **Comment locking** — authors and admins can lock a post's comment
  thread; locked posts reject new comments with a clear message
- **Granular DM permissions** — Everyone / Accounts I follow / Nobody,
  enforced before any conversation or key exchange
- **Data export** — one click downloads a ZIP of everything you've created:
  your posts as readable text, the photos, videos, and audio files you
  uploaded, plus the full machine-readable archive (Settings → Data &
  privacy)
- **Permanent erasure** — deleting your account cascades through your
  posts, comments, engagement, stories, and auth records; nothing of yours
  lingers (the QA harness runs the same `eraseAccount` cascade)
- **Public system status** — `/status` shows live backend latency and
  platform totals, no account needed. It is linked from the Landing
  footer, About, and Help & Support, and always offers a **Back** button
  (stepping to the previous page, or home on a direct visit) so nobody is
  ever stranded on the page
- **Admin announcements** — categorized, dismissible home-page banners,
  optionally scheduled to auto-activate at a future date, with a live
  preview in the composer

## Setup

The full step-by-step (clone → install → run → QA → deploy) lives in
[`docs/setup.md`](docs/setup.md); the env-var dictionary is below and in
`.env.example`. Two places hold configuration. See `.env.example` for the
complete annotated reference.

**Frontend (Vercel, build-time):**

| Variable | Purpose |
| --- | --- |
| `VITE_CONVEX_URL` | Convex backend URL |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |

**Vercel (project env, build-time):**

| Variable | Purpose |
| --- | --- |
| `PUREWIRE_SITE_URL` | Canonical host for SEO tags (defaults to `https://purewire.vercel.app`; set explicitly so the dashboard self-documents it). `VITE_SITE_URL` is deprecated and **ignored** — a CI guard fails if it is ever re-added |

**Backend (Convex, runtime — `npx convex env set NAME value`):**

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Email delivery |
| `EMAIL_FROM` | Verified sender address |
| `EMAIL_HASH_SALT` | Salt for email hashing |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verification |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Signed deletes + video re-uploads |
| `TEST_HARNESS_ENABLED` / `TEST_HARNESS_SECRET` | QA harness (disabled in production) |

## QA suite

All scripts runnable locally against the live site:

The production-facing harness QAs (`qa:signup-e2e`, `qa:phishing`,
`qa:blocklist`, `qa:reinstate`, `qa:admin-ip`, `qa:story-views`,
`qa:shadowban`, `qa:session-audit`, `qa:count-drift`,
`qa:ai-scan-integration`, `qa:cloudinary-health`, `qa:profile-type`,
`qa:cleanup-*`) are
invoked in CI through `scripts/retry-once.sh`, which retries **once** when a
run fails with exit 1 — a flaky external feed or network blip can't red the
nightly gate on its own, while a genuine regression still fails and still
opens its alert issue. Harness misconfigurations (exit 2) are deterministic
and never retried. `qa:blocklist-sync` retries internally in the script
for the same reason.

| Command | What it verifies |
| --- | --- |
| `npm run typecheck` | TypeScript across all source |
| `npm run lint` | ESLint across all source |
| `npm run build` | Production Vite build |
| `npm run qa:secrets` | Scans repo for leaked secrets |
| `npm run qa:ai-scan` | AI scanner byte-level checks (C2PA, EXIF, PNG, MP4, WebP, ID3, FLAC) |
| `npm run qa:ai-scan-integration` | End-to-end upload → scan → evidence pipeline (harness-gated) |
| `npm run qa:profile-type` | Creator/User identity: onboarding prompt, Settings flip both ways, badge/title propagation (harness-gated) |
| `npm run qa:racism` | Racism prevention engine (72 adversarial test cases) |
| `npm run qa:phishing` | Phishing scan tiers across all surfaces |
| `npm run qa:blocklist` | Domain blocklist engine (49 checks, harness-gated) |
| `npm run qa:blocklist-sync` | External source synchronization (retries once on transient feed/transport failures) |
| `npm run qa:shadowban` | Silent-moderation escalation paths |
| `npm run qa:reinstate` | Admin reinstatement with audit trail |
| `npm run qa:suspend-story` | Story suspension + admin evidence (harness-gated) |
| `npm run qa:story-views` | Story viewer lists: newest-first ordering, re-view dedupe, non-author privacy (harness-gated) |
| `npm run qa:top-sort` | Top comments sort: like-rank determinism + backfill migration (harness-gated) |
| `npm run qa:follows` | Follow/unfollow e2e across profiles |
| `npm run qa:salt` | Salt-rotation migration idempotency |
| `npm run qa:video-privacy` | GPS-atom stripping on uploaded video |
| `npm run qa:automation` | Browser-automation signal scoring |
| `npm run qa:evidence-no-resemble` | AI evidence panel never ships Resemble watermark text |
| `npm run qa:admin-auth` | Admin password sign-in round-trip |
| `npm run qa:admin-ip` | Backend-verified admin IP binding (harness-gated) |
| `npm run qa:admin-auth-browser` | Admin sign-in driven in a real browser (JWT + refresh token) |
| `npm run qa:admin-responsive` | Admin dashboard at 320/390/768 px widths |
| `npm run qa:shell-layout` | Signed-in shell (feed, explore, messages, notifications, profile, settings) at mobile 390 / tablet 768 / desktop 1440 px: no overflow, no viewport leaks, feed tab labels unclipped, correct nav surface per width |
| `npm run qa:pages-inflation` | Page inflation at 800px with root-font-size scaling |
| `npm run qa:cloudinary-health` | Signed upload probe (end-to-end, cleans up after itself) |
| `npm run qa:media-architecture` | Cloudinary-first media audit — fails on any Convex-embedded bytes, blob/base64, foreign-host, or broken reference across posts/stories/comments (harness-gated) |
| `npm run qa:ai-visual-hardening` | Adversarial visual AI-detection QA — synthetic AI-like vs human-like fixtures through re-encode/resize/crop/screenshot/recompress/format-convert batteries; fails if measured separation collapses or a metadata-stripped screenshot reads as human |
| `npm run qa:session-audit` | Session-lifetime guarantees |
| `npm run qa:extend-sessions` | Session extension tooling |
| `npm run qa:count-drift` | Data-integrity DQS audit (harness-gated) |
| `npm run qa:live-engage` | Live engagement e2e (likes/comments/replies) |
| `npm run qa:dm-share` | Two-user DM share e2e: `sharedPostId` round trip on messages, the `dm-share` notification (bell badge + Open to the conversation), composer preview + card in a real browser (harness-gated) |
| `npm run qa:comment-share` | Comment share e2e: `sharedPostId` on comments, empty-husk + ghost-post rejections, the attach-a-post composer and posted card in a real browser (harness-gated) |
| `npm run qa:prod-pipeline` | Full production pipeline verification |
| `npm run qa:signup-e2e` | Sign-up flow e2e against production |
| `npm run qa:cleanup-test-users` / `qa:cleanup-test-domains` | Sweep leftover QA accounts / blocklist test domains (harness-gated) |

### SEO & canonical-host QA

| Command | What it verifies |
| --- | --- |
| `npm run qa:sitemap-urls` (add `:all` for a full sweep) | Live sitemap URLs return HTTP 200 with real content (not the SPA shell), a same-host canonical **and** an `og:url` matching the exact sitemap URL, and no redirect drift; every sitemap `<loc>` (main host **and** Convex static mirror) must carry the canonical host — a wrong-host sitemap fails at the source; sample size via `SITEMAP_SAMPLE` |
| `npm run qa:seo-audit` | SEO audit of the newest post + profile (claude-seo linters): sitemap discovery, structural parse_html lints (title/meta/canonical/h1/schema), absolute floor **and** a committed-score baseline — any drop > Δ (`CQ_DELTA`, default 5) fails even above the floor |
| `seo-audit:baseline` | Re-record the audit score baseline (after intentional content changes) |
| `npm run qa:seo-sweep` (add `:all`) | Sitemap-wide SEO sweep with a committed flag baseline — new issues fail CI |
| `seo-sweep:baseline` | Re-record the committed sweep baseline |
| `npm run qa:dynamic-render` | Googlebot fetch of `/u/:handle` + `/post/:id` + `/about` returns server-rendered HTML, never the SPA shell — and `/about` must carry the "no hidden fees" fee-disclosure text |
| `npm run qa:vercel-env` | `PUREWIRE_SITE_URL` still set; stale `VITE_SITE_URL` fails CI |
| `npm run qa:vercel-build-warnings` | The shipped deploy's build log contains no canonical-host warnings |
| `npm run qa:robots-live` | Live robots.txt contract: the mirror must still `Disallow: /` everything (no leaked `Allow`), and the main host must keep its exact canonical Sitemap line — a broken robots.txt is silent for users, so it's guarded on every push + nightly |

### Browser-session QA (JWT + refresh token)

A QA walk that drives the real UI — signing in as a minted throwaway and
swapping between accounts in a browser — needs **both halves of a browser
session in `localStorage`**: the access **JWT** (`__convexAuthJWT_<host>`) **and**
the **refresh token** (`__convexAuthRefreshToken_<host>`, formatted
`<refreshTokenId>|<sessionId>`). Injecting only the JWT makes the auth
client try to refresh, find no `authRefreshTokens` row, and **sign itself
out** — wiping the storage you just wrote. Always mint and inject both.

Two harness-gated helpers exist for exactly this (both require
`TEST_HARNESS_ENABLED=1` + `TEST_HARNESS_SECRET`):

- **`testHarness.mintSessionRefreshToken`** — create a real
  `authRefreshTokens` row for an existing qa_ account's session and return
  the formatted refresh token, so a browser injection carries the full
  session.
- **`testHarness.mintSessionForQaUsername`** — re-mint a **fresh** JWT +
  refresh-token pair for an existing qa_ account by username. Access JWTs
  are short-lived (1 hour), so a long walk re-mints mid-run without
  recreating the account (which would orphan its content).

Example flow:

```js
// Mint the account (get JWT), then mint its refresh half:
const acc = await client.mutation(api.testHarness.createTestUser, {
  name, username, secret,
});
const { refreshToken } = await client.mutation(
  api.testHarness.mintSessionRefreshToken,
  { userId: acc.userId, secret },
);
// Later, when the JWT expires:
const fresh = await client.mutation(
  api.testHarness.mintSessionForQaUsername,
  { username, secret },
); // { token, refreshToken }
```

In the browser, write both keys under the deployment's namespace (for
production: `__convexAuthJWT_httpsoutgoingseal727convexcloud` and
`__convexAuthRefreshToken_httpsoutgoingseal727convexcloud`), then do a full
reload so the auth provider reads storage on mount.

## CI/CD

Six workflows on GitHub Actions, all gated on `main`:

- **Static Audit** (`static-audit.yml`, on push) — typecheck, lint, build,
  secrets scan, static SEO file guard (robots/sitemap drift), sitemap URL
  health, and 15+ parallel QA jobs (racism, phishing, blocklist, AI scan,
  automation, shadowban, reinstate, salt, admin-responsive, count-drift,
  session-audit, cleanup).
- **Deploy to Vercel** (`deploy.yml`, on push) — `vercel --prod` for the
  frontend; shares a concurrency group with the drift redeploy so deploys
  never race.
- **Production Health Check** (`production-healthcheck.yml`, on push +
  nightly 03:00 UTC) — live-site e2e probes (auth loop, phishing, blocklist
  sync, moderation reinstate, admin IP binding, story views, cloudinary
  upload, DM share E2E, comment share E2E) plus the Vercel env guard and
  the build-log warning guard; any failure opens a deduplicated alert
  issue.
- **SEO Audit** (`seo-audit.yml`, nightly 04:00 UTC) — runs the claude-seo
  audit and the sitemap-wide sweep against the live site; score regressions
  open a `prod-seo-audit` alert issue, and a weekly step (Monday 05:00 UTC)
  posts the metrics table to a deduplicated `seo-weekly-report` trend issue
  with an accumulating score history — visible even when nothing regresses.
- **Run Convex migrations** (`migrations.yml`, on push + nightly 04:00
  UTC) — deploys the Convex backend and auto-runs schema migrations, so
  backfills like the comment like-count never need a manual step.
- **Redeploy on drift** (`redeploy-drift.yml`, nightly 03:47 UTC) —
  compares the commit live on Vercel production against `main` HEAD and
  redeploys only when they drift, so the canonical/env state never silently
  lags the repo. Fails safe: a check error never triggers a deploy.

## Engineering tooling

- **Bridged skills** — reusable, self-contained instructions live in
  `.agents/skills/` (seo, seo-optimizer, senior-security, senior-architect,
  code-reviewer, code-tour, adversarial-reviewer, chaos-engineering,
  compliance-os, data-quality-auditor, dependency-auditor,
  feature-flags-architect, focused-fix, gdpr-audit-prep, grill-me,
  migration-architect, resemble-detect, security-guidance, ship-gate,
  skill-security-auditor, soc2-audit-prep, zero-hallucination-coder) —
  loadable by name in any session, and the SEO skill's scripts are wired
  into the nightly audit.

---

© PureWire. Say it anyway — no ads, ever.
