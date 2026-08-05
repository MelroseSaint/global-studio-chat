/**
 * Resemble AI voice-detection client.
 *
 * PureWire's zero-tolerance policy extends to AI-generated audio. This module
 * calls Resemble AI's detect endpoint against audio bytes that have been
 * uploaded, returning whether the voice was AI-synthesized. The key is stored
 * in Convex env (RESEMBLE_API_KEY) and never exposed to clients.
 *
 * Resemble AI detect API reference: https://docs.resemble.ai/detect
 * Endpoint: https://f.cluster.resemble.ai/detect
 */

const RESEMBLE_DETECT_URL = "https://f.cluster.resemble.ai/detect";

export interface ResembleDetectResult {
  /** Whether Resemble's model classified this as AI-generated audio. */
  isAi: boolean;
  /** Confidence 0..1 (higher = more confident it's AI). */
  confidence: number;
  /** Raw response for audit/logging (never exposed to clients). */
  raw?: unknown;
}

/**
 * Submit audio bytes to Resemble AI for voice-synthesis detection.
 * Returns null when the API key is not configured (graceful degradation —
 * detection is skipped, never fails an upload).
 */
export async function detectAiVoice(
  audioBytes: ArrayBuffer,
  apiKey: string,
): Promise<ResembleDetectResult | null> {
  if (!apiKey || apiKey.length < 8) return null;

  // Resemble detect requires the file in a multipart/form-data request
  // with the "file" field containing the audio blob.
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBytes], { type: "audio/wav" }),
    "upload.wav",
  );

  const res = await fetch(RESEMBLE_DETECT_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    // 4xx/5xx — log and skip (never block an upload on a third-party outage)
    console.warn(
      `Resemble detect returned ${res.status}: ${await res.text().catch(() => "?")}`,
    );
    return null;
  }

  const json: {
    success?: boolean;
    item?: { is_ai?: boolean; confidence?: number };
  } = await res.json();

  if (!json.success || !json.item) return null;

  return {
    isAi: json.item.is_ai === true,
    confidence: typeof json.item.confidence === "number" ? json.item.confidence : 0,
    raw: json,
  };
}

/**
 * True when the environment has a working Resemble API key configured.
 * Checked server-side before attempting a detection call.
 */
export function resembleConfigured(): boolean {
  const key = process.env.RESEMBLE_API_KEY;
  return typeof key === "string" && key.length >= 8;
}

/** The API key stored in Convex env (never exposed to clients). */
export function resembleApiKey(): string {
  return process.env.RESEMBLE_API_KEY ?? "";
}
