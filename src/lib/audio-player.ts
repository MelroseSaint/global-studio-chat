/**
 * PureWire's centralized audio playback engine.
 *
 * One store, one audio element. Every AudioPlayer in the app binds to this
 * singleton, so only one source plays at a time, every instance of the
 * same track reflects the same state, and a mini now-playing bar can
 * survive navigation. The store is a plain event emitter (no React
 * dependency) so any surface — feed cards, story viewer, DMs, the mini
 * bar — can read and drive it; the useAudioPlayer hook subscribes to it.
 *
 * Design rules:
 * - Never autoplay without a user gesture. Persisted state (volume, mute,
 *   rate, position, last track) is restored on boot as PAUSED; the
 *   browser's own autoplay policy still applies to any programmatic play.
 * - Positions are persisted per track id, so returning to a post resumes
 *   where the listener left off without reloading the whole file
 *   (preload="metadata").
 * - Waveforms are decoded lazily (on demand) and cached by track id, so a
 *   feed full of audio posts only decodes what actually scrolls into view.
 */

export interface AudioTrack {
  /** Stable identity — the same id in two places means the same playback. */
  id: string;
  src: string;
  title?: string;
  /** Square artwork (avatar, post thumbnail) shown in the mini bar. */
  artwork?: string | null;
  /** Where a download of this file is permitted (the listener's own). */
  downloadable?: boolean;
}

export type PlayerStatus = "idle" | "loading" | "playing" | "paused";

interface PersistedState {
  volume: number;
  muted: boolean;
  rate: number;
  expanded: boolean;
  positions: Record<string, number>;
  lastTrack: AudioTrack | null;
}

const STORAGE_KEY = "purewire.audio.v1";

function loadPersisted(): Partial<PersistedState> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return parsed;
  } catch {
    return {};
  }
}

function savePersisted(state: Partial<PersistedState>): void {
  try {
    const merged: PersistedState = {
      volume: typeof state.volume === "number" ? state.volume : 1,
      muted: state.muted ?? false,
      rate: state.rate ?? 1,
      expanded: state.expanded ?? false,
      positions: state.positions ?? {},
      lastTrack: state.lastTrack ?? null,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Private-mode storage can throw — persistence is best-effort.
  }
}

const BARS = 48;

export class PlayerStore {
  private el: HTMLAudioElement;
  private listeners = new Set<() => void>();
  private version = 0;

  private track: AudioTrack | null = null;
  private status: PlayerStatus = "idle";
  private position = 0;
  private duration = 0;
  private volume = 1;
  private muted = false;
  private rate = 1;
  private expanded = false;
  private buffered: Array<[number, number]> = [];
  private hasError = false;

  /** Queue support: multiple tracks played in sequence (multi-audio posts). */
  private queue: AudioTrack[] = [];
  private queueIndex = -1;

  /** Optional callbacks keyed by track id (auto-advance stories). */
  private endedCallbacks = new Map<string, () => void>();

  /** Waveform peaks cache + in-flight marker per track id. */
  private waves = new Map<string, number[] | "loading">();

  private raf = 0;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSeek: number | null = null;
  private lastPositionSave = 0;

  constructor(opts: { persist?: boolean } = {}) {
    const persist = opts.persist !== false;
    this.el = new Audio();
    this.el.preload = "metadata";
    this.wireEvents();
    if (persist) {
      const saved = loadPersisted();
      if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) {
        this.volume = saved.volume;
      }
      if (typeof saved.muted === "boolean") this.muted = saved.muted;
      if (typeof saved.rate === "number" && saved.rate > 0 && saved.rate <= 4) {
        this.rate = saved.rate;
      }
      if (typeof saved.expanded === "boolean") this.expanded = saved.expanded;
      // Restore the last track as PAUSED so the mini bar returns without
      // violating autoplay restrictions; playback starts only on a tap.
      if (saved.lastTrack !== null && typeof saved.lastTrack === "object") {
        this.track = saved.lastTrack;
        this.status = "paused";
        this.el.src = saved.lastTrack.src;
        const pos = saved.positions?.[saved.lastTrack.id];
        if (typeof pos === "number" && pos > 0) this.position = pos;
        this.saveTimer = setInterval(() => this.persist(), 5000);
        this.saveTimer.unref?.();
      }
    }
  }

  // ── Snapshot / subscription (for useSyncExternalStore) ──────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version++;
    this.listeners.forEach((cb) => cb());
  }

  // ── Public state (read via the hook) ────────────────────────────────
  getTrack(): AudioTrack | null {
    return this.track;
  }
  getStatus(): PlayerStatus {
    return this.status;
  }
  getPosition(): number {
    return this.position;
  }
  getDuration(): number {
    return this.duration;
  }
  getVolume(): number {
    return this.volume;
  }
  getMuted(): boolean {
    return this.muted;
  }
  getRate(): number {
    return this.rate;
  }
  getExpanded(): boolean {
    return this.expanded;
  }
  getBuffered(): Array<[number, number]> {
    return this.buffered;
  }
  getHasError(): boolean {
    return this.hasError;
  }
  getQueue(): AudioTrack[] {
    return this.queue;
  }
  isCurrent(trackId: string): boolean {
    return this.track?.id === trackId;
  }

  // ── Actions ─────────────────────────────────────────────────────────
  /**
   * Play a track (user gesture). Same id resumes; a different id switches
   * the source, saves the previous track's position, and — if the listener
   * left off mid-way before — seeks back to that spot once metadata loads.
   */
  play(track: AudioTrack): void {
    if (this.track?.id === track.id) {
      void this.el.play().catch(() => {});
      this.ensureLoop();
      return;
    }
    // Save the previous track's position WITHOUT changing the persisted
    // lastTrack — then mark this switch as a track change so lastTrack
    // follows the newly selected audio.
    this.savePositionNow();
    this.track = track;
    this.queue = [];
    this.queueIndex = -1;
    this.status = "loading";
    this.position = 0;
    this.duration = 0;
    this.buffered = [];
    this.pendingSeek = this.loadPosition(track.id);
    this.el.src = track.src;
    this.el.load();
    void this.el.play().catch(() => {});
    this.ensureLoop();
    this.persist(true);
    this.emit();
  }

  /** Play a track as part of a queue (multi-audio posts). */
  playQueue(tracks: AudioTrack[], index: number): void {
    if (tracks.length === 0) return;
    this.queue = tracks;
    this.queueIndex = Math.max(0, Math.min(index, tracks.length - 1));
    const cur = this.queue[this.queueIndex];
    if (cur !== undefined) this.play(cur);
  }

  playNext(): void {
    if (this.queue.length === 0 || this.queueIndex < 0) return;
    const next = this.queueIndex + 1;
    if (next >= this.queue.length) return;
    this.queueIndex = next;
    const t = this.queue[next];
    if (t !== undefined) this.play(t);
  }

  playPrev(): void {
    if (this.queue.length === 0 || this.queueIndex <= 0) return;
    // Restart the current track if we're already several seconds in.
    if (this.position > 3) {
      this.seek(0);
      return;
    }
    this.queueIndex -= 1;
    const t = this.queue[this.queueIndex];
    if (t !== undefined) this.play(t);
  }

  pause(): void {
    this.el.pause();
    this.savePositionNow();
  }

  toggle(): void {
    if (this.track === null) return;
    if (this.el.paused) {
      void this.el.play().catch(() => {});
      this.ensureLoop();
    } else {
      this.pause();
    }
  }

  seek(seconds: number): void {
    const el = this.el;
    if (!Number.isFinite(el.duration)) return;
    const clamped = Math.max(0, Math.min(seconds, el.duration));
    el.currentTime = clamped;
    this.position = clamped;
    this.emit();
  }

  seekBy(delta: number): void {
    this.seek(this.position + delta);
  }

  setVolume(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.volume = clamped;
    this.el.volume = clamped;
    if (clamped > 0 && this.muted) {
      this.muted = false;
      this.el.muted = false;
    }
    this.emit();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.el.muted = this.muted;
    this.emit();
  }

  setRate(value: number): void {
    this.rate = value;
    this.el.playbackRate = value;
    this.emit();
  }

  setExpanded(value: boolean): void {
    this.expanded = value;
    this.emit();
  }

  /** Stop and clear the track entirely (dismissing the mini bar). */
  close(): void {
    this.savePositionNow();
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.track = null;
    this.status = "idle";
    this.queue = [];
    this.queueIndex = -1;
    this.position = 0;
    this.duration = 0;
    this.pendingSeek = null;
    // A dismissed player must not come back on the next reload.
    const prev = loadPersisted();
    savePersisted({ ...prev, lastTrack: null });
    this.emit();
  }

  /** Register a callback for when this track finishes (stories advance). */
  setOnEnded(trackId: string, cb: (() => void) | undefined): void {
    if (cb === undefined) this.endedCallbacks.delete(trackId);
    else this.endedCallbacks.set(trackId, cb);
  }

  /**
   * Decode a track's waveform (peak-per-bucket envelope). Cached per track
   * id; concurrent callers share one decode. Failures resolve to null so
   * the player falls back to the plain scrubber.
   */
  async getWaveform(track: AudioTrack): Promise<number[] | null> {
    const cached = this.waves.get(track.id);
    if (cached === "loading") {
      // Wait for the in-flight decode by polling the cache.
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = this.waves.get(track.id);
        if (now !== "loading" && now !== undefined) return now;
        if (now === undefined) return null;
      }
      return null;
    }
    if (cached !== undefined) return cached;
    this.waves.set(track.id, "loading");
    try {
      const bytes = await (await fetch(track.src)).arrayBuffer();
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (Ctor === undefined) throw new Error("WebAudio unavailable");
      const ctx = new Ctor();
      const buffer = await ctx.decodeAudioData(bytes);
      const data = buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / BARS));
      const peaks: number[] = [];
      for (let i = 0; i < BARS; i++) {
        let peak = 0;
        const end = Math.min((i + 1) * step, data.length);
        for (let j = i * step; j < end; j++) {
          const v = Math.abs(data[j]);
          if (v > peak) peak = v;
        }
        // Gentle gain so quiet recordings still show a visible envelope.
        peaks.push(Math.min(1, peak * 2.2));
      }
      this.waves.set(track.id, peaks);
      return peaks;
    } catch {
      this.waves.set(track.id, []);
      return null;
    }
  }

  hasWaveform(trackId: string): boolean {
    const w = this.waves.get(trackId);
    return w !== undefined && w !== "loading" && w.length > 0;
  }

  // ── Internals ───────────────────────────────────────────────────────
  private wireEvents(): void {
    const el = this.el;
    el.addEventListener("timeupdate", () => {
      this.position = el.currentTime;
      // The rAF loop drives smooth progress; timeupdate is the fallback
      // when paused (seeks, scrubbing) and the periodic save heartbeat.
      this.maybeSavePosition();
      if (el.paused) this.emit();
    });
    el.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(el.duration)) this.duration = el.duration;
      this.status = "paused";
      if (this.pendingSeek !== null && Number.isFinite(el.duration)) {
        if (this.pendingSeek < el.duration - 5) el.currentTime = this.pendingSeek;
        this.pendingSeek = null;
      }
      this.emit();
    });
    el.addEventListener("loadstart", () => {
      this.hasError = false;
      this.emit();
    });
    el.addEventListener("play", () => {
      this.status = "playing";
      this.hasError = false;
      this.ensureLoop();
      this.emit();
    });
    el.addEventListener("playing", () => {
      this.status = "playing";
      this.emit();
    });
    el.addEventListener("pause", () => {
      this.status = "paused";
      this.savePositionNow();
      this.emit();
    });
    el.addEventListener("waiting", () => {
      this.status = "loading";
      this.emit();
    });
    el.addEventListener("progress", () => {
      const ranges: Array<[number, number]> = [];
      for (let i = 0; i < el.buffered.length; i++) {
        ranges.push([el.buffered.start(i), el.buffered.end(i)]);
      }
      this.buffered = ranges;
      this.emit();
    });
    el.addEventListener("volumechange", () => {
      this.muted = el.muted;
      this.emit();
    });
    el.addEventListener("ratechange", () => {
      this.rate = el.playbackRate;
      this.emit();
    });
    el.addEventListener("error", () => {
      this.status = "idle";
      this.hasError = true;
      this.emit();
    });
    el.addEventListener("ended", () => {
      this.position = 0;
      const cb = this.track !== null ? this.endedCallbacks.get(this.track.id) : undefined;
      if (this.queue.length > 0 && this.queueIndex < this.queue.length - 1) {
        this.playNext();
        return;
      }
      this.status = "paused";
      cb?.();
      this.savePositionNow();
      this.emit();
    });
    // Smooth progress while playing — timeupdate alone fires ~4 Hz.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stopLoop();
      else if (this.status === "playing") this.ensureLoop();
    });
  }

  private ensureLoop(): void {
    if (this.raf !== 0) return;
    let frame = 0;
    const tick = (): void => {
      if (this.status === "playing" && !document.hidden) {
        // Keep the store's position fresh every frame (seeks read it) but
        // emit to subscribers at ~30fps — the waveform and progress stay
        // smooth while a feed full of audio cards doesn't re-render at
        // 60Hz on low-end devices.
        this.position = this.el.currentTime;
        frame++;
        if ((frame & 1) === 0) {
          this.emit();
          this.maybeSavePosition();
        }
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = 0;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private maybeSavePosition(): void {
    const now = Date.now();
    if (now - this.lastPositionSave > 5000) {
      this.lastPositionSave = now;
      this.savePositionNow();
    }
  }

  private savePositionNow(): void {
    if (this.track === null) return;
    this.persist();
  }

  private loadPosition(trackId: string): number | null {
    const pos = this.loadPersistedPositions();
    const p = pos[trackId];
    return typeof p === "number" && p > 0 ? p : null;
  }

  private loadPersistedPositions(): Record<string, number> {
    return loadPersisted().positions ?? {};
  }

  private persist(trackChange = false): void {
    const prev = loadPersisted();
    const positions = prev.positions ?? {};
    // Positions always follow the CURRENT track; lastTrack only follows a
    // deliberate track switch (so a mid-play position save can never
    // re-point the restored track at the previous audio).
    if (this.track !== null) positions[this.track.id] = this.position;
    savePersisted({
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
      expanded: this.expanded,
      positions,
      lastTrack: trackChange && this.track !== null ? this.track : (prev.lastTrack ?? null),
    });
  }
}

/** The app-wide singleton — every store-bound player binds to this. */
export const playerStore = new PlayerStore();
