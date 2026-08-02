import { useMutation } from "convex/react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  BadgeCheck,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mail,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { Turnstile } from "@/components/Turnstile";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { isValidUsername, normalizeEmailIdentity } from "@/lib/format";

const TURNSTILE_SITE_KEY =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";

/** How long a user must wait before requesting another code. */
const RESEND_COOLDOWN_SECONDS = 30;

type Step = "signin" | "signup" | "verify" | "forgot" | "reset";

export function Auth() {
  const { isLoading, isAuthenticated, signIn, signOut } = useAuth();
  const verifyBotChallenge = useMutation(api.security.verifyBotChallenge);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const returnTo = searchParams.get("returnTo") ?? "/home";

  const [step, setStep] = useState<Step>("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botFailed, setBotFailed] = useState(false);
  // Seconds left before "Send it again" unlocks. Started at 30 whenever a
  // code is sent, so codes can't be spammed by hammering the resend button.
  const [resendIn, setResendIn] = useState(0);

  // Tick the resend countdown down once per second; stops at zero.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  /**
   * Human-only gate: every flow that triggers an email (signup, sign-in,
   * forgot, reset) must pass the Turnstile check when a site key is
   * configured. When the challenge is disabled (no key set), this is a no-op
   * so the platform keeps working until keys are added.
   */
  const gateBot = async (): Promise<boolean> => {
    if (!TURNSTILE_SITE_KEY) {
      return true;
    }
    if (!botToken) {
      setBotFailed(true);
      setError("Please complete the security check first.");
      return false;
    }
    try {
      const result = await verifyBotChallenge({ token: botToken });
      // Fail closed on a partial setup: if the widget is shown (site key
      // configured) but the server has no secret key, the challenge reports
      // disabled — a silent pass would turn the defense off. Surface it.
      if (!result.ok || (TURNSTILE_SITE_KEY && !result.enabled)) {
        setBotFailed(true);
        setError(
          result.enabled === false
            ? "The security check isn't configured yet. Please try again later."
            : "The security check didn't pass. Please try again.",
        );
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Security check failed.");
      return false;
    }
  };

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(returnTo, { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate, returnTo]);

  if (!isLoading && isAuthenticated) {
    return null;
  }

  const switchStep = (s: Step) => {
    setStep(s);
    setError(null);
    setCode("");
    setBotToken(null);
    setBotFailed(false);
  };

  /**
   * Normalize an auth error for display. A stored token can outlive its
   * account (deleted session) — the client then attaches that dead token to
   * every auth call and the server rejects with "Invalid token". When that
   * happens, clear the stale session so the next attempt starts clean.
   */
  const authErrorMessage = (err: unknown, fallback: string): string => {
    const msg = err instanceof Error ? err.message : fallback;
    if (/invalid token|invalidaccountid|not authenticated/i.test(msg)) {
      void signOut();
    }
    return msg;
  };

  const submitSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!(await gateBot())) return;
    setSubmitting(true);
    try {
      const result = await signIn("password", {
        email: normalizeEmailIdentity(email),
        password,
        flow: "signIn",
      });
      if (result && "signingIn" in result && !result.signingIn) {
        setStep("verify");
        setResendIn(RESEND_COOLDOWN_SECONDS);
      }
    } catch (err) {
      setError(authErrorMessage(err, "Invalid credentials."));
    } finally {
      setSubmitting(false);
    }
  };

  const submitSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidUsername(username)) {
      setError(
        "Username must be 3-24 characters: lowercase letters, numbers, and underscores only.",
      );
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!(await gateBot())) return;
    setSubmitting(true);
    try {
      const result = await signIn("password", {
        email: normalizeEmailIdentity(email),
        password,
        username,
        name,
        flow: "signUp",
      });
      if (result && "signingIn" in result && !result.signingIn) {
        setStep("verify");
        setResendIn(RESEND_COOLDOWN_SECONDS);
      }
    } catch (err) {
      setError(authErrorMessage(err, "Could not create account."));
    } finally {
      setSubmitting(false);
    }
  };

  const submitVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn("password", {
        email: normalizeEmailIdentity(email),
        code,
        flow: "email-verification",
      });
    } catch (err) {
      setError(authErrorMessage(err, "Invalid code."));
    } finally {
      setSubmitting(false);
    }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!(await gateBot())) return;
    setSubmitting(true);
    try {
      await signIn("password", {
        email: normalizeEmailIdentity(email),
        flow: "reset",
      });
      setStep("reset");
      toast.success("Reset code sent. Check your inbox.");
    } catch (err) {
      setError(authErrorMessage(err, "Could not send reset code."));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * "Send it again": re-request a verification code for the same address.
   * The account already exists at this point (created at signup or present
   * at sign-in) and isn't verified yet, so re-running the sign-in flow sends
   * a fresh code to the same email. Gated by a 30-second cooldown so codes
   * can't be spammed; the first code already passed the bot check.
   */
  const resendCode = async () => {
    if (resendIn > 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn("password", {
        email: normalizeEmailIdentity(email),
        password,
        flow: "signIn",
      });
      setResendIn(RESEND_COOLDOWN_SECONDS);
      toast.success("A new code is on its way — check your inbox.");
    } catch (err) {
      setError(authErrorMessage(err, "Couldn't send a new code."));
    } finally {
      setSubmitting(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!(await gateBot())) return;
    setSubmitting(true);
    try {
      await signIn("password", {
        email: normalizeEmailIdentity(email),
        code,
        newPassword: password,
        flow: "reset-verification",
      });
    } catch (err) {
      setError(authErrorMessage(err, "Invalid code."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      {/* Ambient background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(600px 400px at 20% 10%, rgba(184,74,50,0.28), transparent), radial-gradient(600px 400px at 80% 20%, rgba(201,121,82,0.24), transparent), radial-gradient(700px 500px at 50% 110%, rgba(70,90,76,0.26), transparent)",
        }}
      />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-6">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.svg" alt="PureWire" className="size-8 rounded-xl" />
          <span className="font-bold tracking-tight">PureWire</span>
        </Link>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeft className="size-4" />
            Back to home
          </Link>
        </Button>
      </header>

      <main className="relative flex flex-1 items-center justify-center px-4 pb-16">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="w-full max-w-md"
        >
          <Card className="border-border/60 bg-card/70 backdrop-blur">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl tracking-tight">
                {step === "signin" && "Welcome back"}
                {step === "signup" && "Create your account"}
                {step === "verify" && "Verify your email"}
                {step === "forgot" && "Reset your password"}
                {step === "reset" && "Choose a new password"}
              </CardTitle>
              <p className="text-xs font-medium uppercase tracking-widest text-oxide dark:text-oxide-light">
                Say it anyway.
              </p>
              <CardDescription>
                {step === "signin" && "Sign in to PureWire to continue."}
                {step === "signup" &&
                  "Join PureWire — it takes less than a minute."}
                {step === "verify" &&
                  `We sent a verification code to ${email}. Enter it below to activate your account.`}
                {step === "forgot" &&
                  "Enter your email and we'll send you a reset code."}
                {step === "reset" &&
                  "Enter the code from your email and a new password."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              {step === "signin" || step === "signup" ? (
                <>
                  <Tabs
                    value={step}
                    onValueChange={(v) => switchStep(v as Step)}
                  >
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="signin">Sign in</TabsTrigger>
                      <TabsTrigger value="signup">Sign up</TabsTrigger>
                    </TabsList>
                  </Tabs>

                  <form
                    onSubmit={step === "signin" ? submitSignIn : submitSignUp}
                    className="flex flex-col gap-4"
                  >
                    {step === "signup" && (
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="username">Username</Label>
                        <div className="relative">
                          <UserRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="username"
                            required
                            autoCapitalize="none"
                            autoCorrect="off"
                            placeholder="yourname"
                            className="pl-9"
                            value={username}
                            onChange={(e) =>
                              setUsername(
                                e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                              )
                            }
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="email">Email</Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="email"
                          type="email"
                          required
                          autoCapitalize="none"
                          autoCorrect="off"
                          placeholder="you@email.com"
                          className="pl-9"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </div>
                    </div>

                    {step === "signup" && (
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="name">Full name (optional)</Label>
                        <Input
                          id="name"
                          placeholder="Your name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          required
                          placeholder="••••••••"
                          className="pl-9 pr-10"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((s) => !s)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          aria-label="Toggle password visibility"
                        >
                          {showPassword ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                      </div>
                      {step === "signin" && (
                        <button
                          type="button"
                          onClick={() => switchStep("forgot")}
                          className="self-end text-xs font-medium text-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>

                    {TURNSTILE_SITE_KEY ? (
                      <div className="flex flex-col gap-1">
                        <Turnstile
                          onToken={setBotToken}
                          onError={() => setBotFailed(true)}
                        />
                        {botFailed && !botToken ? (
                          <p className="text-xs text-destructive">
                            Complete the security check to continue.
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    <Button type="submit" size="lg" disabled={submitting}>
                      {submitting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : step === "signin" ? (
                        "Sign in"
                      ) : (
                        "Create account"
                      )}
                    </Button>
                  </form>
                </>
              ) : null}

              {step === "verify" && (
                <form onSubmit={submitVerify} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="code">Verification code</Label>
                    <Input
                      id="code"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      className="text-center font-mono text-lg tracking-[0.5em]"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                    />
                  </div>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={submitting || code.length !== 6}
                  >
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <BadgeCheck className="size-4" />
                        Verify and continue
                      </>
                    )}
                  </Button>
                  <div className="flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
                    <p>Didn&apos;t get the code? Check your spam folder.</p>
                    {resendIn > 0 ? (
                      <p className="font-medium tabular-nums text-foreground">
                        Send it again in {Math.floor(resendIn / 60)}:
                        {String(resendIn % 60).padStart(2, "0")}
                      </p>
                    ) : (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={resendCode}
                        className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {submitting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          "Send it again"
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline"
                      onClick={() => {
                        setStep("signin");
                        setCode("");
                      }}
                    >
                      Used a different email? Go back
                    </button>
                  </div>
                </form>
              )}

              {step === "forgot" && (
                <form onSubmit={submitForgot} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="forgot-email">Email</Label>
                    <Input
                      id="forgot-email"
                      type="email"
                      required
                      autoCapitalize="none"
                      placeholder="you@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  {TURNSTILE_SITE_KEY ? (
                    <Turnstile
                      onToken={setBotToken}
                      onError={() => setBotFailed(true)}
                    />
                  ) : null}
                  <Button type="submit" size="lg" disabled={submitting}>
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <Sparkles className="size-4" />
                        Send reset code
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => switchStep("signin")}
                  >
                    Back to sign in
                  </Button>
                </form>
              )}

              {step === "reset" && (
                <form onSubmit={submitReset} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="reset-code">Reset code</Label>
                    <Input
                      id="reset-code"
                      required
                      inputMode="numeric"
                      placeholder="123456"
                      className="text-center font-mono text-lg tracking-[0.5em]"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="new-password">New password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      required
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  {TURNSTILE_SITE_KEY ? (
                    <Turnstile
                      onToken={setBotToken}
                      onError={() => setBotFailed(true)}
                    />
                  ) : null}
                  <Button
                    type="submit"
                    size="lg"
                    disabled={submitting || code.length !== 6}
                  >
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      "Reset password"
                    )}
                  </Button>
                </form>
              )}

              <p className="text-center text-xs text-muted-foreground">
                By continuing, you agree to{" "}
                <Link
                  to="/terms"
                  className="font-medium text-primary hover:underline"
                >
                  PureWire&apos;s Terms of Service
                </Link>
                , the{" "}
                <Link
                  to="/privacy"
                  className="font-medium text-primary hover:underline"
                >
                  Privacy Policy
                </Link>
                , and the PureWire Standard.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
