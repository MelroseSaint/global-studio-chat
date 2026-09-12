/**
 * Lightweight client-side audio metadata reader — extracts a title so the
 * composer can prefill the audio-title field. Purely a convenience: the
 * author's explicitly typed title always wins; file metadata never
 * overrides it (posts.ts stores only what the composer sends).
 *
 * Supported containers: ID3v2 (MP3/AAC/…), FLAC Vorbis comments, and WAV
 * LIST/INFO. Anything unreadable returns null and the composer stays
 * empty.
 */

function latin1(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeText(
  bytes: Uint8Array,
  enc: number,
  offset: number,
  end: number,
): string {
  if (enc === 1 || enc === 2) {
    // UTF-16 with optional BOM.
    let bigEndian = enc === 2;
    let start = offset;
    if (start + 1 < end && bytes[start] === 0xff && bytes[start + 1] === 0xfe) {
      bigEndian = false;
      start += 2;
    } else if (start + 1 < end && bytes[start] === 0xfe && bytes[start + 1] === 0xff) {
      bigEndian = true;
      start += 2;
    }
    let out = "";
    for (let i = start; i + 1 < end; i += 2) {
      const unit = bigEndian
        ? (bytes[i] << 8) | bytes[i + 1]
        : bytes[i] | (bytes[i + 1] << 8);
      if (unit === 0) break;
      out += String.fromCharCode(unit);
    }
    return out;
  }
  if (enc === 3) {
    // UTF-8 best-effort (decode with TextDecoder if available).
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(
        bytes.subarray(offset, end),
      );
    } catch {
      // fall through to latin1
    }
  }
  return latin1(bytes, offset, end - offset);
}

function syncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function id3Title(bytes: Uint8Array): string | null {
  if (bytes.length < 10 || latin1(bytes, 0, 3) !== "ID3") return null;
  // Skip the extended header if present (flag bit 0x40).
  const flags = bytes[5] ?? 0;
  const tagSize = syncSafe(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;
  if ((flags & 0x40) !== 0 && offset + 4 <= tagEnd) {
    const extSize = syncSafe(bytes, offset);
    offset += 4 + extSize;
  }
  for (let frame = 0; frame < 64 && offset + 10 <= tagEnd; frame++) {
    const id = latin1(bytes, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = syncSafe(bytes, offset + 4);
    const dataStart = offset + 10;
    const dataEnd = dataStart + size;
    if (dataEnd > tagEnd) break;
    if (id === "TIT2" && dataStart < dataEnd) {
      const enc = bytes[dataStart] ?? 0;
      const text = decodeText(bytes, enc, dataStart + 1, dataEnd);
      if (text.trim().length > 0) return text.trim();
    }
    offset = dataEnd;
  }
  return null;
}

function flacTitle(bytes: Uint8Array): string | null {
  // FLAC: "fLaC" then metadata blocks; look for a Vorbis comment block
  // (type 4) and the TITLE= entry.
  if (bytes.length < 4 || latin1(bytes, 0, 4) !== "fLaC") return null;
  let offset = 4;
  for (let block = 0; block < 64 && offset + 4 <= bytes.length; block++) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size =
      (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    if (offset + size > bytes.length) break;
    if (type === 4 && size >= 8) {
      // Vorbis comment: vendor string, then a count of comments.
      let p = offset;
      const vendorLen = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      p += 4 + vendorLen;
      if (p + 4 > offset + size) break;
      const count = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      p += 4;
      const end = offset + size;
      for (let i = 0; i < count && p + 4 <= end; i++) {
        const len = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
        p += 4;
        if (p + len > end) break;
        const raw = latin1(bytes, p, len);
        const eq = raw.indexOf("=");
        if (eq > 0 && raw.slice(0, eq).toUpperCase() === "TITLE") {
          const value = raw.slice(eq + 1).trim();
          if (value.length > 0) return value;
        }
        p += len;
      }
    }
    if (isLast) break;
    offset += size;
  }
  return null;
}

function wavTitle(bytes: Uint8Array): string | null {
  // RIFF/WAVE LIST-INFO: look for an INAM chunk (title).
  if (bytes.length < 12 || latin1(bytes, 0, 4) !== "RIFF" || latin1(bytes, 8, 4) !== "WAVE") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = latin1(bytes, offset, 4);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    const dataStart = offset + 8;
    const dataEnd = Math.min(bytes.length, dataStart + size);
    if (id === "LIST" && dataStart + 4 <= dataEnd && latin1(bytes, dataStart, 4) === "INFO") {
      let p = dataStart + 4;
      while (p + 8 <= dataEnd) {
        const sub = latin1(bytes, p, 4);
        const subSize = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
        const textStart = p + 8;
        const textEnd = Math.min(dataEnd, textStart + subSize);
        if (sub === "INAM") {
          let raw = "";
          for (let i = textStart; i < textEnd; i++) {
            if (bytes[i] === 0) break;
            raw += String.fromCharCode(bytes[i]);
          }
          if (raw.trim().length > 0) return raw.trim();
        }
        p = textStart + subSize + (subSize % 2);
      }
    }
    if (size <= 0) break;
    offset = dataStart + size + (size % 2);
  }
  return null;
}

/** Read the title from common audio containers, or null when absent. */
export function readAudioTitle(bytes: ArrayBuffer): string | null {
  const u = new Uint8Array(bytes);
  return id3Title(u) ?? flacTitle(u) ?? wavTitle(u);
}
