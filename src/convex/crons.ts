import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// Nightly: tell authors whose comment threads the auto-close policy closed
// (age or comment count) and who haven't been told yet. The write-time
// crossing in posts.addComment covers same-day notifications; this sweep
// catches age-crossed posts with no new comments and any count that was
// reconciled across the line. Idempotent via commentsAutoClosedNotifiedAt.
crons.interval(
  "notify-auto-closed-threads",
  { hours: 24 },
  internal.posts.notifyAutoClosedThreads,
);

export default crons;
