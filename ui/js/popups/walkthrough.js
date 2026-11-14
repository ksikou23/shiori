import { el } from "../dom.js";
import { invoke, listen, currentWindow } from "../tauri.js";
import { followTheme } from "./theme.js";
import { loadLanguage } from "../i18n.js";
import {
  choiceCount,
  nextChoice,
  raw,
  say,
  secret,
  stepId,
  stepRow,
} from "../components/walkthrough.js";

const box = document.getElementById("guide");
const AHEAD = 7;

let state = null;
let spoilers = false;
let english = true;
const asked = new Set();

function translateIfNeeded() {
  const saved = state?.found && state.walkthrough;
  if (!english || !saved || saved.translated || asked.has(state.key)) {
    return;
  }
  asked.add(state.key);
  invoke("walkthrough_translate", { key: state.key })
    .then(apply)
    .catch(() => {});
}

async function refresh() {
  state = await invoke("walkthrough_current").catch(() => null);
  render();
  translateIfNeeded();
}

async function apply(result) {
  if (result?.found) {
    state = { ...state, ...result };
    render();
  }
}

const mark = (id, done) => invoke("walkthrough_mark", { key: state.key, id, done }).then(apply);

function route(step) {
  const saved = state.walkthrough;
  const count = saved.routes.length;
  invoke("walkthrough_route", { key: state.key, route: (saved.route + step + count) % count }).then(
    apply,
  );
}

function undo() {
  const saved = state.walkthrough;
  const prefix = `${saved.route}-`;
  const last = [...saved.done].reverse().find((id) => id.startsWith(prefix));
  if (last) {
    mark(last, false);
  }
}

function header(title) {
  const bar = el(
    "div",
    { class: "guide-bar" },
    title,
    el(
      "button",
      { class: "guide-close", title: "Hide", onclick: () => invoke("toggle_walkthrough_overlay") },
      "×",
    ),
  );
  bar.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !event.target.closest("button")) {
      currentWindow().startDragging();
    }
  });
  return bar;
}

function render() {
  if (!state?.key) {
    box.replaceChildren(
      header(el("b", {}, "Walkthrough")),
      el("p", { class: "muted" }, "Start a VN to see its walkthrough here."),
    );
    return;
  }
  if (!state.found) {
    box.replaceChildren(
      header(raw("b", {}, state.name || "")),
      el(
        "p",
        { class: "muted" },
        "No walkthrough found for this VN. Pick it on its page in Shiori.",
      ),
    );
    return;
  }

  const saved = state.walkthrough;
  const current = saved.routes[saved.route];
  const next = nextChoice(saved);
  const count = choiceCount(saved);
  const nav = el(
    "div",
    { class: "guide-route" },
    el("button", { onclick: () => route(-1), title: "Previous route" }, "‹"),
    secret("span", { class: "guide-route-name" }, say(saved, current.name, english), false),
    el("button", { onclick: () => route(1), title: "Next route" }, "›"),
    el("span", { class: "muted" }, `${count.done}/${count.total}`),
  );

  let start = next;
  if (start < 0) {
    start = current.steps.length;
  }
  let first = start;
  for (let i = start - 1; i >= 0; i--) {
    first = i;
    if (current.steps[i].kind === "save" || current.steps[i].kind === "heading") {
      break;
    }
    if (current.steps[i].kind === "choice") {
      first = i + 1;
      break;
    }
  }
  const rows = [];
  let choices = 0;
  for (let i = first; i < current.steps.length && choices < AHEAD; i++) {
    rows.push(
      stepRow(saved, saved.route, i, { spoilers, english, onMark: mark, current: i === next }),
    );
    if (current.steps[i].kind === "choice") {
      choices += 1;
    }
  }

  box.replaceChildren(
    header(nav),
    next < 0
      ? el("p", { class: "muted guide-done" }, "Every choice of this route is ticked.")
      : el("div", { class: "guide-steps" }, rows),
    el(
      "div",
      { class: "guide-actions" },
      el(
        "button",
        {
          class: "btn secondary small",
          onclick: undo,
          disabled: !saved.done.some((id) => id.startsWith(`${saved.route}-`)),
        },
        "Undo",
      ),
      next >= 0 &&
        el(
          "button",
          { class: "btn small", onclick: () => mark(stepId(saved.route, next), true) },
          "Done ✓",
        ),
    ),
  );
}

async function start() {
  await loadLanguage(await invoke("ui_language"));
  await followTheme();
  const settings = (await invoke("get_state")).settings;
  spoilers = !!settings.walkthrough_spoilers;
  english = settings.walkthrough_english !== false;
  await listen("settings-changed", (event) => {
    spoilers = !!event.payload?.walkthrough_spoilers;
    english = event.payload?.walkthrough_english !== false;
    translateIfNeeded();
    render();
  });
  await listen("walkthrough-changed", refresh);
  await listen("snapshot", (event) => {
    const key = event.payload?.detected ? event.payload.key : "";
    if (key !== (state?.key || "")) {
      refresh();
    }
  });
  refresh();
}

start();
