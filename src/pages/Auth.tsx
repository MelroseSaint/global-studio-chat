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
import { isValidUsername } from "@/lib/format";

type Step =
  | "signin"
  | "signup"
  | "verify"
  | "forgot"
  | "reset";

export function Auth() {
  const { isLoading, isAuthenticated, signIn } = useAuth();
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
  };

  const submitSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn("password", {
        email: email.trim(),
        password,
        flow: "signIn",
      });
      if (result && "signingIn" in result && !result.signingIn) {
        setStep("verify");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials.");
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
    setSubmitting(true);
    try {
      const result = await signIn("password", {
        email: email.trim(),
        password,
        username,
        name,
        flow: "signUp",
      });
      if (result && "signingIn" in result && !result.signingIn) {
        setStep("verify");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create account.");
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
        email: email.trim(),
        code,
        flow: "email-verification",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn("password", {
        email: email.trim(),
        flow: "reset",
      });
      setStep("reset");
      toast.success("Reset code sent. Check your inbox.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send reset code.");
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
    setSubmitting(true);
    try {
      await signIn("password", {
        email: email.trim(),
        code,
        newPassword: password,
        flow: "reset-verification",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code.");
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
                  <p className="text-center text-xs text-muted-foreground">
                    Didn&apos;t get the code? Check your spam folder or{" "}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => {
                        setStep("signin");
                        setCode("");
                      }}
                    >
                      try again
                    </button>
                    .
                  </p>
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
                By continuing, you agree to PureWire&apos;s Terms of Service and
                the PureWire Standard.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
