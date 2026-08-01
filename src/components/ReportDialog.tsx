import { useMutation } from "convex/react";
import { Flag, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { standardById, STANDARD_PRINCIPLES } from "@/lib/standard";

// Reports cite the PureWire Standard principle that was broken. "other" is
// the only free-form option; everything else maps to a stated rule.
const OTHER = "other";

export function ReportDialog({
  open,
  onOpenChange,
  postId,
  offenderId,
  offenderUsername,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  postId: Id<"posts">;
  offenderId?: Id<"users"> | null;
  offenderUsername: string | null;
}) {
  const createTicket = useMutation(api.support.createTicket);
  // Standard principle id, or OTHER for a free-form report.
  const [standardId, setStandardId] = useState<string>("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!standardId) {
      toast.error("Please choose what was violated.");
      return;
    }
    setSubmitting(true);
    try {
      const principle =
        standardId === OTHER ? undefined : standardById(standardId);
      await createTicket({
        subject: `Report: ${principle?.title ?? "Other"}`,
        message: details.trim() || "No additional details provided.",
        postId,
        offenderId: offenderId ?? undefined,
        violation: principle?.title ?? "Other",
        ...(principle !== undefined
          ? { standardId: principle.id }
          : {}),
      });
      toast.success("Report submitted. Our team will review it.");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit report.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the form each time the dialog is opened.
        if (next) {
          setStandardId("");
          setDetails("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="size-4 text-destructive" />
            Report this post
          </DialogTitle>
          <DialogDescription>
            {offenderUsername ? (
              <>
                You&apos;re reporting a post by{" "}
                <span className="font-medium">@{offenderUsername}</span>. Tell
                the team which PureWire Standard principle was broken and
                we&apos;ll review it.
              </>
            ) : (
              <>Tell the team which PureWire Standard principle was broken.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Which PureWire Standard principle was violated?</Label>
            <Select value={standardId} onValueChange={setStandardId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a principle" />
              </SelectTrigger>
              <SelectContent>
                {STANDARD_PRINCIPLES.map((p, i) => (
                  <SelectItem key={p.id} value={p.id}>
                    {i + 1}. {p.title}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER}>Other</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              PureWire is freedom with a reason — reports are reviewed against
              the Standard, and the principle you choose is attached to the
              report.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Details (optional)</Label>
            <Textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Add any context that helps our team review this report…"
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Submit report"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
