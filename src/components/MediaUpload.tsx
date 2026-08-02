import { useAction, useMutation } from "convex/react";
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
  // Dual-mode: a Convex storage id (legacy/fallback) OR an external
  // Cloudinary url + key (primary path once CLOUDINARY_* is configured).
  // Exactly one mode is set per item.
  storageId?: Id<"_storage">;
  // The final external Cloudinary URL. Client-side preview uses `url`.
  externalUrl?: string;
  // The Cloudinary public_id, kept so deletions know the asset.
  key?: string;
  kind: MediaKind;
  // Blob preview URL, client-side only — never sent to the server.
  url: string;
  // Perceptual hash variants of this item, computed here in the browser
  // (original + mirrored + center-crop for images, sampled frames for
  // video). Passed to createPost as mediaHashes so the server can catch
  // flipped/cropped/re-encoded copies that defeat the exact fingerprint.
  hashes?: string[];
  // True when this file was actually re-encoded in the browser (metadata
  // stripped). The server-side video remux also sets it. Powers the tiny
  // "Metadata stripped" note next to the post's media.
  stripped?: boolean;
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
  const prepareUpload = useAction(api.media.prepareUpload);
  const discardUploads = useMutation(api.media.discardUploads);
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
        // Whether this file's metadata was actually removed before upload.
        // The privacy pipeline is best-effort: a re-encode that fails or a
        // file that already qualifies as lean keeps the original bytes, and
        // then no stripping happened client-side (the server-side video
        // remux may still catch it — that path sets stripped on its own).
        let stripped = false;
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
          stripped = processed.processed;
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
            stripped = processed.processed;
          } finally {
            setOptimizing(false);
          }
        }
        // One ticket per file — it carries the rate-limit check plus either
        // a Convex POST URL (fallback) or a Cloudinary upload URL + unsigned
        // preset (primary path).
        const ticket = await prepareUpload({ contentType: uploadFile.type });
        if (ticket.mode === "convex") {
          const response = await fetch(ticket.uploadUrl, {
            method: "POST",
            headers: { "Content-Type": uploadFile.type },
            body: uploadFile,
          });
          if (!response.ok) throw new Error("Upload failed");
          const { storageId } = (await response.json()) as { storageId: string };
          items.push({
            storageId: storageId as Id<"_storage">,
            kind: kindFromMime(uploadFile.type),
            url: URL.createObjectURL(uploadFile),
            hashes: await hashesFor(uploadFile, kind),
            stripped: stripped || undefined,
          });
        } else {
          // Cloudinary mode: POST the file + unsigned preset straight to the
          // upload API. The bytes never pass through Convex — only the tiny
          // secure_url + public_id are stored.
          const form = new FormData();
          form.append("file", uploadFile);
          form.append("upload_preset", ticket.uploadPreset);
          const response = await fetch(ticket.uploadUrl, {
            method: "POST",
            body: form,
          });
          if (response.ok) {
            const parsed = (await response.json()) as {
              secure_url?: string;
              public_id?: string;
            };
            if (!parsed.secure_url || !parsed.public_id) {
              throw new Error("Upload failed");
            }
            items.push({
              externalUrl: parsed.secure_url,
              key: parsed.public_id,
              kind: kindFromMime(uploadFile.type),
              url: URL.createObjectURL(uploadFile),
              hashes: await hashesFor(uploadFile, kind),
              stripped: stripped || undefined,
            });
          } else {
            // Resilience: a Cloudinary failure — a missing/renamed unsigned
            // preset, a restricted key, a quota block — must never break
            // uploads for users. The ticket always carries a Convex upload
            // URL (minted alongside it), so the same bytes are re-posted to
            // Convex storage instead and the upload succeeds exactly as the
            // fallback path would. The user notices nothing; only the
            // console notes the detour.
            console.warn(
              "PureWire: Cloudinary upload failed (HTTP " +
                response.status +
                "), falling back to Convex storage.",
            );
            if (typeof ticket.fallbackUrl !== "string") {
              throw new Error("Upload failed");
            }
            const fallback = await fetch(ticket.fallbackUrl, {
              method: "POST",
              headers: { "Content-Type": uploadFile.type },
              body: uploadFile,
            });
            if (!fallback.ok) throw new Error("Upload failed");
            const { storageId } = (await fallback.json()) as {
              storageId: string;
            };
            items.push({
              storageId: storageId as Id<"_storage">,
              kind: kindFromMime(uploadFile.type),
              url: URL.createObjectURL(uploadFile),
              hashes: await hashesFor(uploadFile, kind),
              stripped: stripped || undefined,
            });
          }
        }
      }
      onChange([...value, ...items]);
    } catch {
      toast.error("Could not upload media. Please try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = (id: string) => {
    const item = value.find(
      (i) => (i.key ?? i.storageId) === id || i.url === id,
    );
    if (item?.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
    onChange(value.filter((i) => (i.key ?? i.storageId) !== id && i.url !== id));
    // Items that never made it into a post/story are orphans: no document
    // references them, so no deletion path ever fires. Release the object
    // immediately — best-effort, never blocks the UI. Both modes are
    // covered: Cloudinary public_ids and Convex storage ids (the fallback
    // path when Cloudinary is misconfigured).
    if (item?.key) {
      void discardUploads({
        items: [
          {
            key: item.key,
            resourceType: item.kind === "image" ? "image" : "video",
          },
        ],
      }).catch(() => {
        // Best-effort: a failed delete just leaves a cheap orphan.
      });
    } else if (item?.storageId) {
      void discardUploads({
        items: [{ storageId: item.storageId }],
      }).catch(() => {
        // Best-effort: a failed delete just leaves a cheap orphan.
      });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((item) => (
        <div
          key={item.key ?? item.storageId}
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
            onClick={() => remove(item.key ?? item.storageId ?? item.url)}
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

/** Best-effort perceptual hashes of the exact stored bytes. */
async function hashesFor(
  file: File,
  kind: MediaKind,
): Promise<string[] | undefined> {
  try {
    if (kind === "image") return await computeImageHashes(file);
    if (kind === "video") return await computeVideoHashes(file);
    return undefined;
  } catch {
    return undefined;
  }
}
