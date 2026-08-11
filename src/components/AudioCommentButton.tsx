import { useAction, useMutation } from "convex/react";
import { Loader2, Mic, Square, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AudioPlayer } from "@/components/AudioPlayer";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { scanMediaBytes } from "@/lib/ai-media-scan";
import { cn } from "@/lib/utils";

/**
 * The attached audio clip — a voice note on a comment.
 *
 * `url` is the Cloudinary secure_url (server-stored reference); `key` is
 * the public_id used for deletions. In Convex-storage fallback mode the
 * item carries a storageId instead (the same dual-mode shape as post
 * media). The bytes themselves never enter Convex — only the reference.
 */
export interface CommentAudio {
  storageId?: Id<"_storage">;
  url?: string;
  key?: string;
  kind: "audio";
  title?: string;
}

/**
 * Voice-note button for comment composers: record from the mic or attach
 * an audio file, scan it for AI/deepfake markers, then upload through the
 * standard prepareUpload pipeline — Cloudinary first (signed), Convex
 * storage as the fallback, exactly like the post composer's media. The
 * result is a single CommentAudio reference handed to the parent, which
 * ships it with addComment.
 *
 * Mirrors the DM/composer privacy pipeline: the ORIGINAL bytes are scanned
 * before upload (removing metadata can never also remove the evidence a
 * file was machine-made) and the clip is capped at 60 seconds of
 * recording / 10 MB of file so a voice note stays a voice note.
 */
export function AudioCommentButton({
  value,
  onChange,
  disabled = false,
}: {
  value: CommentAudio | null;
  onChange: (audio: CommentAudio | null) => void;
  disabled?: boolean;
}) {
  const prepareUpload = useAction(api.media.prepareUpload);
  const discardUploads = useMutation(api.media.discardUploads);
  const inputRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // The active MediaRecorder lives in a ref (not state) so the timer
  // closure — created in the same render that starts recording — always
  // reads the live recorder. A state capture would be null at interval
  // creation and the 60s auto-stop would silently never fire.
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Mirrors `seconds` outside React state so the 60s cap never fires
  // inside a setState updater (double-invoked in StrictMode, and a side
  // effect in an updater is an anti-pattern).
  const secondsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // The live media stream, kept so unmount (or a removed composer) can
  // always release the mic — a closed dialog must never leave the camera/
  // mic indicator on.
  const streamRef = useRef<MediaStream | null>(null);

  // Unmount safety: if the composer disappears mid-recording (dialog
  // closed, post page navigated away), stop the recorder and release the
  // mic instead of leaving the indicator lit forever.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      // A still-active recorder gets one last data event so a recording
      // cut short by unmount still ships its clip — then the mic dies.
      const rec = recorderRef.current;
      if (rec !== null && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // Ignore: the stream may already be gone.
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const startRecording = async () => {
    if (busy || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Voice-note quality is plenty: 16 kHz mono keeps clips tiny.
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;
      // Prefer webm/opus (broad support); fall back to whatever the
      // browser offers for recording.
      const mime =
        typeof MediaRecorder.isTypeSupported === "function" &&
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (chunks.length > 0) {
          void attach(blob);
        } else {
          toast.error("Recording was empty — try again.");
          setBusy(false);
        }
      };
      rec.start(250);
      recorderRef.current = rec;
      setRecording(true);
      setSeconds(0);
      secondsRef.current = 0;
      timerRef.current = window.setInterval(() => {
        // Hard cap at 60s: a voice note stays a voice note. The check
        // reads a ref instead of the state updater so stopping never
        // happens as a side effect of a setState call.
        if (secondsRef.current >= 59) {
          stopRecording();
          return;
        }
        secondsRef.current += 1;
        setSeconds(secondsRef.current);
      }, 1000);
    } catch {
      toast.error(
        "Microphone unavailable. You can attach an audio file instead.",
      );
    }
  };

  const stopRecording = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec !== null && rec.state !== "inactive") {
      rec.stop();
    }
    recorderRef.current = null;
    setRecording(false);
  };

  /** Scan → upload → resolve the stored reference. Shared by record + file. */
  const attach = async (blob: Blob) => {
    setBusy(true);
    try {
      const head = await blob.slice(0, 256 * 1024).arrayBuffer();
      const verdict = scanMediaBytes(head);
      if (verdict.status === "blocked") {
        toast.error(verdict.reason);
        return;
      }
      const ticket = await prepareUpload({ contentType: blob.type });
      if (ticket.mode === "convex") {
        const res = await fetch(ticket.uploadUrl, {
          method: "POST",
          headers: { "Content-Type": blob.type },
          body: blob,
        });
        if (!res.ok) throw new Error("Upload failed");
        const { storageId } = (await res.json()) as { storageId: string };
        onChange({
          storageId: storageId as Id<"_storage">,
          kind: "audio",
        });
      } else {
        const form = new FormData();
        form.append("file", blob, "voice-note.webm");
        if (ticket.apiKey && ticket.timestamp && ticket.signature) {
          form.append("api_key", ticket.apiKey);
          form.append("timestamp", ticket.timestamp);
          form.append("signature", ticket.signature);
          if (ticket.folder) form.append("folder", ticket.folder);
        } else if (ticket.uploadPreset) {
          form.append("upload_preset", ticket.uploadPreset);
        }
        const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
        if (res.ok) {
          const parsed = (await res.json()) as {
            secure_url?: string;
            public_id?: string;
          };
          if (!parsed.secure_url || !parsed.public_id) {
            throw new Error("Upload failed");
          }
          onChange({
            url: parsed.secure_url,
            key: parsed.public_id,
            kind: "audio",
          });
        } else {
          // Resilience, same as the post composer: a Cloudinary failure
          // falls back to Convex storage rather than failing the comment.
          if (typeof ticket.fallbackUrl !== "string") {
            throw new Error("Upload failed");
          }
          const fallback = await fetch(ticket.fallbackUrl, {
            method: "POST",
            headers: { "Content-Type": blob.type },
            body: blob,
          });
          if (!fallback.ok) throw new Error("Upload failed");
          const { storageId } = (await fallback.json()) as { storageId: string };
          onChange({
            storageId: storageId as Id<"_storage">,
            kind: "audio",
          });
        }
      }
    } catch {
      toast.error("Could not upload the voice note. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (value?.key) {
      void discardUploads({
        items: [{ key: value.key, resourceType: "video" }],
      }).catch(() => {
        // Best-effort: a failed delete just leaves a cheap orphan.
      });
    } else if (value?.storageId) {
      void discardUploads({
        items: [{ storageId: value.storageId }],
      }).catch(() => {
        // Best-effort.
      });
    }
    onChange(null);
  };

  const src = value?.url ?? null;

  if (value !== null && src !== null) {
    return (
      <div className="flex w-full items-center gap-1.5">
        <AudioPlayer
          track={{ id: `comment:${value.key ?? value.storageId}`, src }}
          variant="bare"
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label="Remove voice note"
          className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    );
  }

  // A storage-only fallback item (uploading in Convex mode) still shows a
  // remove affordance even though the bytes have no display URL yet.
  if (value !== null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">Voice note attached</span>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label="Remove voice note"
          className="shrink-0 rounded-full p-1.5 transition-colors hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {recording ? (
        <button
          type="button"
          onClick={stopRecording}
          disabled={disabled}
          aria-label={`Stop recording (${seconds}s)`}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1.5 text-xs font-semibold text-destructive transition-colors",
            "hover:bg-destructive/20",
          )}
        >
          <Square className="size-3.5 fill-current" />
          {seconds}s
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void startRecording()}
          disabled={disabled || busy}
          aria-label="Record a voice note"
          title="Record a voice note"
          className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:text-primary"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Mic className="size-4" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy || recording}
        aria-label="Attach an audio file"
        title="Attach an audio file"
        className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:text-primary"
      >
        <Upload className="size-4" />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) {
            toast.error("Keep audio attachments under 10 MB.");
            e.target.value = "";
            return;
          }
          void attach(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
