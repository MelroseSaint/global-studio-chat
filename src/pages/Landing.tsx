import { motion } from "framer-motion";
import {
  ArrowRight,
  AtSign,
  BadgeCheck,
  Ban,
  Compass,
  Heart,
  MessageCircle,
  Quote,
  Repeat2,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";

const features = [
  {
    icon: Quote,
    title: "Say it anyway",
    description:
      "Other platforms tell you what you can say. PureWire gives you the space to say it — no corporate curation, no deciding what's acceptable for you.",
  },
  {
    icon: ShieldCheck,
    title: "Every post verified original",
    description:
      "Content is checked against the platform before it goes live. Stolen work and copycats never make it — your voice stays yours.",
  },
  {
    icon: Compass,
    title: "No algorithm, your choice",
    description:
      "Global, Following, Latest, Photos & videos — you pick what you see. Nobody quietly reshapes your feed for you.",
  },
  {
    icon: UserPlus,
    title: "Find your people",
    description:
      "Follow, @mention, and build a circle of the people who actually get you. No forced trends, no engagement bait.",
  },
  {
    icon: BadgeCheck,
    title: "Real people, verified",
    description:
      "Email-verified accounts and verified badges for notable ones — so you know who you're really talking to.",
  },
  {
    icon: Ban,
    title: "No ads, ever",
    description:
      "No advertising, no sponsorships, no algorithm selling your attention. Pure freedom, with a reason.",
  },
];

const steps = [
  {
    title: "Create your account",
    description:
      "Sign up with your email, pick a username, and verify your identity. No phone numbers, no data harvesting.",
  },
  {
    title: "Make it yours",
    description:
      "Upload your photo and banner, write a bio, link your other socials. Your profile belongs to you.",
  },
  {
    title: "Start saying it",
    description:
      "Post, follow creators, drop stories, and join the conversation — on your own terms.",
  },
];

// The PureWire Standard — freedom with a reason. These are the
// lines we draw so freedom can exist for everyone.
const standard = [
  {
    title: "Say what you mean.",
    detail: "Express yourself honestly — that's the whole point.",
  },
  {
    title: "Create what you want.",
    detail: "Your work, your words, your way. Nothing forced.",
  },
  {
    title: "Find your people.",
    detail: "Follow who matters to you and build your own circle.",
  },
  {
    title: "Disagree without destroying each other.",
    detail: "Push back hard on ideas. Never on people.",
  },
  {
    title: "Don't impersonate people.",
    detail: "Real names for real humans. No pretending to be someone else.",
  },
  {
    title: "Don't steal people's work.",
    detail: "Every post is verified original. Credit is owed, not optional.",
  },
  {
    title: "Don't spam the platform.",
    detail: "Share what matters. Repetition and clutter crowd out real voices.",
  },
  {
    title: "Don't use freedom as an excuse to take someone else's freedom away.",
    detail: "Harassment, doxxing, and intimidation end where your freedom begins.",
  },
];

export function Landing() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-8 rounded-xl" />
            <span className="font-bold tracking-tight">PureWire</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/#features">Why PureWire</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/#standard">The Standard</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to={isAuthenticated ? "/home" : "/auth"}>
                {isAuthenticated ? "Open app" : "Get started"}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              background:
                "radial-gradient(700px 420px at 15% 10%, rgba(184,74,50,0.32), transparent), radial-gradient(700px 420px at 85% 15%, rgba(201,121,82,0.26), transparent), radial-gradient(800px 500px at 50% 110%, rgba(70,90,76,0.28), transparent)",
            }}
          />
          <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center gap-8 px-4 py-20 text-center sm:py-28">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="flex flex-col items-center gap-6"
            >
              <span className="inline-flex items-center gap-1.5 rounded-full border border-oxide/30 bg-oxide/10 px-3 py-1 text-xs font-medium text-oxide dark:text-oxide-light">
                <Quote className="size-3" />
                Say it anyway.
              </span>
              <h1 className="max-w-3xl text-4xl font-black tracking-tight sm:text-6xl">
                Other platforms tell you{" "}
                <span className="brand-gradient-text">what you can say.</span>
                <br />
                PureWire gives you the space to say it.
              </h1>
              <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
                A social platform built around expression, connection, and
                freedom — not advertising, corporate sponsorships, or telling
                you how you're supposed to participate. Every post verified
                original. No ads. No algorithm. No copycats.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" asChild>
                  <Link to={isAuthenticated ? "/home" : "/auth"}>
                    {isAuthenticated ? "Open your feed" : "Join PureWire"}
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link to="/#standard">See the PureWire Standard</Link>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {isAuthenticated
                  ? "Welcome back — your feed is waiting."
                  : "Sign up with just an email. Takes less than a minute."}
              </p>
            </motion.div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto w-full max-w-6xl px-4 pb-20">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Built around freedom, not followers
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground sm:text-base">
              PureWire is freedom with a reason: your expression matters, so we
              protect it — from copycats, from ads, from algorithms.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, i) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.4, delay: i * 0.06 }}
              >
                <Card className="h-full transition-transform hover:-translate-y-0.5">
                  <CardContent className="flex flex-col gap-3 p-6">
                    <div className="flex size-10 items-center justify-center rounded-xl brand-gradient-bg text-white">
                      <feature.icon className="size-5" />
                    </div>
                    <h3 className="font-semibold tracking-tight">
                      {feature.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* The PureWire Standard */}
        <section id="standard" className="border-t bg-muted/30">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <div className="mb-2 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-moss/40 bg-moss/10 px-3 py-1 text-xs font-medium text-moss">
                <ShieldCheck className="size-3" />
                Freedom with a reason
              </span>
            </div>
            <div className="mb-10 text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                The PureWire Standard
              </h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
                PureWire isn't "no rules." It's freedom with a reason. The
                Standard exists so your freedom never has to cost someone
                else's.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {standard.map((item, i) => (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                >
                  <Card className="h-full border-oxide/20">
                    <CardContent className="flex h-full flex-col gap-2 p-5">
                      <span className="flex size-7 items-center justify-center rounded-full bg-oxide/15 text-xs font-bold text-oxide dark:text-oxide-light">
                        {i + 1}
                      </span>
                      <p className="font-semibold leading-snug tracking-tight">
                        {item.title}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {item.detail}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
            <div className="mt-10 flex justify-center">
              <Button variant="outline" size="lg" asChild>
                <Link to="/support">
                  Read the full Standard in Support
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="border-t">
          <div className="mx-auto w-full max-w-6xl px-4 py-16">
            <div className="mb-8 text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Getting started is easy
              </h2>
            </div>
            <div className="grid gap-6 sm:grid-cols-3">
              {steps.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className="flex flex-col items-center gap-2 text-center"
                >
                  <span className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    {i + 1}
                  </span>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="max-w-xs text-sm text-muted-foreground">
                    {step.description}
                  </p>
                </motion.div>
              ))}
            </div>
            <div className="mt-10 flex justify-center">
              <Button size="lg" asChild>
                <Link to={isAuthenticated ? "/home" : "/auth"}>
                  {isAuthenticated ? "Back to your feed" : "Create your account"}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Community strip */}
        <section className="mx-auto w-full max-w-6xl px-4 py-16 text-center">
          <div className="mx-auto flex max-w-2xl flex-col items-center gap-4">
            <div className="flex items-center gap-4 text-muted-foreground">
              <MessageCircle className="size-5" />
              <AtSign className="size-5" />
              <Repeat2 className="size-5" />
              <Heart className="size-5" />
            </div>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              Say it anyway.
            </h2>
            <p className="text-sm text-muted-foreground sm:text-base">
              Post your original thoughts, share your moments, and connect with
              people who get you — on a platform that works for you, not for
              advertisers.
            </p>
            <Button size="lg" asChild>
              <Link to={isAuthenticated ? "/home" : "/auth"}>
                {isAuthenticated ? "Open PureWire" : "Get started free"}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-6 rounded-lg" />
            <span className="font-semibold text-foreground">PureWire</span>
          </div>
          <p>
            © {new Date().getFullYear()} PureWire. Say it anyway — no ads, ever.
          </p>
          <div className="flex items-center gap-4">
            <Link to="/auth" className="hover:text-foreground hover:underline">
              Sign in
            </Link>
            <Link to="/support" className="hover:text-foreground hover:underline">
              Support
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
