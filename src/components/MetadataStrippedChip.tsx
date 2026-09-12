import { ShieldCheck } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The tiny "Metadata stripped" note shown over media whose GPS/device data
 * was removed before upload (client re-encode or server-side remux).
 *
 * The wrapper is pointer-events-none so the overlay never swallows clicks
 * on the media (video controls, grid thumbs); the chip itself stays
 * interactive so the tooltip still opens on hover. Screen readers get the
 * meaning from the aria-label, keyboard users don't need the tooltip.
 */
export function MetadataStrippedChip({
  className,
  mediaLabel = "this media",
}: {
  className?: string;
  mediaLabel?: string;
}) {
  return (
    <div className={cn("pointer-events-none absolute left-2 top-2", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm"
            aria-label={`GPS and device metadata was removed from ${mediaLabel} before upload`}
          >
            <ShieldCheck className="size-3" />
            Metadata stripped
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          GPS and device data were removed from this media before it was uploaded.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
