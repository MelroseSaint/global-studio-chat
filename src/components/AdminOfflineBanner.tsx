import { useConvex } from "convex/react";
import { CloudOff, RefreshCw, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  ADMIN_ACTIONS,
  ADMIN_QUEUE_EVENT,
  bumpAdminActionAttempt,
  clearAdminQueue,
  listAdminQueue,
  removeAdminAction,
  type QueuedAdminAction,
} from "@/lib/admin-offline-queue";

/**
 * The offline affordance for the Admin dashboard.
 *
 * When the connection drops, a banner states plainly that admin actions are
 * queued locally and will sync when the connection returns — so a removal,
 * silence or ban can never silently fail while the admin believes it went
 * through. The moment the connection comes back (or the queue is manually
 * flushed), every queued action is replayed through its real Convex
 * mutation, in order, with honest per-item toasts: applied, still retrying,
 * or dropped after repeated failures.
 *
 * The queue is also replayed on mount when the app is already online with a
 * backlog — covering the PWA relaunched after actions were queued in an
 * earlier offline session.
 */
export function AdminOfflineBanner() {
  const convex = useConvex();
  const online = useOnlineStatus();
  const [queue, setQueue] = useState<QueuedAdminAction[]>(() =>
    listAdminQueue(),
  );
  const [flushing, setFlushing] = useState(false);
  // Ref-based in-flight guard: React state is stale within a single render
  // tick, so two flush calls in the same tick must not both replay the queue
  // (which would double-apply every queued action).
  const flushingRef = useRef(false);
  // Start as "was offline" so the first effect run flushes an online mount
  // with a backlog from a previous session.
  const wasOnline = useRef(false);

  // Keep the queue in sync whenever it changes (this tab or another).
  useEffect(() => {
    const refresh = () => setQueue(listAdminQueue());
    window.addEventListener(ADMIN_QUEUE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(ADMIN_QUEUE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    const pending = listAdminQueue();
    if (pending.length === 0) return;
    flushingRef.current = true;
    setFlushing(true);
    let synced = 0;
    let retrying = 0;
    let dropped = 0;
    for (const item of pending) {
      const ref = ADMIN_ACTIONS[item.key];
      try {
        // The queue stores raw args for any registered action, so the ref
        // and args are intentionally widened at the replay boundary.
        await convex.mutation(ref as never, item.args as never);
        removeAdminAction(item.id);
        synced += 1;
      } catch {
        // A flush failure is kept and retried on the next reconnect up to a
        // cap, then dropped so a permanently-broken action can't wedge the
        // queue forever. Either way the admin is told the truth.
        if (bumpAdminActionAttempt(item.id)) {
          dropped += 1;
        } else {
          retrying += 1;
        }
      }
    }
    flushingRef.current = false;
    setFlushing(false);
    setQueue(listAdminQueue());
    if (synced > 0) {
      toast.success(
        synced === 1
          ? "Queued change synced to the platform."
          : `${synced} queued changes synced to the platform.`,
      );
    }
    if (retrying > 0) {
      toast.info(
        retrying === 1
          ? "1 queued change couldn't be sent yet — it will keep retrying."
          : `${retrying} queued changes couldn't be sent yet — they will keep retrying.`,
      );
    }
    if (dropped > 0) {
      toast.error(
        dropped === 1
          ? "1 queued change failed repeatedly and was dropped. Redo it while online."
          : `${dropped} queued changes failed repeatedly and were dropped. Redo them while online.`,
      );
    }
  }, [convex]);

  // Flush when the connection returns, and on mount when already online with
  // a backlog (PWA relaunched while queued actions were pending).
  useEffect(() => {
    if (online && !wasOnline.current) {
      void flush();
    }
    wasOnline.current = online;
  }, [online, flush]);

  if (online && queue.length === 0) return null;

  const count = queue.length;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-oxide/30 bg-oxide/10 px-3 py-2.5 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2">
        {online ? (
          <Wifi className="size-4 shrink-0 text-moss" />
        ) : (
          <CloudOff className="size-4 shrink-0 text-oxide" />
        )}
        <span className="min-w-0">
          {online ? (
            <b>{count} queued change{count === 1 ? "" : "s"} ready to sync</b>
          ) : (
            <>
              <b>You're offline</b> —{" "}
              {count > 0
                ? `${count} change${count === 1 ? "" : "s"} queued, `
                : ""}
              changes will sync when you're back online.
            </>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {count > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void flush()}
            disabled={flushing || !online}
          >
            {flushing ? (
              <RefreshCw className="mr-1 size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 size-3.5" />
            )}
            {flushing ? "Syncing…" : "Sync now"}
          </Button>
        )}
        {!online && count > 0 && (
          <button
            type="button"
            onClick={() => {
              clearAdminQueue();
              setQueue([]);
            }}
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            Discard
          </button>
        )}
      </span>
    </div>
  );
}
