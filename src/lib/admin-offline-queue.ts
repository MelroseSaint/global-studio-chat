import { api } from "@/convex/_generated/api";

/**
 * Offline queue for admin moderation actions.
 *
 * When the connection drops, admin actions (remove account, silence, ban,
 * verify, …) must not silently fail — the admin believes a removal happened
 * when it didn't. Instead the action is stored here, shown as queued, and
 * flushed through the same Convex mutation the moment the connection
 * returns (see AdminOfflineBanner). The queue lives in localStorage so it
 * survives reloads and even a closed PWA until the admin is back online.
 *
 * Design notes:
 * - The queue is per-device (localStorage), matching the admin's own device.
 * - Every entry stores a stable string key into ADMIN_ACTIONS plus the raw
 *   args, so nothing function-shaped is ever serialized.
 * - A change event fires after every write so the banner can re-render.
 * - If storage is unavailable, enqueueAdminAction returns null so the caller
 *   can say so honestly instead of claiming the action was queued.
 */

export const ADMIN_QUEUE_EVENT = "purewire:admin-queue-changed";
const STORAGE_KEY = "purewire.admin.queue.v1";
const MAX_ATTEMPTS = 5;

/** Every admin mutation that participates in the offline queue. */
export const ADMIN_ACTIONS = {
  "admin.removeAccount": api.admin.removeAccount,
  "admin.setVerified": api.admin.setVerified,
  "admin.setRole": api.admin.setRole,
  "admin.moderatePost": api.admin.moderatePost,
  "admin.resolveAiReview": api.admin.resolveAiReview,
  "admin.resolveAiReviewBatch": api.admin.resolveAiReviewBatch,
  "admin.resolveRacismReview": api.admin.resolveRacismReview,
  "admin.resolveRacismReviewBatch": api.admin.resolveRacismReviewBatch,
  "security.setAccountStatus": api.security.setAccountStatus,
  "security.setShadowban": api.security.setShadowban,
  "security.reinstateAccount": api.security.reinstateAccount,
  "security.bulkUnsilence": api.security.bulkUnsilence,
  "support.respondToTicket": api.support.respondToTicket,
} as const;

export type AdminActionKey = keyof typeof ADMIN_ACTIONS;

export interface QueuedAdminAction {
  id: string;
  key: AdminActionKey;
  args: Record<string, unknown>;
  at: number;
  attempts: number;
}

function readQueue(): QueuedAdminAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedAdminAction[]) : [];
  } catch {
    return [];
  }
}

/** Persist the queue; returns false when storage is unavailable or full. */
function writeQueue(queue: QueuedAdminAction[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(ADMIN_QUEUE_EVENT));
  return true;
}

/**
 * Queue an admin action. Returns the stored item, or null when storage is
 * unavailable — the caller must treat null as "not queued" and say so.
 */
export function enqueueAdminAction(
  key: AdminActionKey,
  args: Record<string, unknown>,
): QueuedAdminAction | null {
  const item: QueuedAdminAction = {
    id: crypto.randomUUID(),
    key,
    args,
    at: Date.now(),
    attempts: 0,
  };
  const queue = readQueue();
  queue.push(item);
  return writeQueue(queue) ? item : null;
}

export function listAdminQueue(): QueuedAdminAction[] {
  return readQueue();
}

export function removeAdminAction(id: string): void {
  writeQueue(readQueue().filter((a) => a.id !== id));
}

export function clearAdminQueue(): void {
  writeQueue([]);
}

/** Record a failed flush attempt; true once the item hits the retry cap. */
export function bumpAdminActionAttempt(id: string): boolean {
  const queue = readQueue();
  const item = queue.find((a) => a.id === id);
  if (!item) return true;
  item.attempts += 1;
  const done = item.attempts >= MAX_ATTEMPTS;
  if (done) {
    writeQueue(queue.filter((a) => a.id !== id));
  } else {
    writeQueue(queue);
  }
  return done;
}
