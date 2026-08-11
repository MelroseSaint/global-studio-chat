import { useSyncExternalStore } from "react";

import { playerStore, type PlayerStore } from "@/lib/audio-player";
import type { AudioTrack, PlayerStatus } from "@/lib/audio-player";

export interface AudioSnapshot {
  track: AudioTrack | null;
  status: PlayerStatus;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  expanded: boolean;
  buffered: Array<[number, number]>;
  queue: AudioTrack[];
  hasError: boolean;
}

/**
 * Subscribe a component to a PureWire audio playback store — by default
 * the global one, so every AudioPlayer for the same track id reflects the
 * same playing state, position, and queue: one source plays at a time
 * platform-wide. Pass a private store for standalone (upload preview)
 * players.
 *
 * The store's snapshot is its monotonic version number (a stable
 * primitive), so React re-renders exactly when playback state changes;
 * the component reads the current values off the store during render.
 */
export function useAudioPlayer(store: PlayerStore = playerStore): AudioSnapshot {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    track: store.getTrack(),
    status: store.getStatus(),
    position: store.getPosition(),
    duration: store.getDuration(),
    volume: store.getVolume(),
    muted: store.getMuted(),
    rate: store.getRate(),
    expanded: store.getExpanded(),
    buffered: store.getBuffered(),
    queue: store.getQueue(),
    hasError: store.getHasError(),
  };
}
