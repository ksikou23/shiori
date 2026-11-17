import { invoke } from "./tauri.js";

const ATTRIBUTES = ["title", "placeholder", "aria-label"];

let dictionary = null;
export let language = "en";

export async function loadLanguage(code) {
  language = "en";
  dictionary = null;
  if (code && code !== "en") {
    try {
      dictionary = await invoke("language_strings", { code });
      language = code;
    } catch {
      dictionary = null;
    }
  }
  document.documentElement.lang = language;
}

const squash = (text) => text.replace(/\s+/g, " ").trim();

export function t(text, vars) {
  let out = text;
  if (dictionary && typeof text === "string") {
    out = dictionary[text] ?? dictionary[squash(text)] ?? text;
  }
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
  }
  return out;
}

export function translateError(text) {
  if (typeof text !== "string") return text;
  const patterns = [
    [/^couldn't read the VN's original language: ([\s\S]+)$/, "couldn't read the VN's original language: {error}", "error"],
    [/^couldn't read VNDB releases: ([\s\S]+)$/, "couldn't read VNDB releases: {error}", "error"],
    [/^VNDB returned an invalid release date for (.+)\.$/, "VNDB returned an invalid release date for {id}.", "id"],
    [/^Couldn't find release (.+) on VNDB\.$/, "Couldn't find release {id} on VNDB.", "id"],
  ];
  for (const [pattern, key, variable] of patterns) {
    const match = text.match(pattern);
    if (match) return t(key, { [variable]: match[1] });
  }
  return t(text);
}

function translateText(value) {
  const key = squash(value);
  const hit = key && dictionary[key];
  if (!hit) {
    return value;
  }
  const lead = value.match(/^\s*/)[0];
  const tail = value.match(/\s*$/)[0];
  return lead + hit + tail;
}

export function translateTree(root) {
  if (!dictionary) {
    return root;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.nodeValue = translateText(node.nodeValue);
  }
  for (const node of root.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const name of ATTRIBUTES) {
      if (node.hasAttribute(name)) {
        node.setAttribute(name, translateText(node.getAttribute(name)));
      }
    }
  }
  return root;
}

export function plural(count, word) {
  const form = count === 1 ? word : `${word}s`;
  return `${count} ${t(form)}`;
}
