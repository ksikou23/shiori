import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const codes = ["en", "ja", "fr", "es", "pt", "ru", "vi", "zh-CN", "zh-HK", "zh-TW"];
const locales = Object.fromEntries(await Promise.all(codes.map(async (code) => [
  code,
  JSON.parse(await readFile(new URL(`../locales/${code}.json`, import.meta.url), "utf8")).ui,
])));
const i18nSource = await readFile(new URL("../js/i18n.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");

async function setup() {
  const box = { textContent: "", classList: { toggle() {}, add() {}, remove() {} } };
  const context = vm.createContext({
    document: { documentElement: {} },
    setTimeout() {},
    clearTimeout() {},
  });
  const i18n = new vm.SourceTextModule(i18nSource, { context });
  const ui = new vm.SourceTextModule(uiSource, { context });
  const mocks = {
    "./tauri.js": {
      invoke: async (command, args) => {
        if (command === "language_strings") return locales[args.code];
        throw args.error;
      },
      fileUrl() {},
    },
    "./dom.js": { $: () => box, el() {} },
    "./store.js": { store: {} },
  };
  const modules = Object.fromEntries(Object.entries(mocks).map(([name, values]) => [
    name,
    new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context }),
  ]));
  await ui.link((specifier) => specifier === "./i18n.js" ? i18n : modules[specifier]);
  await ui.evaluate();
  return { box, loadLanguage: i18n.namespace.loadLanguage, call: ui.namespace.call };
}

test("release errors are translated in every language without losing details", async () => {
  const { box, loadLanguage, call } = await setup();
  const cases = [
    ["The selected release does not belong to this VN.", "The selected release does not belong to this VN."],
    ["couldn't read the VN's original language: detail\nmore", "couldn't read the VN's original language: {error}", "detail\nmore"],
    ["couldn't read VNDB releases: detail {id}", "couldn't read VNDB releases: {error}", "detail {id}"],
    ["VNDB returned an invalid release date for r123.", "VNDB returned an invalid release date for {id}.", "r123"],
    ["Couldn't find release r123 on VNDB.", "Couldn't find release {id} on VNDB.", "r123"],
    ["Unrecognized error: detail", "Unrecognized error: detail"],
  ];
  for (const code of codes) {
    await loadLanguage(code);
    for (const [message, key, value] of cases) {
      await rejects(call("test", { error: message }), (error) => error === message);
      if (key !== "Unrecognized error: detail") ok(Object.hasOwn(locales[code], key), `${code}: missing ${key}`);
      const template = locales[code][key] ?? key;
      equal(box.textContent, template.replace(/\{(?:error|id)\}/, () => value), `${code}: ${message}`);
    }
  }
});
