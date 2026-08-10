import { motion } from "framer-motion";
import {
  Database,
  EyeOff,
  FileDown,
  Fingerprint,
  Lock,
  ScanSearch,
  ShieldCheck,
  Trash2,
  UserX,
} from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";

const neverStored = [
  {
    icon: EyeOff,
    title: "No tracking, ever",
    detail:
      "No analytics, no telemetry, no cookies, no pixels, no third-party embeds. Nothing on PureWire watches what you do, where you click, or how long you stay.",
  },
  {
    icon: Lock,
    title: "No plain-text email on any surface",
    detail:
      "Every page, query, and export shows only a salted one-way SHA-256 hash — a random server-side secret is mixed in before hashing, so even a stolen database can't be run against lookup tables. The secret is versioned: if it ever needed to be rotated, every stored hash is re-salted in a single pass — no account waits for its next sign-in to be protected. The raw address exists only inside the sign-in service, where it is required to deliver your one-time code and let you sign in; it never appears on any page, query, or export.",
  },
  {
    icon: Database,
    title: "No exact location, no device data",
    detail:
      "PureWire never stores your exact location, contacts, device fingerprints, browser details, or browsing history. If you add a home location, it is stored only as a coarsened ~1 km area — never the precise point — and only the label you choose is shown publicly. The Local feed's live 'near me' mode reads your browser position to build that one request and never stores it. Place search runs on PureWire's own servers, so your browser never talks to a third-party geocoder. IP addresses are never written to persistent logs.",
  },
  {
    icon: Fingerprint,
    title: "No advertising profiles",
    detail:
      "There are no ads and no sponsorships, so there is nothing to profile you for. Your attention is not a product.",
  },
  {
    icon: Lock,
    title: "No readable direct messages",
    detail:
      "Direct messages are end-to-end encrypted in your browser before a single byte leaves your device. PureWire stores only unreadable ciphertext — never the plaintext, never the keys. Even a full database copy contains nothing that can be read, so there is nothing to hand over, subpoena, or pull. A safety check runs on your own device before a message is encrypted: links that match known scam patterns — pages posing as PureWire, credential-harvesting lures — are caught or flagged right there, so even the protection never makes the plaintext leave the browser.",
  },
  {
    icon: ShieldCheck,
    title: "Your media is scrubbed",
    detail:
      "Photos are processed in your own browser before upload: hidden EXIF metadata — GPS coordinates, camera serials, device info — is stripped, and images are resized and compressed. Raw camera files with embedded location data never reach PureWire's servers. Videos get the same treatment twice: most clips are re-encoded in your browser, and every video is remuxed again on PureWire's servers — GPS, camera, and device atoms are stripped from the container before it is ever served. A video can never leak where or on what it was filmed. Posts whose media was scrubbed carry a tiny \"Metadata stripped\" note on the media itself, so it is always visible that GPS and device data were removed before upload.",
  },
  {
    icon: ScanSearch,
    title: "AI provenance is checked, not collected",
    detail:
      "To keep PureWire human-made, uploaded files are inspected in memory for AI-generator metadata, invisible watermarks (like Google's SynthID), and Content Credentials (C2PA) manifests. The scan reads the file's own provenance and returns only a verdict — clean, needs review, or blocked — and, when a manifest declares a camera capture, a \"Content Credentials verified\" label on the post. No image is stored, analyzed, or retained by the scan itself; the checked bytes are your uploaded file and nothing more.",
  },
];

const stored = [
  {
    title: "Your account",
    detail:
      "Username, display name, bio, links, photo and banner, your email's salted one-way hash, your verified status, and a home-location label you choose — stored with a coarsened ~1 km anchor (never your exact coordinates) so the Local feed can center itself when you're not granting live location.",
  },
  {
    title: "What you post",
    detail:
      "Your posts, stories, comments, and the files you upload. Photos are stored after metadata stripping and compression, so the stored copy contains no GPS or device data. Videos are remuxed on PureWire's servers so the stored copy carries no GPS or device atoms either. Stories expire and are deleted automatically after 24 hours.",
  },
  {
    title: "Your session",
    detail:
      "One sign-in credential per device, held by your browser so you don't re-enter your password on every visit. Sessions persist until you sign out — up to 10 years on the permanent default, or 30 days if you turned off \"Keep me signed in\" at sign-in. Signing out, or ending a session from Settings, deletes that stored credential. On a shared device, sign out when you're done — that's the one step that clears the sign-in token from the machine.",
  },
  {
    title: "Your direct messages",
    detail:
      "Encrypted message bodies and attachments (ciphertext only), plus who messaged whom and when — the metadata the mailbox needs to route them. The keys live only on the devices of the two people talking: the private half of your encryption key is generated in your browser and never sent to PureWire. A device that has never opened a conversation cannot decrypt it, by design — and no server, admin, or authority can read it either. The conversation key for each thread you open is cached on that device so history stays readable; anything that can read your device's storage can read your unlocked conversations, so sign out of your account on shared machines. A scam-link check runs on your device before each message is encrypted; it inspects only the message you're about to send and records nothing.",
  },
  {
    title: "Your activity",
    detail:
      "Follows, likes, shares, and notifications — the records that make the platform work for you.",
  },
  {
    title: "Safety signals",
    detail:
      "Short-lived rate-limit markers, a risk score used only to spot bots, farms, and stolen content, and — when the automated scanners flag a post — the reason it was flagged (what the scan found) and the Content Credentials verdict, so a human reviewer can judge the flag. These are used to protect the platform and never leave it.",
  },
  {
    title: "Support tickets",
    detail:
      "Tickets you open, plus any post or account you report, so the team can act. Replies and status are shown to you.",
  },
];

const retention = [
  {
    title: "Stories",
    detail: "24 hours. Then the story and its file are deleted automatically.",
  },
  {
    title: "Rate-limit markers",
    detail: "Rolling one-hour windows that clear themselves as you use the platform.",
  },
  {
    title: "Sessions",
    detail:
      "Until you sign out — up to 10 years on the permanent default (30 days if you opted out of \"Keep me signed in\"). The browser-stored sign-in credential is deleted when the session ends, and you can sign out of every other device from Settings at any time.",
  },
  {
    title: "Direct messages",
    detail:
      "Until you delete the conversation — which removes it for both people, with no copy existing anywhere — or until your account is erased, which deletes every conversation you were part of, for everyone.",
  },
  {
    title: "Link-scan evidence",
    detail:
      "30 days. To keep adult platforms and scams off PureWire, a link that appears in a post, bio, comment, or story is checked against the blocklist and the verdict is recorded as an unreadable hash (never your link text) plus the blocked domain and timestamp. That evidence is retained for 30 days so a block can be audited or appealed, then deleted automatically — the hash-only record that remains can't be traced back to you.",
  },
  {
    title: "Everything else",
    detail: "Kept only as long as your account exists — and erased the moment you ask.",
  },
];

const rights = [
  {
    icon: Trash2,
    title: "Delete your account, delete everything",
    detail:
      "One action in Settings permanently removes your profile, posts, comments, likes, shares, stories, follows, notifications, tickets, blocks — and every file you uploaded. No soft-delete, no copy kept anywhere.",
  },
  {
    icon: UserX,
    title: "You are in control",
    detail:
      "Nothing is saved about you that you did not create or do. There is no data to request, because there is no hidden data.",
  },
  {
    icon: ShieldCheck,
    title: "The highest-tier safeguards",
    detail:
      "Salted email hashes, bot checks at signup, per-account rate limits, EXIF-stripped media, isolated storage, encrypted transport, and human moderation against bots, farms, deepfakes, and AI-generated content — protecting you and your original work.",
  },
  {
    icon: Lock,
    title: "No backdoors. Nothing to seize.",
    detail:
      "Law enforcement, governments, or any third party cannot obtain readable private data from PureWire — because readable private data does not exist here. Direct messages are end-to-end encrypted with keys that live only on the devices of the people talking: no server, no administrator, and no subpoena can decrypt them, and there is no master key and no backdoor. Plain-text email addresses, precise locations, and tracking logs are never stored or exposed — the raw address exists only inside the sign-in service, where it is required to deliver your one-time code, and it never appears on any page, query, or export. Whatever anyone demands, there is nothing readable to hand over.",
  },
  {
    icon: UserX,
    title: "Moderation is report-driven, never surveillance",
    detail:
      "Admins act only when something is reported by another member or flagged by the platform's own automated safeguards (bots, farms, duplicates, AI-generated content) — and even then they see no private data: no plain-text emails, no locations, no message contents, because those never exist in readable form. Every action cites a principle of the PureWire Standard and is written to the moderation audit trail. Nobody on PureWire watches you; people only act when someone says something needs looking at.",
  },
];

export function Privacy() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center">
            <img
              src="/lockup.svg"
              alt="PureWire — say it anyway"
              className="h-10 w-auto"
            />
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
            <ShieldCheck className="size-3" />
            Data & transparency
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
            Zero data is saved.{" "}
            <span className="brand-gradient-text">That&apos;s the point.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            PureWire keeps only what it needs to work — and nothing else. No
            tracking. No analytics. No ad profiles. No hidden records. This page
            is the complete, plain-language inventory of what we hold, why, for
            how long, and how you erase all of it with one action.
          </p>
        </motion.div>

        {/* What we never store */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold tracking-tight">
            What PureWire never stores
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {neverStored.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
              >
                <Card className="h-full">
                  <CardContent className="flex flex-col gap-2 p-5">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-oxide/15 text-oxide dark:text-oxide-light">
                      <item.icon className="size-4" />
                    </div>
                    <h3 className="font-semibold tracking-tight">{item.title}</h3>
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* What we store */}
        <section className="mb-10">
          <h2 className="mb-1 text-xl font-bold tracking-tight">
            What we store, and why
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Everything below exists for one reason only: to make the platform
            you&apos;re using work. There is no data collected in the background.
          </p>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <Database className="mr-2 inline size-4 text-primary" />
                The complete inventory
              </CardTitle>
              <CardDescription>
                Each item is created by your own actions — nothing is gathered
                passively.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-4 sm:grid-cols-1">
                {stored.map((s) => (
                  <li key={s.title} className="flex items-start gap-3">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                    <div>
                      <p className="font-semibold leading-snug">{s.title}</p>
                      <p className="text-sm text-muted-foreground">{s.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* Retention */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold tracking-tight">
            How long data lives
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {retention.map((r) => (
              <Card key={r.title}>
                <CardContent className="p-5">
                  <h3 className="font-semibold tracking-tight">{r.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {r.detail}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Rights */}
        <section className="mb-10">
          <h2 className="mb-4 text-xl font-bold tracking-tight">
            Your rights, built in
          </h2>
          <div className="grid gap-4 sm:grid-cols-1">
            {rights.map((r) => (
              <Card key={r.title} className="border-oxide/20">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl brand-gradient-bg text-white">
                    <r.icon className="size-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold tracking-tight">{r.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {r.detail}
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
            <FileDown className="size-8 text-moss" />
            <h2 className="text-lg font-bold tracking-tight">
              Your data stays yours — or it&apos;s gone
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Sign in, open Settings, and delete your account and all data with
              one confirmation. There is no waiting period and no hidden copy.
            </p>
            <Button asChild>
              <Link to={isAuthenticated ? "/settings" : "/auth"}>
                {isAuthenticated ? "Go to Settings" : "Sign in to manage your data"}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-6 rounded-lg" />
            <span className="font-semibold text-foreground">PureWire</span>
          </div>
          <p>© {new Date().getFullYear()} PureWire. Say it anyway — no ads, ever.</p>
          <div className="flex items-center gap-4">
            <Link to="/about" className="hover:text-foreground hover:underline">
              About
            </Link>
            <Link to="/terms" className="hover:text-foreground hover:underline">
              Terms
            </Link>
            <Link to="/" className="hover:text-foreground hover:underline">
              Home
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
