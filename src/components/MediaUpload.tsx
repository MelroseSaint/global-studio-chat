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
import { scanImageBytes, scanMediaBytes } from "@/lib/ai-media-scan";
import { processImageFile, processVideoFile } from "@/lib/media";
import { computeImageHashes, computeVideoHashes } from "@/lib/perceptual-hash";
import { cn } from "@/lib/utils";

export type MediaKind = "image" | "video" | "audio";
export interface MediaItem {
  storageId: Id<"_storage">;
  kind: MediaKind;
  url: string;
  // Perceptual hash variants of this item, computed here in the browser
  // (original + mirrored + center-crop for images, sampled frames for
  // video). Passed to createPost as mediaHashes so the server can catch
  // flipped/cropped/re-encoded copies that defeat the exact fingerprint.
  hashes?: string[];
}

function kindFromMime(type: string): MediaKind {
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
  // "optimizing" shows while a video is being re-encoded client-side — a
  // short clip takes up to its own length to process, so the user should
  // know the upload isn't stuck.
  const [optimizing, setOptimizing] = useState(false);

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
        const kind = kindFromMime(file.type);
        // Privacy-first pipeline, run entirely in the user's browser:
        // 1. Scan the ORIGINAL bytes for AI-generator/deepfake markers
        //    BEFORE any stripping, so removing metadata never also removes
        //    the evidence that media was machine-made.
        // 2. Re-encode locally so raw camera files with hidden location
        //    data never reach PureWire's servers, and so videos store at a
        //    few MB instead of hundreds — high quality, tiny footprint.
        let uploadFile = file;
        if (kind === "image") {
          // Metadata lives at the head of the file — only read the header
          // the scanner actually inspects, not the whole image.
          const head = await file.slice(0, 256 * 1024).arrayBuffer();
          const verdict = scanImageBytes(head);
          if (verdict.status === "blocked") {
            toast.error(verdict.reason);
            continue;
          }
          const processed = await processImageFile(file);
          uploadFile = processed.processed ? processed.file : file;
        } else if (kind === "video") {
          const head = await file.slice(0, 256 * 1024).arrayBuffer();
          const verdict = scanMediaBytes(head);
          if (verdict.status === "blocked") {
            toast.error(verdict.reason);
            continue;
          }
          setOptimizing(true);
          try {
            const processed = await processVideoFile(file);
            uploadFile = processed.processed ? processed.file : file;
          } finally {
            setOptimizing(false);
          }
        }
        const url = await generateUploadUrl();
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": uploadFile.type },
          body: uploadFile,
        });
        if (!response.ok) throw new Error("Upload failed");
        const { storageId } = (await response.json()) as { storageId: string };
        // Fingerprint the exact bytes that are stored (the processed file
        // for images), so server-side duplicate matching sees the same
        // pixels. Hashing is best-effort — a failure never blocks upload.
        let hashes: string[] | undefined;
        if (kind === "image") {
          hashes = await computeImageHashes(uploadFile);
        } else if (kind === "video") {
          hashes = await computeVideoHashes(uploadFile);
        }
        items.push({
          storageId: storageId as Id<"_storage">,
          kind: kindFromMime(uploadFile.type),
          url: URL.createObjectURL(uploadFile),
          hashes,
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
      {optimizing ? (
        <p className="w-full text-xs text-muted-foreground">
          <Loader2 className="mr-1 inline size-3 animate-spin" />
          Optimizing video — quality stays high, size drops to a few MB…
        </p>
      ) : null}
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
