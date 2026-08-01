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
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/format";

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
    q: "What content is not allowed on PureWire?",
    a: "PureWire protects your freedom to express yourself — but freedom with a reason means harassment, doxxing, intimidation, impersonation, stolen work, spam, and illegal content are against the Standard. You can report anything you see; the lines exist so one person's freedom never costs another's.",
  },
  {
    q: "How do I get a verified badge?",
    a: "Verified badges are granted to authentic, notable accounts so you can trust who you're talking to. The team reviews accounts manually — reach out via a support ticket if you believe your account qualifies.",
  },
  {
    q: "How do I reset my password?",
    a: "On the sign-in page, tap “Forgot password”. We'll email you a code — enter it along with a new password and you're back in.",
  },
  {
    q: "Why do I need to verify my email?",
    a: "Email verification keeps fake accounts off the platform and makes sure every profile belongs to a real person. You'll verify once when you join.",
  },
  {
    q: "Are there tools for creators?",
    a: "Yes — creators get a special badge on their profile and extra visibility. Send a support ticket to apply for the creator program.",
  },
];

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
      await createTicket({
        subject: subject.trim(),
        message: message.trim(),
      });
      toast.success("Ticket submitted. We'll get back to you.");
      setSubject("");
      setMessage("");
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
          review it. You can track everything right here.
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
