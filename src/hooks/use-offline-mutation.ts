import { useMutation } from "convex/react";
import { useCallback } from "react";
import { toast } from "sonner";

import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  enqueueAdminAction,
  type AdminActionKey,
} from "@/lib/admin-offline-queue";

/**
 * A useMutation wrapper for admin actions that respects the connection.
 *
 * Online it behaves exactly like useMutation. Offline it does NOT fire the
 * mutation (which would fail silently or throw an unreachable error) —
 * instead it queues the action in localStorage, tells the admin it was
 * queued, and resolves with `{ queued: true }` so the caller can skip its
 * success toast and keep the UI honest.
 *
 * Resolves with:
 * - `undefined` — the mutation actually ran (online).
 * - `{ queued: true }` — stored locally; will sync when the connection
 *   returns.
 * - `{ queued: false }` — offline AND browser storage unavailable; nothing
 *   was applied or queued (an error toast explains it).
 *
 * Callers treat any non-undefined result as "not applied" and skip their
 * success toast.
 *
 * The `key` must exist in ADMIN_ACTIONS so the flush step can replay the
 * action through the same Convex mutation once the connection returns.
 */
export function useOfflineMutation<Args extends Record<string, unknown>>(
  call: Parameters<typeof useMutation>[0],
  key: AdminActionKey,
) {
  const mutate = useMutation(call);
  const online = useOnlineStatus();

  return useCallback(
    async (
      args: Args,
    ): Promise<{ queued: true } | { queued: false } | undefined> => {
      if (online) {
        await mutate(args);
        return undefined;
      }
      const item = enqueueAdminAction(key, args);
      if (item === null) {
        toast.error(
          "Couldn't queue this change — browser storage is unavailable. Reconnect and try again.",
        );
        return { queued: false };
      }
      toast.info(
        "You're offline — this change is queued and will sync when you're back online.",
        {
          description:
            "The action will be sent automatically once the connection returns.",
        },
      );
      return { queued: true };
    },
    [online, mutate, key],
  );
}
