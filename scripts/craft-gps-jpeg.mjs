#!/usr/bin/env node
/**
 * Craft a tiny, decodable JPEG that carries EXIF GPS metadata (40.7128,
 * -74.0060) and a "pwgps" sentinel string.
 *
 * The PureWire browser pipeline re-encodes photos through a canvas, which
 * drops EXIF/GPS — so this fixture is used to prove, end to end, that a
 * photo with hidden location data is stored WITHOUT it (see
 * prod-pipeline-verify.mjs --verify-photo). The file must remain a valid
 * JPEG the browser can decode, otherwise the fallback path would upload the
 * original bytes unchanged and the test would (correctly) fail.
 *
 * Usage:  node scripts/craft-gps-jpeg.mjs [out.jpg]
 * Prints the base64 payload when no out path is given.
 */
import { writeFileSync } from "node:fs";

// A canonical 1x1 JPEG (SOI + APP0 + DQT + ... + EOI), no EXIF.
const CLEAN_1x1_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const clean = Buffer.from(CLEAN_1x1_B64, "base64");
// The SOI (FF D8) is the first two bytes; the APP0 segment follows.
const SOI = clean.subarray(0, 2);
const rest = clean.subarray(2);

// EXIF APP1 segment: marker FF E1, then a 16-bit length (segment size
// including the length bytes), then "Exif\0\0" + TIFF-shaped bytes that
// carry the GPS strings. Browsers skip the segment by its length, so the
// JPEG stays decodable no matter what the EXIF content says.
const exifPayload = Buffer.concat([
  Buffer.from("Exif\u0000\u0000", "latin1"),
  Buffer.from("II*\u0000\u0008\u0000\u0000\u0000", "latin1"),
  Buffer.from("GPSLatitudeRef: N 40.7128 pwgps", "latin1"),
  Buffer.from("GPSLongitudeRef: W 74.0060 pwgps", "latin1"),
]);

const app1 = Buffer.alloc(2 + 2 + exifPayload.length);
app1.writeUInt16BE(0xffe1, 0); // APP1 marker
app1.writeUInt16BE(2 + exifPayload.length, 2); // segment length
exifPayload.copy(app1, 4);

const dirty = Buffer.concat([SOI, app1, rest]);

const out = process.argv[2];
if (out) {
  writeFileSync(out, dirty);
  console.log(`Wrote ${dirty.length} bytes to ${out}`);
} else {
  console.log(dirty.toString("base64"));
}
