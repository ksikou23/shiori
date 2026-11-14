import { el } from "../dom.js";
import { invoke } from "../tauri.js";
import { call, openDialog } from "../ui.js";
import { t } from "../i18n.js";

export const stepId = (route, step) => `${route}-${step}`;

export function raw(tag, attrs, text) {
  const node = el(tag, attrs);
  node.textContent = text;
  return node;
}

export function secret(tag, attrs, text, hidden) {
  const node = raw(
    tag,
    { ...attrs, class: `${attrs.class || ""}${hidden ? " spoiler" : ""}` },
    text,
  );
  if (hidden) {
    node.title = t("Click to reveal");
    node.addEventListener(
      "click",
      (event) => {
        if (node.classList.contains("spoiler")) {
          event.stopPropagation();
          event.preventDefault();
          node.classList.remove("spoiler");
          node.removeAttribute("title");
        }
      },
      { capture: true },
    );
  }
  return node;
}

export function say(saved, text, english) {
  return (english && saved.english?.[text]) || text;
}

function shown(saved, text, english) {
  const out = say(saved, text, english);
  return { text: out, title: out !== text ? text : undefined };
}

export function nextChoice(saved) {
  const route = saved.routes[saved.route];
  if (!route) {
    return -1;
  }
  const done = new Set(saved.done);
  return route.steps.findIndex(
    (step, i) => step.kind === "choice" && !done.has(stepId(saved.route, i)),
  );
}

export function choiceCount(saved, route = saved.route) {
  const steps = saved.routes[route]?.steps || [];
  const done = new Set(saved.done);
  const choices = steps.map((step, i) => [step, i]).filter(([step]) => step.kind === "choice");
  return {
    total: choices.length,
    done: choices.filter(([, i]) => done.has(stepId(route, i))).length,
  };
}

export function stepRow(saved, routeIndex, index, { spoilers, english, onMark, current }) {
  const step = saved.routes[routeIndex].steps[index];
  const id = stepId(routeIndex, index);
  const main = shown(saved, step.text, english);
  const hint = shown(saved, step.hint, english);
  if (step.kind === "choice") {
    const box = el("input", { type: "checkbox" });
    box.checked = saved.done.includes(id);
    box.onchange = () => onMark(id, box.checked);
    return el(
      "label",
      { class: `guide-step choice${box.checked ? " done" : ""}${current ? " current" : ""}` },
      box,
      raw("span", { class: "guide-text", title: main.title }, main.text),
      step.hint && raw("span", { class: "guide-hint", title: hint.title }, hint.text),
    );
  }
  if (step.kind === "ending") {
    return el(
      "div",
      { class: "guide-step ending" },
      secret("span", { title: main.title }, main.text, !spoilers),
    );
  }
  return raw("div", { class: `guide-step ${step.kind}`, title: main.title }, main.text);
}

export const SOURCES = [
  { id: "nook", label: "NookGaming", hint: "English" },
  { id: "seiya", label: "Seiya-Saiga", hint: "Japanese" },
];

export const sourceOf = (url) => (url.includes("nookgaming.com") ? "nook" : "seiya");

export async function findWalkthrough(key, name, source = "") {
  const input = el("input", {
    type: "search",
    placeholder: "Title in Japanese or English",
    value: name || "",
  });
  const list = el("div", { class: "guide-results" });
  let timer = null;
  let finish = null;

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      list.replaceChildren();
      return;
    }
    list.replaceChildren(el("div", { class: "muted" }, "Searching…"));
    const found = await invoke("walkthrough_search", { query }).catch(() => []);
    const results = source ? found.filter((entry) => sourceOf(entry.url) === source) : found;
    if (input.value.trim() !== query) {
      return;
    }
    list.replaceChildren(
      ...(results.length
        ? results.map((entry) =>
            el(
              "button",
              {
                class: "guide-result",
                onclick: () => finish?.(entry),
              },
              raw("span", {}, entry.title),
              el(
                "span",
                { class: "muted guide-result-lang" },
                sourceOf(entry.url) === "nook" ? "English" : "Japanese",
              ),
            ),
          )
        : [el("div", { class: "muted" }, "No walkthrough with that name.")]),
    );
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(search, 300);
  };

  const picked = await openDialog({
    title: t("Find the walkthrough"),
    body: el(
      "div",
      { class: "guide-search" },
      el("p", { class: "hint-text" }, "Seiya-Saiga lists the games by their Japanese title."),
      input,
      list,
    ),
    actions: [{ label: "Cancel", kind: "secondary", value: false }],
    onOpen: (done) => {
      finish = done;
      input.focus();
      input.select();
      search();
    },
  });
  if (!picked) {
    return null;
  }
  return call("walkthrough_pick", { key, title: picked.title, url: picked.url });
}
