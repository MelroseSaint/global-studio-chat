import { motion } from "framer-motion";
import {
  BadgeCheck,
  CircleDollarSign,
  Compass,
  Database,
  FileDown,
  Heart,
  Layers,
  Lock,
  MessageCircle,
  Quote,
  ScanSearch,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { autoClosePolicyPhrase } from "@/lib/comment-policy";
import { usePageMeta } from "@/lib/seo";

const PAGE_META = {
  title: "About PureWire — no fees, no ads, no algorithm",
  description:
    "Everything about PureWire, plainly stated before you sign up: it's free with no hidden fees, the five feeds you control, every feature, the rules, and what happens to your data.",
  path: "/about",
} as const;

// ── Cost & fees ─────────────────────────────────────────────

const cost = [
  {
    icon: CircleDollarSign,
    title: "Free to join. Free to use.",
    detail:
      "No subscription, no paywall, no premium tier, no pay-to-post. Creating an account, posting, uploading photos, videos, and audio, sending messages, and downloading your data are all free — now and as the platform grows.",
  },
  {
    icon: Sparkles,
    title: "No ads, no sponsorships, no promoted posts",
    detail:
      "PureWire is not funded by selling your attention. There are no advertisements, no sponsored content, and nothing is ever boosted or promoted for money. Your feed is yours.",
  },
  {
    icon: ShieldCheck,
    title: "No hidden fees, anywhere",
    detail:
      "There is nothing to buy and nothing that unlocks later. What you see on this page is the whole platform — the same features for every member, with no tiers and no surprises on a bill.",
  },
];

// ── The feeds ───────────────────────────────────────────────

const feeds = [
  {
    title: "Global",
    detail:
      "Everything happening on PureWire, in time order. The whole community, no curation.",
  },
  {
    title: "Following",
    detail:
      "Posts from the people you follow, gathered in one place. Your circle, your call.",
  },
  {
    title: "Latest",
    detail: "The newest posts first — the freshest takes as they land.",
  },
  {
    title: "Local",
    detail:
      "Posts shared near you. It can use your live position — read only while you're browsing and never stored — or your home area, which is kept as a coarsened ~1 km anchor, never your exact point.",
  },
  {
    title: "Photos & videos",
    detail:
      "A media-only view of the platform — the images, clips, and audio people have shared.",
  },
];

// ── Features ────────────────────────────────────────────────

const features = [
  {
    icon: Quote,
    title: "Posts, your way",
    detail:
      "Share text up to 1,000 characters with photos, video, or audio attached. Every post is labelled by its author — Human, AI-assisted, or AI-generated — and checked against the platform before it goes live, so copycats and stolen work don't make it. Posts that pass earn the green “Original” badge.",
  },
  {
    icon: MessageCircle,
    title: "Comments & replies",
    detail:
      "Join any thread, reply to any comment, and like the replies that hit. Threads stay readable: a post's author can delete comments on their post, close or reopen comments anytime, and threads close on their own " +
      autoClosePolicyPhrase() +
      " so old, crowded threads don't spiral.",
  },
  {
    icon: Send,
    title: "Sharing, everywhere",
    detail:
      "Share any post into a direct message — the composer opens right where you are, no redirect — and the person you message sees your note plus a live preview card. You can also share a post into a comment as a link card, or just paste a PureWire post link and it's detected and offered as a card automatically.",
  },
  {
    icon: Lock,
    title: "Direct messages, end-to-end encrypted",
    detail:
      "Your messages are encrypted in your browser before a single byte leaves your device. PureWire stores only unreadable ciphertext — the keys exist only on the devices of the people talking. No server, no admin, no subpoena can read them.",
  },
  {
    icon: Heart,
    title: "Likes & notifications",
    detail:
      "Like posts and comments, and a bell keeps you in the loop — new comments, replies, likes, and when someone shares your post into a conversation or a thread.",
  },
  {
    icon: BadgeCheck,
    title: "Verified, real people",
    detail:
      "Verify your email with a one-time code and the verified badge is yours. No phone numbers, no third-party logins — one inbox gets one badge, so you know who you're really talking to.",
  },
  {
    icon: Sparkles,
    title: "Stories that vanish",
    detail:
      "Drop a story and it's gone 24 hours later — automatically deleted, file and all.",
  },
  {
    icon: UserPlus,
    title: "Follow & block, your call",
    detail:
      "Follow the people who get you. Block anyone who doesn't — blocking hides them in both directions and unfollows them automatically. Report anything with one tap from any post or comment.",
  },
];

// ── The Standard ────────────────────────────────────────────

const standard = [
  "Say what you mean.",
  "Create what you want.",
  "Find your people.",
  "Disagree without destroying each other.",
  "Don't impersonate people.",
  "Don't steal people's work.",
  "Don't spam the platform.",
  "Don't use freedom as an excuse to take someone else's freedom away.",
  "No AI-generated content — say it yourself.",
  "No adult platforms — don't share, post, or link to adult subscription, cam, video, clip, or chat sites.",
  "No sexual solicitation — don't advertise or offer sexual services, escorting, or pornographic content.",
];

// ── Content policies at a glance ────────────────────────────

const policies = [
  {
    icon: ScanSearch,
    title: "AI & deepfake detection",
    detail:
      "Every post and story is scanned for AI-generated content — text is checked for machine patterns, and images, audio, and video are checked for AI-generator metadata, C2PA Content Credentials, and deepfake markers. Self-identified AI content is blocked; suspicious content enters human review, and the author is told why.",
  },
  {
    icon: ShieldAlert,
    title: "Prohibited domains, scams & sexual solicitation",
    detail:
      "Adult platforms, known scam patterns, and sexual solicitation are blocked site-wide — in posts, comments, stories, bios, profile links, usernames, and before direct messages are encrypted. Links are resolved through redirect chains and obfuscation before a decision is made. Solicitation language is normalized to defeat circumvention (zero-width chars, repeated letters, separator insertion) and checked against a server-side policy applied identically to every content surface.",
  },
  {
    icon: Compass,
    title: "Moderation is report-driven, never surveillance",
    detail:
      "Admins act only when a member reports something or automated safeguards flag it — and even then they see no private data: no plain-text emails, no locations, no message contents, because those never exist in readable form. Every action cites a Standard principle and is written to the audit trail.",
  },
];

// ── Your data & account ─────────────────────────────────────

const data = [
  {
    icon: FileDown,
    title: "Download everything you've created",
    detail:
      "Settings → Download your data gives you a ZIP with every post as readable text, the photos, videos, and audio files you uploaded, and the complete archive — organized so you can match files to posts.",
  },
  {
    icon: Trash2,
    title: "Delete your account, delete everything",
    detail:
      "One action in Settings permanently removes your profile, posts, comments, likes, shares, stories, follows, notifications, and every file you uploaded. No soft-delete, no hidden copy kept anywhere.",
  },
  {
    icon: Database,
    title: "Almost nothing is stored — and nothing hidden",
    detail:
      "No tracking, no analytics, no cookies, no advertising profiles. Only what you create: your account, your posts, your ciphertext-only messages, and short-lived safety signals. The complete plain-language inventory is on the Privacy page.",
  },
];

export function About() {
  const { isAuthenticated } = useAuth();
  usePageMeta(PAGE_META);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-8 rounded-xl" />
            <span className="font-bold tracking-tight">PureWire</span>
          </Link>
          <Button size="sm" asChild>
            <Link to={isAuthenticated ? "/home" : "/auth"}>
              {isAuthenticated ? "Open app" : "Get started"}
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="mb-10"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-moss/40 bg-moss/10 px-3 py-1 text-xs font-medium text-moss">
            <Layers className="size-3" />
            No signup required
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
            Everything about PureWire,{" "}
            <span className="brand-gradient-text">plainly stated.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            This page is the whole picture before you join: what PureWire
            costs, the feeds you get, everything you can do, the rules, and
            what happens to your data. Nothing here is hidden behind an
            account.
          </p>
        </motion.div>

        {/* Cost & fees */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              What it costs
            </h2>
            <p className="text-sm text-muted-foreground">
              Short answer: nothing. PureWire has no fees — and this is a
              promise, not fine print.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {cost.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
              >
                <Card className="h-full border-moss/25 bg-moss/5">
                  <CardContent className="flex flex-col gap-2 p-5">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-moss/15 text-moss">
                      <item.icon className="size-4" />
                    </div>
                    <h3 className="font-semibold tracking-tight">
                      {item.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {item.detail}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Feeds */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              Your feeds — five ways to see, zero algorithms
            </h2>
            <p className="text-sm text-muted-foreground">
              Once you're signed in, the tab bar is yours to switch anytime.
              Nobody quietly reshapes your feed for you — what you see is
              what you chose.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {feeds.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
              >
                <Card className="h-full">
                  <CardContent className="flex items-start gap-3 p-5">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-oxide/15 text-xs font-bold text-oxide dark:text-oxide-light">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="font-semibold tracking-tight">{f.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {f.detail}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
            <Card className="border-primary/30 bg-primary/5 sm:col-span-2">
              <CardContent className="flex items-start gap-3 p-5">
                <Compass className="mt-0.5 size-5 shrink-0 text-primary" />
                <p className="text-sm text-muted-foreground">
                  PureWire has no algorithmic feed, and that's deliberate —
                  “Global” and “Latest” both show the platform in time order.
                  The tabs stay separate so you control your view, and so no
                  ranking layer can ever be silently forced on anyone.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Features */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              Everything you can do
            </h2>
            <p className="text-sm text-muted-foreground">
              The complete feature set — the same for every member, no tiers.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {features.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.35, delay: i * 0.04 }}
              >
                <Card className="h-full">
                  <CardContent className="flex flex-col gap-2 p-5">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-oxide/15 text-oxide dark:text-oxide-light">
                      <item.icon className="size-4" />
                    </div>
                    <h3 className="font-semibold tracking-tight">
                      {item.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {item.detail}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* The Standard */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              The PureWire Standard
            </h2>
            <p className="text-sm text-muted-foreground">
              PureWire isn't “no rules.” It's freedom with a reason: your
              expression matters, so it's protected — from copycats, ads,
              algorithms, and from anyone using their freedom to take
              someone else's away. These are the lines:
            </p>
          </div>
          <Card className="border-oxide/25">
            <CardContent>
              <ol className="grid gap-2 text-sm sm:grid-cols-2">
                {standard.map((rule, i) => (
                  <li key={rule} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-oxide/15 text-[11px] font-bold text-oxide dark:text-oxide-light">
                      {i + 1}
                    </span>
                    <span className="leading-snug">{rule}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </section>

        {/* Content policies */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              How the platform is kept clean
            </h2>
            <p className="text-sm text-muted-foreground">
              Safeguards run quietly so you don't have to think about them.
              Here's what they do.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-1">
            {policies.map((p) => (
              <Card key={p.title}>
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                    <p.icon className="size-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold tracking-tight">{p.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {p.detail}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Your data & account */}
        <section className="mb-12">
          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight">
              Your data & your account
            </h2>
            <p className="text-sm text-muted-foreground">
              Everything you create is yours — to download, to keep, or to
              erase.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-1">
            {data.map((d) => (
              <Card key={d.title}>
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl brand-gradient-bg text-white">
                    <d.icon className="size-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold tracking-tight">{d.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {d.detail}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* CTA */}
        <Card className="border-moss/30 bg-moss/5">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <CircleDollarSign className="size-8 text-moss" />
            <h2 className="text-lg font-bold tracking-tight">
              Free to join. Free to use. Free to leave.
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              No fees, no ads, no algorithm — and your data leaves with you
              the moment you ask. The account takes less than a minute.
            </p>
            <Button asChild>
              <Link to={isAuthenticated ? "/home" : "/auth"}>
                {isAuthenticated ? "Open your feed" : "Get started free"}
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Legal links */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <Link to="/privacy" className="hover:text-foreground hover:underline">
            Privacy
          </Link>
          <Link to="/terms" className="hover:text-foreground hover:underline">
            Terms
          </Link>
          <Link to="/status" className="hover:text-foreground hover:underline">
            Status
          </Link>
          <Link to="/support" className="hover:text-foreground hover:underline">
            Help & Support
          </Link>
        </div>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-6 rounded-lg" />
            <span className="font-semibold text-foreground">PureWire</span>
          </div>
          <p>© {new Date().getFullYear()} PureWire. Say it anyway — no ads, ever.</p>
          <div className="flex items-center gap-4">
            <Link to="/privacy" className="hover:text-foreground hover:underline">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-foreground hover:underline">
              Terms
            </Link>
            <Link to="/status" className="hover:text-foreground hover:underline">
              Status
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
