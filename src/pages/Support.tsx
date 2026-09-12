import { useMutation, usePaginatedQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Activity,
  Database,
  Eye,
  Globe,
  LifeBuoy,
  Loader2,
  MessageSquarePlus,
  Microscope,
  ScanSearch,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Link } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { autoClosePolicyPhrase } from "@/lib/comment-policy";
import { timeAgo } from "@/lib/format";
import { standardById, STANDARD_PRINCIPLES } from "@/lib/standard";

const STATUS_VARIANTS: Record<string, string> = {
  open: "default",
  in_review: "outline",
  resolved: "secondary",
};

export function Support() {
  const createTicket = useMutation(api.support.createTicket);
  const { results, status, loadMore } = usePaginatedQuery(
    api.support.myTickets,
    {},
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();

  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [standardId, setStandardId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  const tickets = results as unknown as {
    _id: string;
    _creationTime: number;
    subject: string;
    status: "open" | "in_review" | "resolved";
    reply?: string | null;
  }[];

  const submit = async () => {
    if (!subject.trim() || !message.trim() || submitting) return;
    setSubmitting(true);
    try {
      const principle = standardId ? standardById(standardId) : undefined;
      await createTicket({
        subject: subject.trim(),
        message: message.trim(),
        ...(principle !== undefined
          ? { violation: principle.title, standardId: principle.id }
          : {}),
      });
      toast.success("Ticket submitted. We'll get back to you.");
      setSubject("");
      setMessage("");
      setStandardId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 pb-24 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <LifeBuoy className="size-5 text-primary" />
          Help & Support
        </h1>
        <p className="text-sm text-muted-foreground">
          Have an issue, a bug, or a report? Open a ticket and the team will
          review it. You can track everything right here.{" "}
          <Link to="/privacy" className="text-primary hover:underline">
            Read our full data & transparency statement
          </Link>
          .
        </p>
      </div>

      {/* Transparency — the full feature/fee disclosure, always one tap away */}
      <div className="flex items-start gap-2.5 rounded-xl border border-l-[3px] border-l-moss bg-moss/5 px-3 py-2.5 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-moss" />
        <p className="leading-snug text-muted-foreground">
          <span className="font-semibold text-foreground">
            Everything, plainly stated:
          </span>{" "}
          what PureWire costs (nothing), the five feeds, every feature, the
          rules, and your data controls are documented on the{" "}
          <Link to="/about" className="text-primary hover:underline">
            About page
          </Link>
          .
        </p>
      </div>

      {/* System status — the live health check, one tap away */}
      <div className="flex items-start gap-2.5 rounded-xl border border-l-[3px] border-l-primary/60 bg-primary/5 px-3 py-2.5 text-sm">
        <Activity className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="leading-snug text-muted-foreground">
          <span className="font-semibold text-foreground">
            Is PureWire up right now?
          </span>{" "}
          Check the platform&apos;s live health — latency, community totals,
          and the last check time — on the{" "}
          <Link to="/status" className="text-primary hover:underline">
            System status page
          </Link>
          .
        </p>
      </div>

      {/* ── The PureWire Standard ────────────────────────────────────── */}
      <Card className="border-oxide/25">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-oxide dark:text-oxide-light" />
            The PureWire Standard
          </CardTitle>
          <CardDescription>
            PureWire isn't &ldquo;no rules.&rdquo; It's freedom with a
            reason. Say what you mean — and never use your freedom to take
            someone else's away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              "Say what you mean.",
              "Create what you want.",
              "Find your people.",
              "Disagree without destroying each other.",
              "Don't impersonate people.",
              "Don't steal people's work.",
              "Don't spam the platform.",
              "Don't use freedom as an excuse to take someone else's freedom away.",
              "No AI-generated content — say it yourself.",
              "No adult platforms or sexual solicitation — don't share, post, or link to adult sites or advertise sexual services anywhere on the platform.",
            ].map((rule, i) => (
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

      {/* ── Content policies at a glance ─────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Microscope className="size-4 text-copper" />
              AI & deepfake detection
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              PureWire scans every post and story for AI-generated content.
              Text is checked for machine patterns. Images, audio, and video
              are checked for AI-generator metadata (Midjourney, Stable
              Diffusion, DALL·E, etc.), C2PA Content Credentials, and
              container-level deepfake markers. Self-identified AI and
              C2PA manifests asserting AI creation are blocked. Suspicious
              content enters human review — and the author is told honestly
              why.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Globe className="size-4 text-destructive" />
              Prohibited domains
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Adult subscription, cam, video, clip, chat, and redirect
              platforms are blocked site-wide. Every URL in posts,
              comments, stories, bios, profile links, and direct messages
              is scanned — including redirect chains (up to 5 hops),
              punycode/IDN domains, and obfuscation attempts like
              &ldquo;domain dot com&rdquo;. URL shorteners are resolved to
              their destination before a decision is made.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Shield className="size-4 text-oxide" />
              Racism & hate prevention
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Racial slurs, ethnic slurs, dehumanization, supremacy claims,
              segregation advocacy, calls for violence, and coded hate
              language are blocked. The system detects Unicode confusables,
              leetspeak, spacing attacks, and other evasion techniques.
              Ambiguous content enters human review. Discussion, reporting,
              and educational context are distinguished from attacks —
              context matters.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ScanSearch className="size-4 text-moss" />
              Phishing & scams
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Links and phrasing that try to harvest accounts, passwords,
              money, or personal information are blocked across all surfaces
              — posts, comments, stories, profile links, and before direct
              messages are encrypted. Members can report suspected phishing
              with one tap from any post or comment menu.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
              Silent moderation
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Accounts that repeatedly trip safeguards — posting duplicates,
              flooding the platform, pushing AI-generated or manipulated
              media — may have their reach quietly limited instead of
              being confronted. Nothing is deleted without review; a human
              makes the final call. If you believe your account was limited,
              open a support ticket.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Eye className="size-4 text-primary" />
              What admins can see
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Only what's public, and only after something is reported or
              flagged. Admins act when a member reports a post, profile, or
              ticket — or when automated safeguards flag content for review.
              They never see private data: no plain-text emails, no locations,
              no message contents. Every action cites a Standard principle
              and is written to the audit trail. Nobody watches you;
              moderation begins when someone says something needs looking at.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldOff className="size-4 text-destructive" />
              Law enforcement & government
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Direct messages are end-to-end encrypted — keys exist only on
              the devices of the people talking. PureWire stores only
              ciphertext. No master key, no backdoor. Plain-text emails,
              precise locations, and tracking logs are never stored. A
              request for user data produces only what's already public:
              a profile and the posts on it. Nothing more exists to hand
              over to any law enforcement, government, or third party.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4 text-muted-foreground" />
              Data we store
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Very little, and only what you create: username, display name,
              bio, links, photo and banner, a salted SHA-256 hash of your
              email (never plain-text), posts, stories, comments, likes,
              shares, follows, notifications, tickets, and DMs stored as
              unreadable ciphertext. No tracking, no analytics, no cookies,
              no advertising profile. GPS stripped before upload. Stories
              auto-deleted after 24 hours. Full inventory on the{" "}
              <Link to="/privacy" className="text-primary hover:underline">Privacy page</Link>.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Ticket form ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquarePlus className="size-4" />
            Open a support ticket
          </CardTitle>
          <CardDescription>
            Reports, bugs, questions — all in one place. No emails needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What do you need help with?"
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="message">Message</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell us the details — include the post and the user involved if this is a report…"
              rows={5}
              maxLength={2000}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="standard">
              Related Standard principle (optional)
            </Label>
            <Select value={standardId} onValueChange={setStandardId}>
              <SelectTrigger id="standard" className="w-full max-w-full">
                <SelectValue placeholder="Choose a principle if this relates to one" />
              </SelectTrigger>
              <SelectContent>
                {STANDARD_PRINCIPLES.map((p, i) => (
                  <SelectItem key={p.id} value={p.id}>
                    {i + 1}. {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="self-end gap-1.5"
            disabled={!subject.trim() || !message.trim() || submitting}
            onClick={() => void submit()}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Submit ticket
          </Button>
        </CardContent>
      </Card>

      {/* ── Your tickets ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Your tickets</h2>
        {tickets.length === 0 && status !== "LoadingFirstPage" ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No tickets yet. We're here when you need us.
          </p>
        ) : (
          tickets.map((t, i) => (
            <motion.div
              key={t._id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
              className="rounded-xl border p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold">{t.subject}</p>
                <Badge variant={STATUS_VARIANTS[t.status] as "default"}>
                  {t.status.replace("_", " ")}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Opened {timeAgo(t._creationTime)}
              </p>
              {t.reply ? (
                <p className="mt-2 rounded-lg bg-muted/60 p-3 text-sm">
                  <span className="font-semibold">Team response: </span>
                  {t.reply}
                </p>
              ) : null}
            </motion.div>
          ))
        )}
        <div ref={ref} />
      </div>

      {/* ── FAQ ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Frequently asked questions</h2>
        <Accordion type="single" collapsible className="w-full">
          {[
            {
              q: "How does PureWire verify content is original?",
              a: "Every post is fingerprinted and checked against the platform before it goes live. If the same content already exists — from anyone, anywhere on PureWire — the duplicate is blocked and you'll be told why. Posts that pass get the green \"Original\" badge.",
            },
            {
              q: "How do I report a post or a user?",
              a: "Open any post, tap the ⋯ menu and choose \"Report post\". Choose what was violated and add details — the post and its author are included automatically so the team can review it quickly.",
            },
            {
              q: "How do I share a post in a direct message?",
              a: "Open the Share dialog on any post and tap \"Send via message\". A New message popup opens right where you are — pick a conversation or search anyone by name or @handle, then send. The person you message sees your caption (end-to-end encrypted) plus a preview card of the post with a View post link. You can also tap Message on someone's profile to open the same popup with them pre-selected.",
            },
            {
              q: "How do I share a post in a comment?",
              a: "Two ways. From the Share dialog on any post, tap \"Share in a comment\" and pick the post you want to comment on. Or, in any comment box (post page, comment popup, or replies), tap \"Attach a post\". You can even just paste a PureWire post link straight into the comment text — it's detected automatically and an \"Attach as card\" offer appears with a live preview. Attach turns the link into a preview card (and removes the link from your text); Dismiss hides the offer. Post the comment and everyone sees the card.",
            },
            {
              q: "Why are comments closed on some posts?",
              a: `A post's author can close comments anytime from the ⋯ menu — that closes the thread for everyone, and "Reopen comments" brings it back. Threads also close on their own once they pass a set age or comment count (${autoClosePolicyPhrase()}) so old, crowded threads stay readable. On a post you wrote, "Keep comments open" opts that thread out of auto-closing, and "Reopen comments" opens a thread back up. When a thread is closed you'll see a lock notice in place of the comment box.`,
            },
            {
              q: "How do I block someone?",
              a: "Open their profile and tap Block. Blocking hides their profile, posts, and notifications from you in both directions, and unfollows them automatically. You can unblock them anytime from their profile.",
            },
            {
              q: "How do I get a verified badge?",
              a: "The moment you verify your email with the one-time code, the verified badge is attached to your account — it proves you're a real person, not a fake. For special cases the team can add or remove badges manually.",
            },
            {
              q: "How do I reset my password?",
              a: "On the sign-in page, tap \"Forgot password\". We'll email you a code — enter it along with a new password and you're back in.",
            },
            {
              q: "Why do I need to verify my email?",
              a: "Email verification keeps fake accounts off the platform and makes sure every profile belongs to a real person. PureWire never stores or shows your plain-text address — only a salted one-way hash and a masked form.",
            },
            {
              q: "How does the Local feed know where I am?",
              a: "The Local tab uses your live browser position — read only while you're browsing and never stored — to find posts shared near you. If you add a home location in Settings, it's kept only as a coarsened ~1 km area. Place search runs on PureWire's own servers, and other members only ever see the label you choose.",
            },
            {
              q: "Does PureWire cost anything?",
              a: "No — PureWire is free to join and free to use, with no hidden fees anywhere: no subscription, no paywall, no premium tier, no pay-to-post, no ads, and no sponsorships. Posting, uploading photos, videos, and audio, sending end-to-end encrypted messages, and downloading your data are all free for every member. The full breakdown of costs, feeds, features, and policies is on the About page.",
            },
            {
              q: "How do I delete my account and all my data?",
              a: "Settings → Your data & privacy → Delete account and all data. One confirmation permanently removes your profile, posts, comments, likes, shares, stories, follows, notifications, tickets, blocks, and every file you uploaded. No soft-delete, no copy kept anywhere.",
            },
          ].map((f, i) => (
            <AccordionItem key={i} value={`faq-${i}`}>
              <AccordionTrigger className="text-left text-sm font-medium">
                {f.q}
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}
