import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";

/**
 * Blocklist tab: the data-driven blocked-domain engine. Lists every entry
 * in the blockedDomains table with its category, action, source, and
 * confidence, lets an admin add, pause, re-categorize, or delete entries
 * without a deploy, manages external sync sources (domain/hosts/adguard/
 * json feeds), and can re-seed the curated core list from phishing.ts. The
 * scan layer (posts, comments, stories, bios, links, and pre-encryption
 * DMs) checks this table on every write — see convex/blocklist.ts.
 */
const BLOCK_CATEGORIES = [
  { value: "adult_explicit", label: "Adult explicit" },
  { value: "adult_creator", label: "Adult creator" },
  { value: "adult_porn", label: "Adult video" },
  { value: "adult_cam", label: "Adult cam" },
  { value: "adult_clips", label: "Adult clips" },
  { value: "adult_chat", label: "Adult chat" },
  { value: "adult_escort", label: "Adult escort" },
  { value: "adult_dating", label: "Adult dating" },
  { value: "adult_fetish", label: "Adult fetish" },
  { value: "adult_community", label: "Adult community" },
  { value: "adult_redirect", label: "Adult redirect" },
  { value: "adult_other", label: "Adult other" },
] as const;

export function BlocklistPanel() {
  const upsert = useMutation(api.blocklist.upsertBlockedDomain);
  const setActive = useMutation(api.blocklist.setBlockedDomainActive);
  const remove = useMutation(api.blocklist.deleteBlockedDomain);
  const importCore = useMutation(api.blocklist.importCoreBlocklist);
  const syncSources = useAction(api.blocklist.syncExternalSources);

  const [category, setCategory] = useState<string>("all");
  const [newDomain, setNewDomain] = useState("");
  const [newCategory, setNewCategory] = useState<string>("adult_other");
  const [newAction, setNewAction] = useState<"block" | "review">("block");
  const [newSubs, setNewSubs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const { results, status, loadMore } = usePaginatedQuery(
    api.blocklist.listBlockedDomains,
    { category: category as "all" },
    { initialNumItems: 25 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(25);
    }
  }, [inView, status, loadMore]);

  const sources = useQuery(api.blocklist.listDomainSources);
  const setSourceEnabled = useMutation(api.blocklist.setDomainSourceEnabled);
  const deleteSource = useMutation(api.blocklist.deleteDomainSource);
  const upsertSource = useMutation(api.blocklist.upsertDomainSource);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceFormat, setSourceFormat] = useState<
    "domain" | "hosts" | "adguard" | "json" | "custom"
  >("domain");

  // URL-pattern blocks: matched as case-insensitive substrings of the raw
  // URL (scheme + host + path), so a whole TLD or link shape can be gated.
  const patterns = useQuery(api.blocklist.listBlockedPatterns);
  const upsertPattern = useMutation(api.blocklist.upsertBlockedPattern);
  const deletePattern = useMutation(api.blocklist.deleteBlockedPattern);
  const [newPattern, setNewPattern] = useState("");
  const [patternCategory, setPatternCategory] = useState("adult_other");
  const [patternAction, setPatternAction] = useState<"block" | "review">("block");

  const domains = (results ?? []) as unknown as {
    _id: string;
    domain: string;
    category: string;
    action: "block" | "review";
    source: string;
    confidence: number;
    blockSubdomains: boolean;
    active: boolean;
    addedAt: number;
  }[];

  const addDomain = async () => {
    const domain = newDomain.trim();
    if (domain.length === 0) return;
    setBusy(true);
    try {
      const res = await upsert({
        domain,
        category: newCategory as
          | "adult_explicit"
          | "adult_creator"
          | "adult_porn"
          | "adult_cam"
          | "adult_clips"
          | "adult_chat"
          | "adult_escort"
          | "adult_dating"
          | "adult_fetish"
          | "adult_community"
          | "adult_redirect"
          | "adult_other",
        action: newAction,
        blockSubdomains: newSubs,
        active: true,
      });
      if (res) return;
      setNewDomain("");
      toast.success(`${domain} is now on the blocklist.`);
    } catch (err) {
      toast.error(errorMessage(err, "Could not add domain."));
    } finally {
      setBusy(false);
    }
  };

  const addSource = async () => {
    setBusy(true);
    try {
      const res = await upsertSource({
        name: sourceName.trim(),
        url: sourceUrl.trim(),
        format: sourceFormat,
        enabled: true,
      });
      if (res) return;
      setSourceName("");
      setSourceUrl("");
      toast.success("Source added — it syncs on the next run.");
    } catch (err) {
      toast.error(errorMessage(err, "Could not add source."));
    } finally {
      setBusy(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await syncSources();
      const summary = res.results
        .map((r) => `${r.name}: ${r.imported}${r.error ? ` (${r.error})` : ""}`)
        .join(" · ");
      setSyncResult(summary || "No enabled sources to sync.");
      toast.success("Blocklist sync finished.");
    } catch (err) {
      toast.error(errorMessage(err, "Sync failed."));
    } finally {
      setSyncing(false);
    }
  };

  const reseed = async () => {
    setBusy(true);
    try {
      const res = await importCore();
      if (res) return;
      toast.success("Core list re-seeded — the static adult rules are back.");
    } catch (err) {
      toast.error(errorMessage(err, "Could not re-seed."));
    } finally {
      setBusy(false);
    }
  };

  const addPattern = async () => {
    const pattern = newPattern.trim();
    if (pattern.length < 2) return;
    setBusy(true);
    try {
      const res = await upsertPattern({
        pattern,
        category: patternCategory,
        action: patternAction,
      });
      if (res) return;
      setNewPattern("");
      toast.success("Pattern added — matching URLs are now handled per its action.");
    } catch (err) {
      toast.error(errorMessage(err, "Could not add pattern."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
        <p>
          The database-backed blocklist: every domain here is rejected (or
          review-queued) across posts, comments, stories, bios, profile
          links, and DMs — checked on the server and, for DMs, on your
          device before anything is encrypted. The curated adult list from
          the platform code seeds this table and can be re-seeded any time.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reseed()}
            disabled={busy}
          >
            <RefreshCw className="size-3.5" />
            Re-seed core list
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runSync()}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync now
          </Button>
          {syncResult ? (
            <span className="max-w-full truncate text-xs">{syncResult}</span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border p-3">
        <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Plus className="size-3.5" />
          Add a blocked domain
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="example.com"
            className="max-w-44"
          />
          <Select value={newCategory} onValueChange={setNewCategory}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLOCK_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={newAction}
            onValueChange={(v) => setNewAction(v as "block" | "review")}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="block">Block</SelectItem>
              <SelectItem value="review">Review</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={newSubs}
              onChange={(e) => setNewSubs(e.target.checked)}
            />
            Block subdomains
          </label>
          <Button
            size="sm"
            onClick={() => void addDomain()}
            disabled={busy || newDomain.trim().length === 0}
          >
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Filter:</span>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {BLOCK_CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {status === "LoadingFirstPage" &&
        Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      {domains.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No blocked domains in this view. Re-seed the core list to restore
          the platform&apos;s curated adult rules, or add one above.
        </p>
      )}
      {domains.map((d, i) => {
        const label =
          BLOCK_CATEGORIES.find((c) => c.value === d.category)?.label ?? d.category;
        return (
          <motion.div
            key={d._id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.3) }}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-sm font-semibold">
                <Globe className="size-4 shrink-0 text-muted-foreground" />
                {/* break-all: a long domain is an unbroken string that would
                    otherwise overflow the card on a tablet row */}
                <span className="break-all">{d.domain}</span>
              </span>
              <Badge variant="outline">{label}</Badge>
              <Badge variant={d.action === "block" ? "destructive" : "outline"}>
                {d.action === "block" ? "Block" : "Review"}
              </Badge>
              {d.blockSubdomains ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  subdomains
                </span>
              ) : null}
              <span className="text-[11px] text-muted-foreground">
                {d.source} · {Math.round(d.confidence * 100)}%
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant={d.active ? "outline" : "default"}
                size="sm"
                onClick={() => void setActive({ domain: d.domain, active: !d.active })}
              >
                {d.active ? "Pause" : "Activate"}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                aria-label={`Remove ${d.domain}`}
                onClick={() => void remove({ domain: d.domain })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </motion.div>
        );
      })}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>

      <div className="flex flex-col gap-2 rounded-xl border p-3">
        <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Globe className="size-3.5" />
          URL patterns — matched as a substring of the full link
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="e.g. .win or /free-claim"
            className="max-w-52"
          />
          <Select value={patternCategory} onValueChange={setPatternCategory}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLOCK_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={patternAction}
            onValueChange={(v) => setPatternAction(v as "block" | "review")}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="block">Block</SelectItem>
              <SelectItem value="review">Review</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => void addPattern()}
            disabled={busy || newPattern.trim().length < 2}
          >
            Add pattern
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {patterns === undefined ? (
            <Skeleton className="h-10" />
          ) : patterns.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No URL patterns. A pattern gates every link that contains it —
              handy for whole scam TLDs or link shapes that change domains.
            </p>
          ) : (
            patterns.map((p) => (
              <div
                key={p._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono">“{p.pattern}”</span>
                  <Badge variant={p.action === "block" ? "destructive" : "outline"}>
                    {p.action === "block" ? "Block" : "Review"}
                  </Badge>
                  <span className="truncate text-muted-foreground">
                    {BLOCK_CATEGORIES.find((c) => c.value === p.category)?.label ??
                      p.category}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  aria-label={`Remove pattern ${p.pattern}`}
                  onClick={() => void deletePattern({ pattern: p.pattern })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <RefreshCw className="size-3.5" />
            Domain feeds — sources that sync into the blocklist
          </p>
          {sources !== undefined && sources.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {sources.filter((s) => s.enabled).length} enabled ·{" "}
              {sources.filter((s) => !s.enabled).length} paused ·{" "}
              {sources.filter((s) => s.lastError).length} with errors
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            placeholder="Source name"
            className="max-w-36"
          />
          <Input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://example.com/blocklist.txt"
            className="min-w-56 max-w-72"
          />
          <Select
            value={sourceFormat}
            onValueChange={(v) =>
              setSourceFormat(
                v as "domain" | "hosts" | "adguard" | "json" | "custom",
              )
            }
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="domain">One per line</SelectItem>
              <SelectItem value="hosts">Hosts file</SelectItem>
              <SelectItem value="adguard">AdGuard</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => void addSource()}
            disabled={busy || sourceName.trim().length === 0}
          >
            Add source
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {sources === undefined ? (
            <Skeleton className="h-10" />
          ) : sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No feeds registered yet. The built-in PureWire adult lists are
              added automatically on the first sync, or add one above.
            </p>
          ) : (
            sources.map((s) => (
              <div
                key={s._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 font-semibold">
                    {s.name}
                    <Badge
                      variant={s.enabled ? "default" : "outline"}
                      className={s.enabled ? "bg-primary/10 text-primary" : ""}
                    >
                      {s.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      {s.format}
                    </Badge>
                    {s.lastError ? (
                      <Badge variant="destructive">Error</Badge>
                    ) : null}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {s.enabled ? "Picks up on every sync" : "Not synced until enabled"}
                    {s.lastSuccessfulSyncAt
                      ? ` · last synced ${timeAgo(s.lastSuccessfulSyncAt)}`
                      : " · never synced yet"}
                  </span>
                  {s.lastError ? (
                    <span className="truncate text-destructive">
                      {s.lastError}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void setSourceEnabled({ name: s.name, enabled: !s.enabled })
                    }
                  >
                    {s.enabled ? "Pause" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    aria-label={`Remove source ${s.name}`}
                    onClick={() => void deleteSource({ name: s.name })}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
