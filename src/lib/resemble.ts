/**
 * Resemble AI deepfake-detection client — v2 API.
 *
 * PureWire's zero-tolerance policy extends to AI-generated audio, images,
 * and video. This module submits media to Resemble's v2 detect endpoint,
 * polls for results, and returns structured verdicts with confidence scores,
 * source tracing, and per-media-type metrics.
 *
 * API reference: https://docs.resemble.ai/detect
 * Base URL:      https://app.resemble.ai/api/v2
 * Auth:          Bearer token from https://app.resemble.ai/account/api
 *
 * The key is stored in Convex env (RESEMBLE_API_KEY) and never exposed
 * to clients. When the key is absent, detection is skipped gracefully —
 * the byte-level metadata scan is the primary guard; Resemble is a
 * second opinion.
 */

const BASE_URL = "https://app.resemble.ai/api/v2";

// ── Public types ─────────────────────────────────────────────────────

export interface ResembleDetectResult {
  /** Whether Resemble classified this as synthetic. */
  isAi: boolean;
  /** Aggregated confidence 0..1 (higher = more confident it's AI). */
  confidence: number;
  /**
   * Per-media-type metrics from the completed detection job:
   * - audio → item.metrics (label, aggregated_score, consistency)
   * - image → item.image_metrics (label, score, reverse_image_search_sources)
   * - video → item.video_metrics (label, score, certainty)
   */
  metrics?: {
    label: string;
    aggregatedScore?: number;
    score?: number;
    consistency?: number;
    certainty?: number;
  };
  /**
   * When audio_source_tracing was enabled and audio was detected as
   * synthetic, this names the likely source platform (e.g. "elevenlabs",
   * "resemble_ai"). Null when the audio was real or tracing was off.
   */
  sourceLabel?: string | null;
  /** Raw response for audit/logging (never exposed to clients). */
  raw?: unknown;
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Submit a file to the detect endpoint. Returns the job UUID. */
async function submitDetectJob(
  fileBytes: ArrayBuffer,
  mimeType: string,
  fileName: string,
  apiKey: string,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${apiKey}` };

  // Try with all privacy/convenience flags first (zero retention +
  // audio source tracing). Some plans don't support zero retention —
  // catch the 400 and retry without it rather than failing.
  for (const flags of [
    { audio_source_tracing: "true", zero_retention_mode: "true" },
    { audio_source_tracing: "true" },
  ]) {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBytes], { type: mimeType }),
      fileName,
    );
    for (const [key, value] of Object.entries(flags)) {
      formData.append(key, value);
    }

    const res = await fetch(`${BASE_URL}/detect`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (res.ok) {
      const json: { item?: { uuid?: string }; success?: boolean } =
        await res.json();
      return json.item?.uuid ?? null;
    }

    const body = await res.text().catch(() => "?");
    // Zero retention not available on this plan — retry without it.
    if (
      res.status === 400 &&
      body.includes("Zero Retention") &&
      flags.zero_retention_mode !== undefined
    ) {
      continue;
    }
    console.warn(`Resemble detect submit returned ${res.status}: ${body}`);
    return null;
  }

  return null;
}

/** Poll GET /detect/{uuid} until completed or failed. */
async function pollDetectJob(
  uuid: string,
  apiKey: string,
  maxWaitMs = 120_000,
): Promise<unknown | null> {
  const start = Date.now();
  const delays = [2000, 2000, 5000, 5000, 10000, 10000, 10000, 10000, 10000, 10000];

  for (const delay of delays) {
    if (Date.now() - start > maxWaitMs) break;

    const res = await fetch(`${BASE_URL}/detect/${uuid}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      console.warn(`Resemble poll ${uuid} returned ${res.status}`);
      return null;
    }

    const json: { item?: { status?: string } } = await res.json();
    const status = json.item?.status;
    if (status === "completed" || status === "failed") return json;
    if (status !== "processing") return null; // unknown terminal state

    await new Promise((r) => setTimeout(r, delay));
  }

  console.warn(`Resemble poll ${uuid} timed out after ${maxWaitMs}ms`);
  return null;
}

/** Extract a unified verdict from the v2 completed job response. */
function parseV2Result(json: unknown): ResembleDetectResult | null {
  const item = (json as Record<string, unknown>)?.item as Record<string, unknown> | undefined;
  if (item === undefined || item.status !== "completed") return null;

  // Audio metrics
  const metrics = item.metrics as Record<string, unknown> | undefined;
  // Image metrics
  const imageMetrics = item.image_metrics as Record<string, unknown> | undefined;
  // Video metrics
  const videoMetrics = item.video_metrics as Record<string, unknown> | undefined;

  // Source tracing (audio only)
  const tracing = item.audio_source_tracing as Record<string, unknown> | undefined;

  if (metrics) {
    // Audio: label "fake"/"real", aggregated_score 0..1
    const label = String(metrics.label ?? "");
    const score = Number(metrics.aggregated_score ?? metrics.score ?? 0);
    return {
      isAi: label === "fake" || score >= 0.5,
      confidence: score,
      metrics: {
        label,
        aggregatedScore: Number(metrics.aggregated_score ?? 0),
        consistency: Number(metrics.consistency ?? 0),
      },
      sourceLabel: tracing?.label ? String(tracing.label) : null,
      raw: json,
    };
  }

  if (imageMetrics) {
    // Image: label "Fake"/"Real", score 0..1
    const label = String(imageMetrics.label ?? "");
    const score = Number(imageMetrics.score ?? 0);
    return {
      isAi: label === "Fake" || score >= 0.5,
      confidence: score,
      metrics: {
        label,
        score: Number(imageMetrics.score ?? 0),
      },
      raw: json,
    };
  }

  if (videoMetrics) {
    // Video: label "Fake"/"Real", score 0..1, certainty
    const label = String(videoMetrics.label ?? "");
    const score = Number(videoMetrics.score ?? 0);
    return {
      isAi: label === "Fake" || score >= 0.5,
      confidence: score,
      metrics: {
        label,
        score: Number(videoMetrics.score ?? 0),
        certainty: Number(videoMetrics.certainty ?? 0),
      },
      raw: json,
    };
  }

  return null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Submit any media (audio, image, or video) to Resemble v2 for deepfake
 * detection. Returns a structured verdict with confidence, per-media-type
 * metrics, and audio source tracing when applicable. Returns null when the
 * API key is absent or the job fails — detection is skipped, never fails
 * an upload.
 */
export async function detectMedia(
  fileBytes: ArrayBuffer,
  mimeType: string,
  fileName: string,
  apiKey: string,
): Promise<ResembleDetectResult | null> {
  if (!apiKey || apiKey.length < 8) return null;

  const uuid = await submitDetectJob(fileBytes, mimeType, fileName, apiKey);
  if (uuid === null) return null;

  const completed = await pollDetectJob(uuid, apiKey);
  if (completed === null) return null;

  return parseV2Result(completed);
}

/**
 * Legacy-compatible audio-only detection. Thin wrapper over detectMedia
 * that preserves the original call signature used in aiContent.ts.
 */
export async function detectAiVoice(
  audioBytes: ArrayBuffer,
  apiKey: string,
): Promise<ResembleDetectResult | null> {
  return detectMedia(audioBytes, "audio/wav", "upload.wav", apiKey);
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
