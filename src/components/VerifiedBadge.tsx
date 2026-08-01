import { BadgeCheck } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function VerifiedBadge({
  className,
  size = "size-4",
}: {
  className?: string;
  size?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full text-white",
            "verified-gradient",
            size,
            className,
          )}
          aria-label="Verified account"
        >
          <BadgeCheck className="size-[70%]" strokeWidth={3} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Verified account</TooltipContent>
    </Tooltip>
  );
}
