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

const VIOLATIONS = [
  "Copied or stolen content",
  "Repetitive or spam content",
  "Harassment or bullying",
  "Impersonation or fake account",
  "Misinformation",
  "Inappropriate content",
  "Other",
];

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
  const [violation, setViolation] = useState<string>("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!violation) {
      toast.error("Please choose what was violated.");
      return;
    }
    setSubmitting(true);
    try {
      await createTicket({
        subject: `Report: ${violation}`,
        message: details.trim() || "No additional details provided.",
        postId,
        offenderId: offenderId ?? undefined,
        violation,
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
          setViolation("");
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
                the team what was violated and we&apos;ll review it.
              </>
            ) : (
              <>Tell the team what was violated and we&apos;ll review it.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>What was violated?</Label>
            <Select value={violation} onValueChange={setViolation}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {VIOLATIONS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
