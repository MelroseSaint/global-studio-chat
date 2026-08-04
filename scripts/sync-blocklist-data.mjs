#!/usr/bin/env node
/**
 * PureWire blocklist data sync.
 *
 * Generates the categorized domain-list feeds in data/adult/ from the
 * curated static list in src/convex/phishing.ts (BANNED_ADULT_HOSTS), so
 * the shipped data files can never drift from the code that enforces
 * them. Each file is one domain per line with a `# category:` header —
 * the exact format the blocklist engine's "domain" source parser reads,
 * so every file can be registered as a domainSources feed (hosted at
 * raw.githubusercontent.com/.../data/adult/<file> or any static URL) and
 * synced into blockedDomains with its real category.
 *
 * Run with: npm run data:sync
 * Idempotent: re-running rewrites the files to match the code exactly.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHISHING = join(ROOT, "src", "convex", "phishing.ts");
const DATA_DIR = join(ROOT, "data", "adult");
// The feeds are ALSO copied into Vite's public/ directory so the deployed
// site serves them at /data/adult/<file>. That is the source-URL the admin
// registers in the blocklist engine — self-hosted, no third-party host
// (raw.githubusercontent cannot serve a private repo, so the app must).
const PUBLIC_DIR = join(ROOT, "public", "data", "adult");

/** File name → (static category key, DB category). Kept in step with the
 * 12-category taxonomy in phishing.ts and the engine's blockedDomains. */
const FILES = [
  { file: "creator-domains.txt", staticKey: "adult_subscription", category: "adult_creator" },
  { file: "porn-domains.txt", staticKey: "adult_tube", category: "adult_porn" },
  { file: "cam-domains.txt", staticKey: "adult_cams", category: "adult_cam" },
  { file: "clip-domains.txt", staticKey: "adult_clips", category: "adult_clips" },
  { file: "chat-domains.txt", staticKey: "adult_chat", category: "adult_chat" },
  { file: "escort-domains.txt", staticKey: "adult_escorts", category: "adult_escort" },
  // fetish has no curated entries yet — the static list has no fetish
  // bucket, so this file is intentionally created empty (the made-up key
  // resolves to [] via `?? []`). Kept so the taxonomy is complete and a
  // future fetish list has a home.
  { file: "fetish-domains.txt", staticKey: "adult_fetish_reserved", category: "adult_fetish" },
  { file: "community-domains.txt", staticKey: "adult_social", category: "adult_community" },
  { file: "redirects-domains.txt", staticKey: "adult_link_redirect", category: "adult_redirect" },
];

/** Extract the { category: [ "a", "b", ... ] } block from phishing.ts. */
function parseStaticList(source) {
  const block = source.match(
    /export const BANNED_ADULT_HOSTS: Record<[^>]+> = \{([\s\S]*?)\n\};/,
  );
  if (block === null) {
    throw new Error("Could not locate BANNED_ADULT_HOSTS in phishing.ts");
  }
  const body = block[1];
  const out = {};
  // category: [ "a", "b", ... ]  (comments allowed between entries)
  const categoryRe =
    /([a-z_]+):\s*\[\s*((?:"[^"]*"\s*,?\s*|(?:\/\*[^*]*\*\/|\/\/[^\n]*)\s*)*)\]/g;
  for (const m of body.matchAll(categoryRe)) {
    const key = m[1];
    const domains = [...m[2].matchAll(/"([^"]+)"/g)].map((d) => d[1]);
    out[key] = domains;
  }
  return out;
}

/** Validate a domain line: lowercased, no scheme/path/port, has a dot. */
function validDomain(d) {
  return (
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) &&
    !/^(\d{1,3}\.){3}\d{1,3}$/.test(d)
  );
}

function main() {
  const source = readFileSync(PHISHING, "utf8");
  const staticList = parseStaticList(source);

  mkdirSync(DATA_DIR, { recursive: true });
  let total = 0;
  const seen = new Set();

  for (const { file, staticKey, category } of FILES) {
    const domains = (staticList[staticKey] ?? []).filter((d) => {
      if (!validDomain(d)) {
        console.error(`  ! invalid domain in ${staticKey}: ${d}`);
        return false;
      }
      if (seen.has(d)) {
        console.error(`  ! duplicate domain across files: ${d}`);
        return false;
      }
      seen.add(d);
      return true;
    });
    const header = [
      `# PureWire blocklist feed — ${category}`,
      "# One domain per line, lowercased, no scheme. Lines starting with # are ignored.",
      `# Category: ${category}`,
      "",
    ].join("\n");
    const body = domains.length > 0 ? domains.join("\n") + "\n" : "";
    writeFileSync(join(DATA_DIR, file), header + body);
    total += domains.length;
    console.log(`  wrote ${file} (${domains.length} domains)`);
  }

  // Guard: every file must self-declare the category its name implies, so
  // the engine's parser can route a synced feed into the right bucket.
  for (const { file, category } of FILES) {
    const text = readFileSync(join(DATA_DIR, file), "utf8");
    if (!text.includes(`# Category: ${category}`)) {
      throw new Error(`${file} is missing its # Category: ${category} header`);
    }
  }

  // Mirror into public/ so the deployed site serves the feeds.
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const { file } of FILES) {
    writeFileSync(
      join(PUBLIC_DIR, file),
      readFileSync(join(DATA_DIR, file), "utf8"),
    );
  }
  writeFileSync(
    join(PUBLIC_DIR, "README.md"),
    readFileSync(join(DATA_DIR, "README.md"), "utf8"),
  );

  console.log(
    `\nBlocklist data sync complete — ${total} domains across ${FILES.length} files ` +
      `(mirrored to public/data/adult for serving).`,
  );
}

main();
