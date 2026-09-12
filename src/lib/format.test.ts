import { describe, expect, it } from "vitest";

import {
  extractFirstUrl,
  formatCount,
  formatLikeLabel,
  formatPluralLabel,
  isValidUsername,
  normalizeEmailIdentity,
  platformUrl,
  timeAgo,
} from "./format";

describe("timeAgo", () => {
  it("labels fresh timestamps as just now", () => {
    expect(timeAgo(Date.now() - 10_000)).toBe("just now");
  });
  it("formats minutes, hours, days, weeks", () => {
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe("5m");
    expect(timeAgo(Date.now() - 3 * 60 * 60_000)).toBe("3h");
    expect(timeAgo(Date.now() - 2 * 24 * 60 * 60_000)).toBe("2d");
    expect(timeAgo(Date.now() - 14 * 24 * 60 * 60_000)).toBe("2w");
  });
  it("falls back to a date beyond five weeks", () => {
    expect(timeAgo(Date.now() - 60 * 24 * 60 * 60_000)).not.toMatch(/^[0-9]+[smhdw]$/);
  });
});

describe("formatCount", () => {
  it("passes small counts through", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
  it("compacts thousands and millions", () => {
    expect(formatCount(1_000)).toBe("1K");
    expect(formatCount(1_234)).toBe("1.2K");
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(3_400_000)).toBe("3.4M");
  });
});

describe("formatPluralLabel / formatLikeLabel", () => {
  it("uses singular for exactly one", () => {
    expect(formatPluralLabel(1, "comment")).toBe("1 comment");
    expect(formatLikeLabel(1)).toBe("1 like");
  });
  it("pluralizes everything else, including compacted counts", () => {
    expect(formatLikeLabel(0)).toBe("0 likes");
    expect(formatPluralLabel(2, "comment")).toBe("2 comments");
    expect(formatLikeLabel(1_200)).toBe("1.2K likes");
  });
});

describe("isValidUsername", () => {
  it("accepts 3-24 lowercase alphanumeric + underscore", () => {
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("melroseadmin")).toBe(true);
    expect(isValidUsername("qa_iso_1x2y3z")).toBe(true);
  });
  it("rejects bad handles", () => {
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("Has-Upper")).toBe(false);
    expect(isValidUsername("has space")).toBe(false);
    expect(isValidUsername("a".repeat(25))).toBe(false);
  });
});

describe("normalizeEmailIdentity", () => {
  it("strips +sub-addresses on known providers only", () => {
    expect(normalizeEmailIdentity("user+spam1@gmail.com")).toBe("user@gmail.com");
    // Outlook strips the +tag but keeps dots (they are significant there).
    expect(normalizeEmailIdentity("u.ser+x@outlook.com")).toBe("u.ser@outlook.com");
    expect(normalizeEmailIdentity("user+tag@unknownprovider.example")).toBe(
      "user+tag@unknownprovider.example",
    );
  });
  it("strips dots for Gmail/Googlemail only", () => {
    expect(normalizeEmailIdentity("U.Ser@gmail.com")).toBe("user@gmail.com");
    expect(normalizeEmailIdentity("u.ser@yahoo.com")).toBe("u.ser@yahoo.com");
  });
  it("leaves unparseable input untouched", () => {
    expect(normalizeEmailIdentity("not-an-email")).toBe("not-an-email");
    expect(normalizeEmailIdentity("@gmail.com")).toBe("@gmail.com");
  });
});

describe("extractFirstUrl", () => {
  it("finds the first http(s) URL and trims trailing punctuation", () => {
    expect(extractFirstUrl("see https://purewire.vercel.app/post/abc.")).toBe(
      "https://purewire.vercel.app/post/abc",
    );
    expect(extractFirstUrl("no link here")).toBeNull();
  });
});

describe("platformUrl", () => {
  it("builds profile URLs per platform", () => {
    expect(platformUrl("YouTube", "purewire")).toBe("https://youtube.com/@purewire");
    expect(platformUrl("X", "melrose")).toBe("https://x.com/melrose");
    expect(platformUrl("snapchat", "melrose")).toBe("https://snapchat.com/add/melrose");
  });
  it("passes full URLs through and prefixes bare domains", () => {
    expect(platformUrl("Website", "https://example.com/x")).toBe("https://example.com/x");
    expect(platformUrl("Other", "example.com")).toBe("https://example.com");
  });
});
