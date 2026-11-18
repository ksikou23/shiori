import { test } from "node:test";
import { equal } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { defaultReleaseMedium, matchesRelease } from "../js/release-filters.js";

const source = await readFile(new URL("../js/pages/cover.js", import.meta.url), "utf8");

function element(tag, attributes = {}, ...children) {
  return {
    tag,
    ...attributes,
    children: children.filter(Boolean),
    replaceChildren(...items) { this.children = items.filter(Boolean); },
    querySelector(selector) { return findElement(this, (node) => node.tag === selector); },
  };
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

function findButton(node, label) {
  return findElement(node, (item) => item.tag === "button" && item.children.includes(label));
}

async function setup(coverSource, choice = "keep", options = {}) {
  const calls = [];
  let body;
  let confirmationCount = 0;
  const releases = options.releases || ["r1", "r2"].map((id) => ({
    id, title: id, released: "2020-01-01", official: true, patch: false,
    vns: [{ id: "v1", rtype: "complete" }], languages: [{ lang: "ja" }],
    platforms: ["win"], media: [{ medium: "dvd" }], images: [],
  }));
  const modules = {
    "../dom.js": { $() {}, el: element, html() {} },
    "../router.js": { currentPage() {}, register() {}, show() {} },
    "../store.js": { store: { settings: options.settings || {} } },
    "../ui.js": {
      ask: async () => true,
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "vndb_releases") return { original_language: "ja", releases };
        if (name === "get_game") return { entry: { vndb_id: "v1", vndb_release_id: "r1", cover_source: coverSource } };
      },
      openDialog: (options) => {
        if (options.title === "Change cover?") {
          confirmationCount++;
          return Promise.resolve(choice);
        }
        body = options.body;
        return new Promise((resolve) => options.onOpen(resolve));
      },
      setCover() {}, toast() {},
      toggle: (label, checked, onChange) => {
        const input = element("input", { checked });
        input.onchange = () => onChange(input.checked);
        return element("label", {}, input, label);
      },
    },
    "../i18n.js": { language: "en", plural: () => "", t: (text, vars) =>
      text.replace(/\{(\w+)\}/g, (match, name) => vars?.[name] ?? match) },
    "../release-filters.js": { defaultReleaseMedium, matchesRelease },
  };
  const context = vm.createContext({ Intl, console, document: { createTextNode: (text) => text } });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = modules[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const pending = module.namespace.chooseReleaseForGame("game", { id: "v1", title: "VN", nsfw: false });
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, body, pending, confirmations: () => confirmationCount };
}

test("switching an automatic release cover does not ask to keep it", async () => {
  const ui = await setup("vndb_release");
  await findButton(ui.body, "Use").onclick();
  await ui.pending;
  equal(ui.confirmations(), 0);
  equal(ui.calls.find((call) => call.name === "set_game_release").args.keepCover, false);
});

test("clearing an automatic release and choosing another does not ask to keep the VN cover", async () => {
  const ui = await setup("vndb_release");
  await findButton(ui.body, "Clear release").onclick();
  await findButton(ui.body, "Use").onclick();
  await ui.pending;
  equal(ui.confirmations(), 0);
  equal(ui.calls.find((call) => call.name === "set_game_release").args.keepCover, false);
});

test("a manual cover prompts and can be preserved", async () => {
  const ui = await setup("url");
  await findButton(ui.body, "Use").onclick();
  await ui.pending;
  equal(ui.confirmations(), 1);
  equal(ui.calls.find((call) => call.name === "set_game_release").args.keepCover, true);
});

test("a manual cover can be replaced by the selected release cover", async () => {
  const ui = await setup("url", "auto");
  await findButton(ui.body, "Use").onclick();
  await ui.pending;
  equal(ui.confirmations(), 1);
  equal(ui.calls.find((call) => call.name === "set_game_release").args.keepCover, false);
});

test("view all clears every filter and keeps the controls in sync", async () => {
  const release = (id, changes) => ({
    id, title: id, released: "2020-01-01", official: true, patch: false,
    vns: [{ id: "v1", rtype: "complete" }], languages: [{ lang: "ja" }],
    platforms: ["win"], media: [{ medium: "dvd" }], images: [],
    ...changes,
  });
  const ui = await setup("vndb_release", "keep", {
    settings: { vndb_release_medium: "package" },
    releases: [
      release("r1", {}),
      release("r2", {
        official: false, vns: [{ id: "v1", rtype: "trial" }],
        languages: [{ lang: "en" }], platforms: ["swi"], media: [{ medium: "in" }],
      }),
    ],
  });
  const count = findElement(ui.body, (node) => node.tag === "span" && node.class === "muted small-text");
  const product = findElement(ui.body, (node) => node.tag === "input");
  const select = (label) => findElement(ui.body, (node) => node["aria-label"] === label);
  equal(count.textContent, "1 of 2 releases");
  equal(product.checked, true);

  findButton(ui.body, "View all").onclick();
  equal(count.textContent, "2 of 2 releases");
  equal(product.checked, false);
  for (const label of ["Language", "Platform", "Release medium"]) equal(select(label).value, "");

  select("Platform").value = "win";
  select("Platform").onchange();
  equal(count.textContent, "1 of 2 releases");
  findButton(ui.body, "View all").onclick();
  equal(count.textContent, "2 of 2 releases");
});
