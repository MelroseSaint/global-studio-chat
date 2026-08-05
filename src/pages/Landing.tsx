import { motion } from "framer-motion";
import {
  ArrowRight,
  AtSign,
  BadgeCheck,
  Ban,
  Compass,
  Heart,
  KeyRound,
  LogOut,
  Mail,
  MessageCircle,
  Quote,
  Repeat2,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";

type LandingUser = NonNullable<ReturnType<typeof useAuth>["user"]>;

/**
 * The signed-in member's account menu on the landing header — the one place
 * on the PWA's start screen (start_url "/") where someone already signed in
 * can open the app, reach their profile, or sign out without having to
 * navigate into the app shell and hunt through the mobile More menu. The
 * same dropdown the app shell uses, so the experience is consistent.
 */
function LandingUserMenu({
  user,
  onSignOut,
}: {
  user: LandingUser;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const username = user.username ?? "";
  const profileTo = username ? `/u/${username}` : "/settings";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 rounded-xl p-0.5 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="Account menu"
        >
          <UserAvatar user={user} className="size-7" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">
            {user.name ?? user.username ?? "Member"}
            {user.verified ? " ✓" : ""}
          </p>
          <p className="text-xs text-muted-foreground">@{user.username}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" onSelect={() => navigate("/home")}>
          Home
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={() => navigate(profileTo)}
        >
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={() => navigate("/settings")}
        >
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className="cursor-pointer"
          onSelect={onSignOut}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
      "Verify your email with a one-time code and the verified badge is yours — so you know who you're really talking to.",
  },
  {
    icon: Ban,
    title: "No ads, ever",
    description:
      "No advertising, no sponsorships, no algorithm selling your attention. Pure freedom, with a reason.",
  },
  {
    icon: Sparkles,
    title: "Human-made only",
    description:
      "No AI-generated text, images, audio, or video. PureWire is for your words and your work — not a machine's.",
  },
];

const steps = [
  {
    title: "Create your account",
    description:
      "Sign up with your email, pick a username, and verify your identity with a one-time code. No phone numbers, no data harvesting.",
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
  {
    title: "No AI-generated content.",
    detail: "Say it yourself. Text, images, audio, and video must be made by human hands.",
  },
  {
    title: "No adult platforms.",
    detail:
      "Adult subscription, cam, video, and chat sites can't be shared, posted, or linked on PureWire.",
  },
];

export function Landing() {
  const { isAuthenticated, user, signOut } = useAuth();
  const location = useLocation();

  const handleSignOut = () => {
    void signOut();
  };

  // Scroll a section into view (offset for the sticky header) and update the
  // URL hash so the page reflects where the user is. Uses the History API
  // directly instead of relying on React Router's hash handling, which can
  // silently drop same-path hash-only navigations.
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    window.history.replaceState(null, "", `/#${id}`);
  };

  // Direct deep links (e.g. loading /#standard from a bookmark or an
  // external link) still need the router to finish painting before we
  // measure, so the scroll lands on the right spot.
  useEffect(() => {
    const id = location.hash.replace("#", "");
    if (id.length === 0) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [location.hash]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-8 rounded-xl" />
            <span className="font-bold tracking-tight">PureWire</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => scrollToSection("features")}
            >
              Why PureWire
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => scrollToSection("standard")}
            >
              The Standard
            </Button>
            {isAuthenticated ? (
              <>
                <Button size="sm" asChild>
                  <Link to="/home">
                    Open app
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                {user ? (
                  <LandingUserMenu user={user} onSignOut={handleSignOut} />
                ) : null}
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/auth">Sign in</Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/auth">
                    Get started
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </>
            )}
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
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => scrollToSection("standard")}
                >
                  See the PureWire Standard
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

        {/* Join PureWire — the two ways in, and the no-guest promise */}
        <section
          id="join"
          className="scroll-mt-16 border-y bg-muted/30"
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-14">
            <div className="mb-8 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-moss/40 bg-moss/10 px-3 py-1 text-xs font-medium text-moss">
                <BadgeCheck className="size-3" />
                Real people only
              </span>
              <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
                Two ways to join. Both verified.
              </h2>
              <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground sm:text-base">
                Every account belongs to a real person who verified a real
                email — so you always know who you&apos;re talking to.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.4 }}
              >
                <Card className="h-full transition-transform hover:-translate-y-0.5">
                  <CardContent className="flex flex-col gap-3 p-6">
                    <div className="flex size-10 items-center justify-center rounded-xl brand-gradient-bg text-white">
                      <KeyRound className="size-5" />
                    </div>
                    <h3 className="font-semibold tracking-tight">
                      Your password
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Join with a password you choose. No third-party logins,
                      no social accounts, no one else in your account.
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.4, delay: 0.1 }}
              >
                <Card className="h-full transition-transform hover:-translate-y-0.5">
                  <CardContent className="flex flex-col gap-3 p-6">
                    <div className="flex size-10 items-center justify-center rounded-xl brand-gradient-bg text-white">
                      <Mail className="size-5" />
                    </div>
                    <h3 className="font-semibold tracking-tight">
                      A one-time email code
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      A single-use code lands in your inbox to confirm the
                      account is really yours — and it&apos;s what earns your
                      verified badge.
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            </div>
            <p className="mt-8 text-center text-xs text-muted-foreground">
              No guest accounts, no throwaway signups — one inbox gets one
              verified badge. If an email isn&apos;t yours, it can&apos;t become an
              account.
            </p>
          </div>
        </section>

        {/* Features */}
        <section
          id="features"
          className="scroll-mt-16 mx-auto w-full max-w-6xl px-4 pb-20"
        >
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
        <section id="standard" className="scroll-mt-16 border-t bg-muted/30">
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
        <section id="how" className="scroll-mt-16 border-t">
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
            <Link to="/privacy" className="hover:text-foreground hover:underline">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-foreground hover:underline">
              Terms
            </Link>
            <Link to="/status" className="hover:text-foreground hover:underline">
              Status
            </Link>
            {isAuthenticated ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="hover:text-foreground hover:underline"
              >
                Sign out
              </button>
            ) : (
              <Link to="/auth" className="hover:text-foreground hover:underline">
                Sign in
              </Link>
            )}
            <Link to="/support" className="hover:text-foreground hover:underline">
              Support
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
