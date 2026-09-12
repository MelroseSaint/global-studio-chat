'use strict';

/**
 * Minimal shim for `@metascraper/helpers` used by `is-antibot`.
 *
 * is-antibot imports exactly one function from @metascraper/helpers:
 * `parseUrl`, which is itself just a memoized `tldts.parse`. The full
 * package drags in `url-regex-safe` → `re2` (a native binding that cannot
 * be bundled by Convex), so PureWire replaces it with a two-line shim that
 * calls `tldts` directly — already a transitive dependency of this project,
 * pure JS, and returning the exact same fields is-antibot reads
 * (`.domain` and `.domainWithoutSuffix`).
 *
 * Attribution: the parseUrl surface mirrors microlinkhq's is-antibot
 * (MIT) dependency usage.
 */
const { parse } = require('tldts');

function parseUrl(url) {
  return parse(url);
}

module.exports = { parseUrl };
