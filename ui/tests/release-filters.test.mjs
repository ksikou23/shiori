import { test } from "node:test";
import { deepStrictEqual, equal } from "node:assert/strict";
import { defaultReleaseMedium, matchesRelease, releaseMediaKinds } from "../js/release-filters.js";

const release = (changes = {}) => ({
  official: true,
  patch: false,
  vns: [{ id: "v1", rtype: "partial" }],
  languages: [{ lang: "ja" }],
  platforms: ["win"],
  media: [{ medium: "dvd" }],
  ...changes,
});
const defaults = { productOnly: true, language: "ja", platform: "win", medium: "" };

test("release medium defaults preserve all existing releases unless configured", () => {
  for (const [value, expected] of [[undefined, ""], ["", ""], ["package", "package"], ["download", "download"]]) {
    equal(defaultReleaseMedium(value), expected);
    equal(matchesRelease(release(), "v1", { ...defaults, medium: defaultReleaseMedium(value) }), expected !== "download");
  }
});

test("product filter is optional and checks the selected VN", () => {
  equal(matchesRelease(release(), "v1", defaults), true);
  const trial = release({ vns: [{ id: "v1", rtype: "trial" }, { id: "v2", rtype: "complete" }] });
  equal(matchesRelease(trial, "v1", defaults), false);
  equal(matchesRelease(trial, "v1", { ...defaults, productOnly: false }), true);
  for (const item of [release({ patch: true }), release({ official: false })]) {
    equal(matchesRelease(item, "v1", defaults), false);
    equal(matchesRelease(item, "v1", { ...defaults, productOnly: false }), true);
  }
});

test("multiple-VN releases remain visible when they match the other filters", () => {
  const bundle = release({ vns: [{ id: "v1", rtype: "partial" }, { id: "v2", rtype: "complete" }] });
  equal(matchesRelease(bundle, "v1", defaults), true);
});

test("language filter accepts multilingual releases and can be cleared", () => {
  const english = release({ languages: [{ lang: "en" }] });
  const both = release({ languages: [{ lang: "ja" }, { lang: "en" }] });
  equal(matchesRelease(english, "v1", defaults), false);
  equal(matchesRelease(english, "v1", { ...defaults, language: "en" }), true);
  equal(matchesRelease(english, "v1", { ...defaults, language: "" }), true);
  equal(matchesRelease(both, "v1", defaults), true);
  equal(matchesRelease(both, "v1", { ...defaults, language: "en" }), true);
  equal(matchesRelease(release({ languages: [] }), "v1", defaults), false);
});

test("medium filter distinguishes physical, digital, cards and unknown media", () => {
  const kinds = (media) => [...releaseMediaKinds(release({ media }))].sort();
  deepStrictEqual(kinds([{ medium: "dvd" }]), ["package"]);
  deepStrictEqual(kinds([{ medium: "in" }]), ["download"]);
  deepStrictEqual(kinds([{ medium: "dc" }]), ["download", "package"]);
  deepStrictEqual(kinds([{ medium: "dvd" }, { medium: "in" }]), ["download", "package"]);
  deepStrictEqual(kinds([]), ["other"]);
  deepStrictEqual(kinds([{ medium: "otc" }]), ["other"]);
  deepStrictEqual(kinds([{ medium: "new-type" }]), ["other"]);
  equal(matchesRelease(release({ media: [{ medium: "in" }] }), "v1", { ...defaults, medium: "package" }), false);
  equal(matchesRelease(release({ media: [{ medium: "in" }] }), "v1", { ...defaults, medium: "download" }), true);
  equal(matchesRelease(release({ media: [] }), "v1", { ...defaults, medium: "other" }), true);
  equal(matchesRelease(release({ media: [] }), "v1", defaults), true);
});

test("platform filter defaults to Windows and can show other or unspecified platforms", () => {
  const multi = release({ platforms: ["win", "swi"] });
  const console = release({ platforms: ["swi"] });
  const unknown = release({ platforms: [] });
  equal(matchesRelease(multi, "v1", defaults), true);
  equal(matchesRelease(console, "v1", defaults), false);
  equal(matchesRelease(unknown, "v1", defaults), false);
  equal(matchesRelease(multi, "v1", { ...defaults, platform: "swi" }), true);
  equal(matchesRelease(console, "v1", { ...defaults, platform: "swi" }), true);
  equal(matchesRelease(console, "v1", { ...defaults, platform: "" }), true);
  equal(matchesRelease(unknown, "v1", { ...defaults, platform: "" }), true);
  equal(matchesRelease(unknown, "v1", { ...defaults, platform: "__unknown" }), true);
  equal(matchesRelease(multi, "v1", { ...defaults, platform: "__unknown" }), false);
});
