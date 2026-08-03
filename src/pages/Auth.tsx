import { useAction, useMutation } from "convex/react";
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
  const verifyBotChallenge = useAction(api.security.verifyBotChallenge);
  const setSessionLifetime = useMutation(api.account.setSessionLifetime);
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
  // "Keep me signed in": the device-level session preference. ON (the
  // default, matching PureWire's permanent-session promise) opts this
  // device into the 10-year session; OFF caps it at 30 days. Persisted
  // locally so the choice survives page reloads. Both reads and writes go
  // through guards — storage can be unavailable (private mode, sandboxed
  // frames) and a SecurityError must never crash the Auth page.
  const [remember, setRemember] = useState<boolean>(() => {
    try {
      return localStorage.getItem("purewire_remember_me") !== "0";
    } catch {
      return true;
    }
  });

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
   *
   * Convex masks plain Errors thrown inside actions at the public HTTP
   * boundary, so credential rejections from the auth library arrive as
   * "Server Error" instead of a real message. Those failures are expected
   * (wrong password, unknown account, expired code, rate limit) — translate
   * them into honest per-flow copy instead of showing a scary outage line.
   *
   * Our own user-facing failures throw ConvexError, whose payload crosses
   * the boundary in `err.data` (the `.message` field is still masked) — so
   * those real messages are surfaced verbatim before any translation.
   */
  const authErrorMessage = (err: unknown, fallback: string): string => {
    const data =
      err instanceof Error && "data" in err
        ? (err as { data?: unknown }).data
        : undefined;
    if (typeof data === "string" && data.length > 0) {
      return data;
    }
    const msg = err instanceof Error ? err.message : fallback;
    if (/invalid token|invalidaccountid|not authenticated/i.test(msg)) {
      void signOut();
    }
    if (/server error/i.test(msg)) {
      if (step === "signup") {
        return "We couldn't create your account. If an account with this email already exists, sign in instead.";
      }
      if (step === "verify") {
        return "That code didn't work. Check the email we sent and try again.";
      }
      if (step === "forgot") {
        return "We couldn't send a reset code to that address. Check the email and try again.";
      }
      if (step === "reset") {
        return "That code didn't work or your new password is too weak. Try again.";
      }
      return "That email and password didn't match. Check them and try again, or reset your password.";
    }
    return msg;
  };

  /**
   * Apply the "Keep me signed in" preference to the session that was just
   * created. ON keeps the permanent 10-year session PureWire promises; OFF
   * caps this device's session at 30 days via account.setSessionLifetime.
   * Best-effort: a failure must never block sign-in — the session simply
   * keeps its platform default (permanent).
   */
  const applySessionLifetime = async () => {
    try {
      await setSessionLifetime({ remember });
    } catch {
      // Best-effort — a preference write must never block sign-in. But a
      // user who turned the toggle OFF asked for a shorter session; if the
      // write failed, the session keeps the permanent default, the opposite
      // of their choice — say so instead of staying silent.
      if (!remember) {
        toast.error(
          "Couldn't set your session preference — you'll stay signed in for 10 years. Try again later.",
        );
      }
    }
  };

  const toggleRemember = (value: boolean) => {
    setRemember(value);
    try {
      localStorage.setItem("purewire_remember_me", value ? "1" : "0");
    } catch {
      // Storage unavailable (private mode) — the preference still applies
      // to this session for as long as the tab stays open.
    }
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
      } else {
        // Session issued directly — apply the keep-me-signed-in preference.
        await applySessionLifetime();
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
      // The verification redeemed a session — apply the keep-me-signed-in
      // preference (covers the sign-up and code sign-in paths).
      await applySessionLifetime();
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
      // The reset also signs the user in — apply the preference.
      await applySessionLifetime();
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

                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          Keep me signed in
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Stay signed in on this device for 10 years. Turn
                          this off on shared devices.
                        </span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={remember}
                        aria-label="Keep me signed in"
                        onClick={() => toggleRemember(!remember)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
                          remember ? "bg-oxide" : "bg-border"
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            remember ? "translate-x-5" : ""
                          }`}
                        />
                      </button>
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
