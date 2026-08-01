# PureWire

Say it anyway.

Other platforms tell you what you can say. PureWire gives you the space to
say it — a social platform built around expression, connection, and freedom,
not advertising, corporate sponsorships, or telling people how they're
supposed to participate.

## The PureWire promise

- **Say it anyway** — your voice, your words, your way. No ads, no
  algorithms, no corporate curation, no forced trends.
- **Verified original** — every post is fingerprinted and checked against the
  platform before it appears. Stolen work and copycats are blocked, and posts
  that pass carry the **Original** badge.
- **Freedom with a reason** — PureWire isn't "no rules." The PureWire
  Standard draws the lines (no impersonation, no stealing work, no spam, no
  harassment) so one person's freedom never costs another's.
- **No algorithm, your choice** — the feed is Global, Following, Latest, and
  Photos & videos. You choose what you see.
- **Real people** — email verification at signup, verified badges for notable
  accounts, and no guest or anonymous accounts.
- **Your profile, your way** — upload your photo and banner, write a bio, and
  link your other socials.

## Brand

- **Palette** — Wire Black `#171918` (strength), Paper `#F4F0E8` (space),
  Oxide `#B84A32` (expression), Moss `#465A4C` (grounding), Copper `#C97952`
  (accent).
- **Slogan** — *Say it anyway.*

## Features

- Posts with text, photos, videos and audio
- 24-hour stories with a built-in viewer
- Followers, likes, comments, shares, and @mentions
- Feed filters: Global, Following, Latest, Photos & videos (no algorithm)
- Notifications (likes, comments, follows, shares, mentions, support replies)
- Profiles with banner, bio, and social links
- Infinite scrolling feeds
- Support tickets to the team (reports include the post, the user, and the violation)
- The PureWire Standard — the visible community rules
- Admin dashboard — verification, roles, content moderation, ticket responses

## Architecture

- **Frontend** — Vite + React SPA, hosted on **Vercel**
- **Backend** — Convex (database + server functions + auth), at
  `https://outgoing-seal-727.convex.cloud`
- **Auth** — email + password with email verification and password reset
  (no guest accounts)

## Getting started

```bash
npm install
npm run dev
```

The dev server reads `VITE_CONVEX_URL` from `.env.local` (already configured).

## Deployment

### Backend (Convex)

```bash
npm run deploy:backend
```

### Frontend (Vercel)

```bash
npm run deploy:web
```

Or push to a GitHub repo connected to Vercel — `vercel.json` sets the build
command (`npm run build`), output directory (`dist`), and SPA rewrites. Set the
following environment variables in Vercel (dashboard or `npx vercel env add`):

- `VITE_CONVEX_URL` — the Convex deployment URL
  (`https://outgoing-seal-727.convex.cloud`)
- `VITE_SITE_URL` — the public site URL (e.g. `https://purewire.vercel.app` or
  your custom domain). Used for SEO canonical / Open Graph meta. Update
  `.env.production` after your first deploy so the real URL is correct.

After the first deploy, also point Convex Auth's redirects at the new host:

```bash
npx convex env set SITE_URL https://<your-vercel-url>
```

### Full deploy

```bash
npm run deploy
```

`deploy` runs backend + version upload + web. The version-upload step
registers the current build with Convex so the in-app **UpdateBanner**
("A new version of PureWire is available") appears for users on older builds
when a new release ships — it's powered by `@convex-dev/static-hosting`'s
`exposeDeploymentQuery`, which is mounted in `convex.config.ts` and exposed
from `convex/staticHosting.ts`.

> The banner only starts appearing from the **second** release onward — the
> first upload seeds the version record, and on that first release everyone is
> on the current build anyway. If the version upload crashes on Windows
> (a known libuv issue), rerun it with a lower concurrency:
> `npx @convex-dev/static-hosting upload --dist dist --prod --concurrency 1`.

> Note: the email service key on the backend deployment must be a real key for
> verification and reset emails to be sent. Set it in the Convex deployment
> environment.

## Scripts

- `npm run dev` — start the development server
- `npm run build` — build for production
- `npm run typecheck` — run the type checker
- `npm run deploy:backend` — deploy the backend to Convex
- `npm run deploy:web` — deploy the frontend to Vercel
- `npm run upload:version` — register the current build for the UpdateBanner
- `npm run deploy` — deploy backend + web + version upload
