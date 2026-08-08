# Architecture

PureWire is a PWA (React + Vite) with a Convex backend, built so the
public web surfaces are crawlable without JavaScript and so every piece of
content is verified before it goes live.

## Layers

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | React + Vite + TypeScript, Tailwind, shadcn/ui | PWA served by Vercel; per-route metadata at runtime |
| Backend | Convex (TypeScript functions + schema) | Database, auth, moderation, feeds, DMs, SEO HTTP actions |
| Media | Cloudinary (primary) + Convex storage fallback | Photos/videos/audio live outside the database |
| AI content detection | In-house byte-level scanner + C2PA verification | AI-generator metadata, provenance, deepfake markers, TTS/voice-clone watermarks |
| Email | Resend | Verification and password-reset codes |
| Bot check | Cloudflare Turnstile | Human-only email triggers |
| Delivery | Vercel (primary) + Convex static-hosting mirror | `purewire.vercel.app` / `outgoing-seal-727.convex.site` |

## Source map

```
src/
  convex/            Backend: schema, auth, moderation, posts, comments,
                     stories, DMs, blocklist, security, SEO HTTP actions
  pages/             Route components (Feed, Profile, PostDetail, Messages,
                     Admin, Settings, …)
  components/        UI components incl. the comment popup, composer,
                     post cards, admin panels
  lib/               Client helpers: seo.ts (per-route metadata),
                     routes.ts (public routes manifest), moderation
                     scanners, dm-crypto, pow (proof-of-work)
  hooks/             Auth, online status, offline mutations
  main.tsx / index.css
scripts/             QA harness (30+ qa:* scripts), CI guards, tooling
.github/workflows/   Six CI workflows — see docs/ci-cd.md
public/              robots.txt, sitemap.xml (generated), manifest, icons
data/                Blocklist feed data (data/adult/…)
```

## The content pipeline

Every post, comment, story, bio, profile link, and DM passes the same
gates before it exists:

```
User submits content
       ↓
AI / originality / safety / phishing / prohibited-domain / racism checks
       ↓
Clean → publish
Suspicious → quarantine / human review
Blocked → rejected with an honest reason
```

Notable properties of the pipeline:

- **Proof-of-work (hashcash)** — the browser solves a ~50 ms SHA-256 puzzle
  before every post, comment, and DM; the backend verifies before any DB
  work, so bots pay real compute on top of per-account rate limits.
- **Browser-automation detection** — the browser files a coarse 0–100
  self-score for headless/CDP/Playwright/Puppeteer markers (original
  module, `src/lib/automation-signal.ts`); strong multi-marker scores feed
  the silent-flag pipeline. Only the score and signal names reach the
  server, never a raw fingerprint.
- **Silent moderation** — accounts tripping abuse signals are quietly
  limited: nothing errors, their posts still "work" to them, but nothing
  reaches anyone else until human review. Flags decay with clean behavior;
  every event lands in the audit trail.
- **Counters are denormalized and audited** — `likeCount`, `commentCount`,
  `followersCount`, etc. live on the parent document and are kept honest by
  migrations (e.g. the comment like-count backfill) and a nightly
  counter-drift DQS audit.

## Public web surfaces (SEO)

The important pages are server-rendered for crawlers and social unfurlers:

- **Dynamic rendering** — Convex HTTP actions render `/og/post/:id` and
  `/og/profile/:handle` as static HTML (Article/ProfilePage JSON-LD,
  real-host canonical, `index,follow`). Vercel middleware serves those to
  crawler/unfurler user agents for `/post/:id` and `/u/:handle`; browsers
  get the SPA, whose `src/lib/seo.ts` applies the matching tags at runtime.
- **Dynamic sitemap** — `/sitemap.xml` is generated from Convex: the six
  fixed public pages (from `src/lib/routes.ts`, the routes manifest shared
  with the router) plus the newest public posts and profiles, excluding
  content that 404s for an anonymous crawler. CDN-cached, refreshed on a
  schedule.
- **Canonical host is repo-owned** — `vite.config.ts` substitutes
  `%PUREWIRE_SITE_URL%` from the Vercel env var (default
  `https://purewire.vercel.app`), so canonical/OG tags can never regress to
  a preview or mirror hostname. CI guards enforce it (see ADR-0001).

## Deployment topology

```
Browser
  ├─ Vercel (purewire.vercel.app)  → SPA + middleware (UA sniffing)
  │     └─ Convex HTTP actions     → /og/*, /sitemap.xml, /admin/ip/verify
  ├─ Convex cloud (outgoing-seal-727.convex.cloud) → DB + functions + auth
  │     └─ static-hosting mirror (outgoing-seal-727.convex.site)
  ├─ Cloudinary                     → media uploads (unsigned preset)
  ├─ Resend                         → email codes
  └─ Cloudflare Turnstile           → human checks
```

The Convex static-hosting mirror also serves the app and shares the same
`index.html`; the sitemap it serves must carry canonical-host `<loc>`s, and
a CI guard asserts that at the source.

## Invariants worth defending

- Canonical/OG/sitemap URLs always carry the repo-owned host.
- The backend, not the browser, decides what is true (content checks,
  admin IP binding, session fingerprint audits, PoW verification).
- Sessions persist until sign-out (up to 10 years) but self-audit: a
  wildly different UA/timezone/language fingerprint silently revokes.
- DMs are end-to-end encrypted; the server never holds plaintext.
- Email hashes are salted (rotatable salt); raw IPs/headers are never
  stored.
- Production QA runs only through the harness gate, and the harness stays
  disabled in production outside QA windows.

## Decision history

Every decision that shaped these choices is recorded in
[`docs/adr/`](adr/) — read it before changing one of them.
