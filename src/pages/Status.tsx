import { useQuery } from "convex/react";
import {
  Activity,
  CheckCircle2,
  Database,
  MessagesSquare,
  Users,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function formatCount(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function Status() {
  const status = useQuery(api.status.systemStatus);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <div className="flex items-center gap-2">
        <Activity className="size-5 text-emerald-500" />
        <h1 className="text-xl font-bold">System status</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        PureWire's health, measured live from the backend — no support ticket
        needed. Anyone can check the platform is up and growing.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card
          className={
            status?.status === "operational"
              ? "border-emerald-500/40"
              : "border-amber-500/40"
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {status?.status === "operational" ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <Activity className="size-4 text-amber-500" />
              )}
              Platform
            </CardTitle>
            <CardDescription>
              {status?.status === "operational"
                ? "All systems operational"
                : "Checking…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Database className="size-3.5" />
                Read path latency
              </span>
              <span className="font-mono tabular-nums">
                {status?.database?.latencyMs !== undefined
                  ? `${status.database.latencyMs} ms`
                  : "—"}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Activity className="size-3.5" />
                Checked
              </span>
              <span className="font-mono tabular-nums">
                {status?.checkedAt
                  ? new Date(status.checkedAt).toLocaleTimeString()
                  : "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4 text-oxide" />
              Community
            </CardTitle>
            <CardDescription>Live platform totals</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Members
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCount(status?.scale?.users)}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Posts
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCount(status?.scale?.posts)}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Stories
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCount(status?.scale?.stories)}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Messages
              </p>
              <p className="text-lg font-bold tabular-nums">
                {formatCount(status?.scale?.dmMessages)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessagesSquare className="size-3.5" />
        Totals are live counts from the database — updated on every visit.
        PureWire stores no tracking data and never logs who checks this page.
      </p>
    </div>
  );
}
