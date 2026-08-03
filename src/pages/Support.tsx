import { useMutation, usePaginatedQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  LifeBuoy,
  Loader2,
  MessageSquarePlus,
  Send,
  ShieldCheck,
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
import { timeAgo } from "@/lib/format";
import { standardById, STANDARD_PRINCIPLES } from "@/lib/standard";

const FAQS = [
  {
    q: "What is the PureWire Standard?",
    a: "PureWire isn't 'no rules' — it's freedom with a reason. The Standard is the short list of lines we draw so everyone's freedom can exist: say what you mean, create what you want, find your people, disagree without destroying each other, don't impersonate people, don't steal people's work, don't spam the platform, and never use freedom as an excuse to take someone else's freedom away. That last one is the most important — PureWire is freedom with a reason, not an unmoderated free-for-all.",
  },
  {
    q: "How does PureWire verify content is original?",
    a: "Every post is fingerprinted and checked against the platform before it goes live. If the same content already exists — from anyone, anywhere on PureWire — the duplicate is blocked and you'll be told why. Posts that pass get the green “Original” badge.",
  },
  {
    q: "What does “pure freedom” mean on PureWire?",
    a: "PureWire is built around expression, connection, and freedom — not advertising, corporate sponsorships, or telling people how they're supposed to participate. You're free to post whatever you create — text, photos, video, audio — with no ads, no algorithms, and no copycats. The one requirement: the content must be yours and original.",
  },
  {
    q: "How do I report a post or a user?",
    a: "Open any post, tap the ⋯ menu and choose “Report post”. Choose what was violated and add details — the post and its author are included automatically so the team can review it quickly.",
  },
  {
    q: "Is AI-generated content allowed on PureWire?",
    a: "No. PureWire is for human expression — 'say it anyway' means your voice, not a machine's. Text, images, audio, and video must be made by you. Every post is scanned for AI-generated text and AI-generator image metadata before it goes live, and anything suspicious is reviewed by the team. Report AI content anytime with the ⋯ menu → “Report post” → “AI-generated content”.",
  },
  {
    q: "How does PureWire protect against bots, farms, and deepfakes?",
    a: "Three layers. Signup screening: every new account is checked against bot and farm signals — disposable email domains, machine-like usernames, placeholder names — and suspicious accounts are held for a human review, with their content kept off the public feed until they're approved. Activity budgets: posts, comments, likes, shares, and follows run against per-account rate limits so automated floods can't take over. Media checks: images and video are scanned for AI-generator and deepfake metadata before they go live, and every video is remuxed on PureWire's servers so GPS and device metadata are stripped before it's ever served. Scans read what's baked into the file, so nothing is treated as final on its own — anything ambiguous goes to a human review queue, and you can report a bot, farm, or deepfake at any time. Accounts confirmed as bots, farms, or manipulators are restricted or banned, and their content is hidden platform-wide.",
  },
  {
    q: "Does PureWire quietly limit accounts?",
    a: "Sometimes, and always for a reason. Accounts that repeatedly trip our safeguards — posting the same content, flooding the platform, or pushing manipulated media — may have their reach quietly limited instead of being confronted. Nothing is deleted without review, the account itself stays open, and a human in our team makes the final call. If you believe your account was limited, open a support ticket and we'll take a look right away.",
  },
  {
    q: "How do I block someone?",
    a: "Open their profile and tap Block. Blocking hides their profile, posts, and notifications from you in both directions, and unfollows them automatically. You can unblock them anytime from their profile.",
  },
  {
    q: "What content is not allowed on PureWire?",
    a: "PureWire protects your freedom to express yourself — but freedom with a reason means harassment, doxxing, intimidation, impersonation, stolen work, spam, AI-generated content, and illegal content are against the Standard. You can report anything you see; the lines exist so one person's freedom never costs another's.",
  },
  {
    q: "How do I get a verified badge?",
    a: "The moment you verify your email with the one-time code, the verified badge is attached to your account — it proves you're a real person, not a fake. For special cases the team can add or remove badges manually; open a support ticket if you have questions.",
  },
  {
    q: "How do I reset my password?",
    a: "On the sign-in page, tap “Forgot password”. We'll email you a code — enter it along with a new password and you're back in.",
  },
  {
    q: "Why do I need to verify my email?",
    a: "Email verification keeps fake accounts off the platform and makes sure every profile belongs to a real person. When your one-time code is redeemed, your account is verified and the badge is attached automatically. And for your privacy, PureWire never stores or shows your plain-text address — only a salted one-way hash and a masked form.",
  },
  {
    q: "What data does PureWire store about me?",
    a: "Very little, and only what you create: your username, display name, bio, links, photo and banner, a salted one-way SHA-256 hash of your email (never the plain-text address), your posts and stories, your comments, likes, shares and follows, notifications, and support tickets. Stories are deleted automatically after 24 hours. Photos and videos are stored with GPS and device metadata stripped — images in your browser, videos on PureWire's servers too. If you add a home location, only a coarsened ~1 km area is stored — never your exact coordinates — and only its label is public. There is no tracking, no analytics, no cookies, and no advertising profile of any kind.",
  },
  {
    q: "How do I delete my account and all my data?",
    a: "Settings → Your data & privacy → Delete account and all data. One confirmation permanently removes your profile, posts, comments, likes, shares, stories, follows, notifications, tickets, blocks, and every file you uploaded. No soft-delete, no copy kept anywhere. The full plain-language inventory is on the Privacy page.",
  },
  {
    q: "How does the Local feed know where I am?",
    a: "The Local tab uses your live browser position — read only while you're browsing and never stored — to find posts shared near you. If you add a home location in Settings (search a place or use your current location), it's kept only as a coarsened ~1 km area, so the Local feed still works when you haven't granted live location. Place search runs on PureWire's own servers, and other members only ever see the label you choose.",
  },
  {
    q: "Where can I read PureWire's full transparency statement?",
    a: "On the Privacy page — it lists exactly what we store and why, what we never store (tracking, analytics, cookies, exact location, plain-text email), how long data lives, and the one-action right to erasure.",
  },
]

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

      {/* The PureWire Standard — freedom with a reason */}
      <Card className="border-oxide/25">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-oxide dark:text-oxide-light" />
            The PureWire Standard
          </CardTitle>
          <CardDescription>
            PureWire isn&apos;t &ldquo;no rules.&rdquo; It&apos;s freedom with a
            reason. Say what you mean — and never use your freedom to take
            someone else&apos;s away.
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

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Frequently asked questions</h2>
        <Accordion type="single" collapsible className="w-full">
          {FAQS.map((f, i) => (
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
