import { useMutation } from "convex/react";
import {
  AudioLines,
  Film,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MediaKind = "image" | "video" | "audio";
export interface MediaItem {
  storageId: Id<"_storage">;
  kind: MediaKind;
  url: string;
}

export function kindFromMime(type: string): MediaKind {
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "image";
}

export function MediaUpload({
  value,
  onChange,
  max = 4,
  compact = false,
}: {
  value: MediaItem[];
  onChange: (items: MediaItem[]) => void;
  max?: number;
  compact?: boolean;
}) {
  const generateUploadUrl = useMutation(api.media.generateUploadUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (value.length + files.length > max) {
      toast.error(`You can attach up to ${max} files.`);
      return;
    }
    setUploading(true);
    try {
      const items: MediaItem[] = [];
      for (const file of Array.from(files)) {
        const url = await generateUploadUrl();
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!response.ok) throw new Error("Upload failed");
        const { storageId } = (await response.json()) as { storageId: string };
        items.push({
          storageId: storageId as Id<"_storage">,
          kind: kindFromMime(file.type),
          url: URL.createObjectURL(file),
        });
      }
      onChange([...value, ...items]);
    } catch {
      toast.error("Could not upload media. Please try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = (storageId: string) => {
    const item = value.find((i) => i.storageId === storageId);
    if (item?.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
    onChange(value.filter((i) => i.storageId !== storageId));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((item) => (
        <div
          key={item.storageId}
          className={cn(
            "group relative overflow-hidden rounded-lg border bg-muted",
            compact ? "size-16" : "size-20",
          )}
        >
          {item.kind === "image" && (
            <img
              src={item.url}
              alt=""
              className="size-full object-cover"
            />
          )}
          {item.kind === "video" && (
            <div className="flex size-full items-center justify-center bg-black/80">
              <Film className="size-6 text-white" />
            </div>
          )}
          {item.kind === "audio" && (
            <div className="flex size-full items-center justify-center bg-black/80">
              <AudioLines className="size-6 text-white" />
            </div>
          )}
          <button
            type="button"
            onClick={() => remove(item.storageId)}
            className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Remove media"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {value.length < max && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={uploading}
          className={cn("rounded-lg", compact ? "size-16" : "size-20")}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Plus className="size-5" />
          )}
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
    </div>
  );
}
