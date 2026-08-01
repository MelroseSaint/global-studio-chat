import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { STANDARD_PRINCIPLES } from "@/lib/standard";
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

/**
 * Admin action dialog that asks which PureWire Standard principle the
 * action cites. Every removal, restriction, ban, and silence references a
 * stated rule, and the citation is recorded on the account's moderation
 * trail — never an unqualified action.
 */
export function StandardViolationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (standardId: string, note: string) => void;
}) {
  const [standardId, setStandardId] = useState("");
  const [note, setNote] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the form each time the dialog is opened.
        if (next) {
          setStandardId("");
          setNote("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-oxide dark:text-oxide-light" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>PureWire Standard principle violated</Label>
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
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The citation is attached to the account&apos;s moderation record.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the team should know about this action…"
              rows={3}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={standardId.length === 0 || busy}
            onClick={() => onConfirm(standardId, note.trim())}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
