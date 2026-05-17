import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { detectLocaleAndTz } from "../../src/session/analytics.js";

describe("detectLocaleAndTz", () => {
  it("CONTEXT_MODE_LOCALE env wins over everything", () => {
    const orig = process.env.CONTEXT_MODE_LOCALE;
    process.env.CONTEXT_MODE_LOCALE = "tr-TR";
    try {
      const { locale } = detectLocaleAndTz();
      expect(locale).toBe("tr-TR");
    } finally {
      if (orig === undefined) delete process.env.CONTEXT_MODE_LOCALE;
      else process.env.CONTEXT_MODE_LOCALE = orig;
    }
  });

  // Regression: `require("node:child_process")` inline threw "Dynamic require
  // not supported" under esbuild's ESM shim, silently falling through to the
  // LANG fallback. This test reads the macOS AppleLocale itself and asserts
  // detectLocaleAndTz returns the SAME value — proving the AppleLocale branch
  // actually executed (and didn't get swallowed by the catch).
  it("on macOS, AppleLocale beats LANG (regression: require() in ESM was throwing)", () => {
    if (process.platform !== "darwin") return;

    let appleLocale: string;
    try {
      appleLocale = execFileSync("defaults", ["read", "-g", "AppleLocale"], {
        encoding: "utf8", timeout: 500,
      }).trim().replace(/_/g, "-");
    } catch {
      return; // sandbox without `defaults` — nothing to assert against
    }
    if (!appleLocale) return;

    const orig = { lang: process.env.LANG, override: process.env.CONTEXT_MODE_LOCALE };
    delete process.env.CONTEXT_MODE_LOCALE;
    process.env.LANG = "xx_XX.UTF-8"; // a value that would lose if AppleLocale wins
    try {
      const { locale } = detectLocaleAndTz();
      expect(locale).toBe(appleLocale);
    } finally {
      if (orig.lang === undefined) delete process.env.LANG;
      else process.env.LANG = orig.lang;
      if (orig.override !== undefined) process.env.CONTEXT_MODE_LOCALE = orig.override;
    }
  });

  it("LANG=C.UTF-8 / POSIX falls back to a usable BCP 47 locale", () => {
    const orig = {
      lang: process.env.LANG,
      lcTime: process.env.LC_TIME,
      override: process.env.CONTEXT_MODE_LOCALE,
    };
    delete process.env.CONTEXT_MODE_LOCALE;
    delete process.env.LC_TIME;
    try {
      for (const langValue of ["C.UTF-8", "POSIX", "C"]) {
        process.env.LANG = langValue;
        const { locale } = detectLocaleAndTz();
        expect(() => new Intl.DateTimeFormat(locale, { timeZone: "UTC" }))
          .not.toThrow();
        expect(locale).not.toBe("C");
        expect(locale).not.toBe("POSIX");
      }
    } finally {
      if (orig.lang === undefined) delete process.env.LANG;
      else process.env.LANG = orig.lang;
      if (orig.lcTime === undefined) delete process.env.LC_TIME;
      else process.env.LC_TIME = orig.lcTime;
      if (orig.override !== undefined) process.env.CONTEXT_MODE_LOCALE = orig.override;
    }
  });

  it("CONTEXT_MODE_LOCALE that is not a valid BCP 47 tag is ignored", () => {
    const orig = process.env.CONTEXT_MODE_LOCALE;
    process.env.CONTEXT_MODE_LOCALE = "C";
    try {
      const { locale } = detectLocaleAndTz();
      expect(locale).not.toBe("C");
      expect(() => new Intl.DateTimeFormat(locale, { timeZone: "UTC" }))
        .not.toThrow();
    } finally {
      if (orig === undefined) delete process.env.CONTEXT_MODE_LOCALE;
      else process.env.CONTEXT_MODE_LOCALE = orig;
    }
  });
});
