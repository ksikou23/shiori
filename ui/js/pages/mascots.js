import { $, el, html, svg } from "../dom.js";
import { fileUrl, pickFile, pickSaveFile } from "../tauri.js";
import { register } from "../router.js";
import { store, subscribe } from "../store.js";
import { call, confirmButton, openDialog, toast, toggle } from "../ui.js";
import { t } from "../i18n.js";
import { hotkeyInput } from "../components/hotkey-input.js";
import { discordButton } from "../components/discord-button.js";
import {
  applyBalloon,
  BALLOON_DEFAULT,
  BALLOON_PRESETS,
  balloonStyle,
  playBalloon,
} from "../balloon-style.js";

const TEMPLATE = `
  <div class="page-head">
    <h2>Mascots</h2>
    <div class="row">
      <span data-id="enabled"></span>
      <button class="btn" data-id="add">Add a mascot…</button>
    </div>
  </div>
  <p class="muted">
    Click a mascot to put it on your desktop, click it again to take it off. Pick several to have
    them all at once. On the desktop, drag them anywhere, click to chat, double-click to open the
    app, right-click for more. A PNG with a transparent background looks best.
  </p>
  <div class="mascot-grid" data-id="grid"></div>

  <div class="card community mascot-community">
    <div>
      <b>Share your mascots</b>
      <div class="muted small-text">
        Press “Share…” on a mascot to save it as a file, then post it on the Discord. You'll find
        other people's mascots there too.
      </div>
    </div>
    <span data-id="discord-slot"></span>
  </div>

  <div class="card mascot-options">
    <div class="card-title"><b>Options</b></div>
    <div data-id="options"></div>
  </div>
`;

const CUSTOM = "custom";

const LINE_FIELDS = [
  ["start", "When you start a VN", "{name} becomes the VN's title."],
  ["stop", "When you stop reading"],
  ["idle", "When you go idle"],
  ["back", "When you come back"],
  ["section", "New chapter or route", "{section} becomes its name."],
  ["screenshot", "After a screenshot"],
];

const LIST_FIELDS = [
  ["pokes", "When you click it"],
  ["chatter", "Now and then"],
  ["reading", "About the VN you're reading", "{name}: the VN · {total}: time on it · {session}: this session."],
];

const VOICE_MOMENTS = [
  ...LINE_FIELDS.map(([key, label]) => [key, label]),
  ["poke", "When you click it"],
  ["chatter", "Now and then"],
];

const CHATTER_MINUTES = [0, 1, 3, 5, 10, 15, 30];

const PACK_EXTENSION = "shiorimascot";
const MASCOT_FILTERS = [
  { name: "Images or shared mascots", extensions: ["png", "webp", "gif", PACK_EXTENSION] },
];
const MASCOT_IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "webp", "gif"] }];
const PACK_FILTERS = [{ name: "Shared mascot", extensions: [PACK_EXTENSION] }];
const AUDIO_FILTERS = [
  { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "opus", "flac"] },
];

let root;

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));
  part("add").onclick = addMascot;
  part("discord-slot").append(discordButton({ label: "Share on Discord" }));
  subscribe("settings", () => root.classList.contains("active") && load());
}

const save = (changes) => call("update_settings", { changes });

function hideApps() {
  const chips = el("div", { class: "chips" });
  const picker = el("select", {});
  const current = () => store.settings.mascot_hide_apps || [];
  const keep = (apps) => {
    store.settings.mascot_hide_apps = apps;
    save({ mascot_hide_apps: apps });
    render();
  };

  const render = () => {
    chips.replaceChildren(
      ...current().map((exe) =>
        el(
          "span",
          { class: "chip" },
          exe,
          el("button", { title: "Remove", onclick: () => keep(current().filter((e) => e !== exe)) }, "✕"),
        ),
      ),
    );
  };

  const fill = async () => {
    const windows = await call("list_windows");
    const taken = new Set(current());
    const seen = new Set();
    const items = [el("option", { value: "" }, t("Add an open app…"))];
    for (const win of windows) {
      const exe = win.exe_path.split("\\").pop().toLowerCase();
      if (!exe || seen.has(exe) || taken.has(exe)) {
        continue;
      }
      seen.add(exe);
      items.push(el("option", { value: exe }, `${win.title}  —  ${exe}`));
    }
    picker.replaceChildren(...items);
  };
  picker.onmousedown = fill;
  picker.onfocus = fill;
  picker.onchange = () => {
    if (picker.value) {
      keep([...current(), picker.value]);
      picker.value = "";
      fill();
    }
  };

  render();
  fill();
  return [
    el("div", { class: "field" }, el("span", {}, "Hide them over these apps"), picker),
    chips,
    el(
      "div",
      { class: "hint-text" },
      "When one of these is the window in front, the mascots turn invisible and come back when you switch.",
    ),
  ];
}

function options() {
  const settings = store.settings;
  const backToCorner = el("button", { class: "btn secondary" }, "Put them back in the corner");
  backToCorner.onclick = () => save({ mascot_positions: {}, mascot_pos: null });

  const chatter = el(
    "select",
    {},
    ...CHATTER_MINUTES.map((minutes) =>
      el(
        "option",
        { value: minutes, selected: minutes === (settings.mascot_chatter_minutes || 0) },
        minutes ? t("Every {n} min", { n: minutes }) : t("Never"),
      ),
    ),
  );
  chatter.onchange = () => save({ mascot_chatter_minutes: Number(chatter.value) });

  const volume = el("input", {
    type: "range",
    min: 0,
    max: 100,
    step: 5,
    value: settings.mascot_voice_volume ?? 80,
  });
  const volumeLabel = el("span", { class: "muted", style: { width: "44px", textAlign: "right" } });
  const showVolume = () =>
    (volumeLabel.textContent = Number(volume.value) ? `${volume.value}%` : t("Off"));
  volume.oninput = showVolume;
  volume.onchange = () => save({ mascot_voice_volume: Number(volume.value) });
  showVolume();

  const clickKey = hotkeyInput(settings.mascot_click_hotkey, (value) =>
    save({ mascot_click_hotkey: value }),
  );

  return [
    toggle("Speech balloons", settings.mascot_talk, (on) => save({ mascot_talk: on })),
    el("div", { class: "field" }, el("span", {}, "Talk on their own"), chatter),
    el("div", { class: "hint-text" }, "After this long without saying anything."),
    el(
      "div",
      { class: "field" },
      el("span", {}, "Voice volume"),
      el("div", { class: "row" }, volume, volumeLabel),
    ),
    el("div", { class: "hint-text" }, "For the sounds you give a mascot with “Voices…”."),
    el("div", { class: "field" }, el("span", {}, "Key to switch clicks on or off"), clickKey),
    el(
      "div",
      { class: "hint-text" },
      "Works everywhere, even in a game: every mascot lets clicks go through, or becomes clickable " +
        "again. Handy if you play with the mascots on screen. Each mascot also has its own “View only”.",
    ),
    ...hideApps(),
    toggle(
      "Hide them over fullscreen apps",
      settings.mascot_hide_fullscreen,
      (on) => save({ mascot_hide_fullscreen: on }),
      "Movies, videos, games… except the VN you're reading.",
    ),
    toggle(
      "Keep them above other windows",
      settings.mascot_topmost,
      (on) => save({ mascot_topmost: on }),
      "Off: they stay on the desktop, behind your windows.",
    ),
    el("div", { class: "row" }, backToCorner),
  ];
}

async function load({ fresh = false } = {}) {
  const [items, personalities, aiReady] = await Promise.all([
    call("list_mascots"),
    call("mascot_personalities"),
    fresh || !part("options").childElementCount ? call("cutout_ready") : null,
  ]);
  part("enabled").replaceChildren(
    toggle("Show on desktop", store.settings.mascot_enabled, (on) => save({ mascot_enabled: on })),
  );
  if (aiReady !== null) {
    part("options").replaceChildren(...options(), ...(aiReady ? [cutoutRow()] : []));
  }
  part("grid").replaceChildren(...items.map((item) => card(item, personalities)));
}

function cutoutRow() {
  const remove = el("button", { class: "btn danger small" });
  confirmButton(remove, "Remove", async () => {
    await call("remove_cutout");
    load({ fresh: true });
  });
  return el("div", { class: "field" }, el("span", {}, "AI model for cutouts (185 MB)"), remove);
}

const GEAR =
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";

const pictureChanged = {};

function pictureOf(item) {
  const fresh = pictureChanged[item.id] ? `?v=${pictureChanged[item.id]}` : "";
  return item.built_in ? "assets/mascot.png" : fileUrl(item.file) + fresh;
}

function gearIcon() {
  const box = svg("svg", { viewBox: "0 0 24 24", class: "mascot-gear", "aria-hidden": "true" });
  box.append(svg("path", { d: GEAR }));
  return box;
}

function card(item, personalities) {
  const picture = el("img", { src: pictureOf(item), alt: "", draggable: "false" });
  const flip = () => call("show_mascot", { id: item.id, shown: !item.shown });

  const settings = el("button", { class: "mascot-settings", title: "Settings", "aria-label": "Settings" }, gearIcon());
  settings.onclick = (event) => {
    event.stopPropagation();
    mascotSettings(item, personalities);
  };

  return el(
    "div",
    {
      class: `mascot-card ${item.shown ? "on" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: flip,
      onkeydown: (event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          flip();
        }
      },
    },
    el("div", { class: "mascot-pic" }, picture),
    el(
      "div",
      { class: "mascot-foot" },
      el(
        "div",
        { class: "mascot-meta" },
        el("b", {}, item.name),
        el("span", { class: "small-text" }, item.shown ? "On your desktop" : "Click to show"),
      ),
      settings,
    ),
  );
}

async function mascotSettings(item, personalities) {
  let close = () => {};
  let shown = item.shown;

  const picture = el("img", { src: pictureOf(item), alt: "", draggable: "false" });
  const stage = el("div", { class: "balloon-stage mascot-stage" }, picture);

  const showButton = el("button", { class: "btn" });
  const paintShow = () => {
    showButton.textContent = t(shown ? "Take it off the desktop" : "Put it on the desktop");
    showButton.classList.toggle("secondary", shown);
  };
  showButton.onclick = () => {
    shown = !shown;
    paintShow();
    call("show_mascot", { id: item.id, shown });
  };
  paintShow();

  let changePicture = null;
  if (!item.built_in) {
    changePicture = el("button", { class: "btn secondary small" }, "Change picture…");
    changePicture.onclick = async () => {
      const path = await pickFile({ title: "Choose a mascot image", filters: MASCOT_IMAGE_FILTERS });
      if (path) {
        await call("change_mascot_image", { id: item.id, path });
        pictureChanged[item.id] = Date.now();
        picture.src = pictureOf(item);
      }
    };
  }

  const name = el("input", { type: "text", maxlength: 60 });
  name.value = t(item.name);
  name.onchange = async () => {
    const value = name.value.trim();
    if (!value) {
      name.value = t(item.name);
      return;
    }
    if (value !== t(item.name)) {
      await call("rename_mascot", { id: item.id, name: value });
      item.name = value;
    }
  };
  name.onkeydown = (event) => {
    if (event.key === "Enter") {
      name.blur();
    }
  };

  const sizeLabel = el("span", { class: "muted" }, `${item.height}px`);
  const size = el("input", { type: "range", min: 120, max: 1200, step: 10, value: item.height });
  size.oninput = () => (sizeLabel.textContent = `${size.value}px`);
  size.onchange = () => {
    item.height = Number(size.value);
    call("set_mascot_size", { id: item.id, height: item.height });
  };

  const personality = el("select", {});
  const editLines = el("button", { class: "btn secondary small" });
  const paintLines = () => {
    const id = personality.value;
    editLines.textContent = t(id === CUSTOM ? "Write its lines…" : isPreset(id) ? "Edit preset…" : "See its lines");
  };
  const refreshChoices = () => {
    if (isPreset(item.personality) && !presets()[item.personality]) {
      item.personality = "cheerful";
    }
    personality.replaceChildren(
      ...personalityChoices(personalities).map(({ id, name }) =>
        el("option", { value: id, selected: id === item.personality }, name),
      ),
    );
    paintLines();
  };
  editLines.onclick = async () => {
    const id = personality.value;
    if (id === CUSTOM) {
      await writeLines(item, personalities);
    } else if (isPreset(id)) {
      await editPreset(id, personalities);
    } else {
      await viewLines(item, id, personalities);
    }
    refreshChoices();
  };
  personality.onchange = async () => {
    await setPersonality(item, personality.value);
    paintLines();
    if (personality.value === CUSTOM) {
      await writeLines(item, personalities);
      refreshChoices();
    }
  };
  refreshChoices();

  const silent = toggle(
    "Doesn't talk",
    !!store.settings.mascot_silent?.[item.id],
    (on) => {
      const all = { ...(store.settings.mascot_silent || {}) };
      if (on) {
        all[item.id] = true;
      } else {
        delete all[item.id];
      }
      store.settings.mascot_silent = all;
      call("update_settings", { changes: { mascot_silent: all } });
    },
    "No bubble or voice. The others talk instead.",
  );

  const viewOnly = toggle(
    "View only",
    item.view_only,
    (on) => {
      item.view_only = on;
      call("set_mascot_view_only", { id: item.id, viewOnly: on });
    },
    "Clicks go through it.",
  );

  const voices = el("button", { class: "btn secondary small" }, "Voices & moments…");
  voices.onclick = () => editVoices(item);
  const bubble = el("button", { class: "btn secondary small" }, "Bubble…");
  bubble.onclick = () => editBalloon(item);
  const share = el("button", { class: "btn secondary small" }, "Share…");
  share.onclick = () => shareMascot(item);

  let remove = null;
  if (!item.built_in) {
    remove = el("button", { class: "btn danger small" });
    confirmButton(remove, "Remove", async () => {
      await call("remove_mascot", { id: item.id });
      close(null);
    });
  }

  const controls = el(
    "div",
    { class: "balloon-controls mascot-controls" },
    el("div", { class: "field-label" }, "Name"),
    name,
    el("div", { class: "field" }, el("span", {}, "Size"), el("div", { class: "row" }, size, sizeLabel)),
    el("div", { class: "field" }, el("span", {}, "Personality"), personality),
    el("div", { class: "row" }, editLines),
    el("div", { class: "field-label" }, "Talking"),
    silent,
    el("div", { class: "row" }, voices, bubble),
    el("div", { class: "field-label" }, "On the desktop"),
    viewOnly,
    el("div", { class: "row mascot-extra" }, share, changePicture, remove),
  );

  await openDialog({
    title: t("{name}'s settings", { name: t(item.name) }),
    width: 860,
    body: el(
      "div",
      { class: "balloon-editor mascot-editor" },
      el("div", { class: "balloon-left" }, stage, showButton),
      controls,
    ),
    actions: [{ label: "Done", value: true }],
    onOpen: (finish) => (close = finish),
  });
  load();
}

const ALL_LINE_FIELDS = [...LINE_FIELDS, ...LIST_FIELDS];
const PRESET = "preset-";

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const rowsFor = (count) => Math.min(8, Math.max(2, count + 1));
const presets = () => store.settings.mascot_presets || {};
const isPreset = (id) => id.startsWith(PRESET);

function personalityChoices(personalities) {
  return [
    ...personalities,
    ...Object.entries(presets()).map(([id, preset]) => ({ id, name: preset.name })),
    { id: CUSTOM, name: t("Custom") },
  ];
}

function linesEditor(defaults, values) {
  const inputs = {};
  const fit = (input) => (input.rows = rowsFor(input.value.split("\n").filter(Boolean).length));
  const fields = ALL_LINE_FIELDS.map(([key, label, hint]) => {
    const input = el("textarea", { placeholder: asList(defaults[key]).join("\n") });
    input.value = asList(values[key]).join("\n");
    input.oninput = () => fit(input);
    fit(input);
    inputs[key] = input;
    return el(
      "label",
      { class: "line-field" },
      el("span", {}, label),
      input,
      hint && el("span", { class: "small-text muted" }, hint),
    );
  });
  const fill = (lines) => {
    for (const [key] of ALL_LINE_FIELDS) {
      inputs[key].value = asList(lines[key]).join("\n");
      fit(inputs[key]);
    }
  };
  const read = () => {
    const lines = {};
    for (const [key] of ALL_LINE_FIELDS) {
      lines[key] = inputs[key].value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
    return lines;
  };
  return { fields, fill, read };
}

function startFrom(personalities, editor) {
  const picker = el(
    "select",
    {},
    el("option", { value: "" }, t("Copy the lines of…")),
    ...personalityChoices(personalities)
      .filter(({ id }) => id !== CUSTOM)
      .map(({ id, name }) => el("option", { value: id }, name)),
  );
  picker.onchange = async () => {
    if (picker.value) {
      editor.fill(await call("personality_lines", { personality: picker.value }));
      picker.value = "";
    }
  };
  return el("div", { class: "row lines-tools" }, picker);
}

async function askPresetName(fallback = "") {
  const input = el("input", { type: "text", maxlength: 40, style: { width: "100%", boxSizing: "border-box" } });
  input.value = fallback;
  const answer = await openDialog({
    title: "Name this preset",
    body: el(
      "div",
      { class: "line-fields" },
      el("p", { class: "muted small-text" }, "It shows up in the Personality list of every mascot."),
      input,
    ),
    actions: [
      { label: "Cancel", kind: "secondary", value: null },
      { label: "Save", value: "save" },
    ],
    onOpen: (finish) => {
      input.select();
      input.addEventListener("keydown", (event) => event.key === "Enter" && finish("save"));
    },
  });
  const name = input.value.trim();
  return answer === "save" && name ? name : null;
}

async function savePresets(all) {
  store.settings.mascot_presets = all;
  await call("update_settings", { changes: { mascot_presets: all } });
}

async function setPersonality(item, personality) {
  item.personality = personality;
  await call("set_mascot_personality", { id: item.id, personality });
}

async function writeLines(item, personalities, start = null) {
  const defaults = await call("personality_lines", { personality: "cheerful" });
  const editor = linesEditor(defaults, start || item.custom || {});

  const answer = await openDialog({
    title: t("{name}'s lines", { name: t(item.name) }),
    wide: true,
    body: el(
      "div",
      { class: "line-fields" },
      el("p", { class: "muted small-text" }, "One line per row: with several, one is picked at random. Leave a box empty to keep the lines shown in grey."),
      startFrom(personalities, editor),
      ...editor.fields,
    ),
    actions: [
      { label: "Cancel", kind: "secondary", value: null },
      { label: "Save as a preset…", kind: "secondary", value: "preset" },
      { label: "Save", value: "save" },
    ],
  });
  if (!answer) {
    return false;
  }
  const lines = editor.read();
  if (answer === "preset") {
    const name = await askPresetName();
    if (!name) {
      return false;
    }
    const id = `${PRESET}${Date.now().toString(36)}`;
    await savePresets({ ...presets(), [id]: { name, lines } });
    await setPersonality(item, id);
    toast(t("Preset “{name}” saved", { name }));
    return true;
  }
  await call("set_mascot_custom_lines", { id: item.id, lines });
  item.custom = lines;
  return true;
}

async function editPreset(id, personalities) {
  const preset = presets()[id];
  if (!preset) {
    return false;
  }
  const defaults = await call("personality_lines", { personality: "cheerful" });
  const editor = linesEditor(defaults, preset.lines || {});
  const name = el("input", { type: "text", maxlength: 40 });
  name.value = preset.name;

  const answer = await openDialog({
    title: t("Preset “{name}”", { name: preset.name }),
    wide: true,
    body: el(
      "div",
      { class: "line-fields" },
      el("label", { class: "line-field" }, el("span", {}, "Name"), name),
      el("p", { class: "muted small-text" }, "Every mascot with this preset uses these lines. One line per row: with several, one is picked at random."),
      startFrom(personalities, editor),
      ...editor.fields,
    ),
    actions: [
      { label: "Delete preset", kind: "danger", value: "delete" },
      { label: "Cancel", kind: "secondary", value: null },
      { label: "Save", value: "save" },
    ],
  });
  const all = { ...presets() };
  if (answer === "delete") {
    delete all[id];
    const chosen = { ...(store.settings.mascot_personalities || {}) };
    for (const [mascot, personality] of Object.entries(chosen)) {
      if (personality === id) {
        chosen[mascot] = "cheerful";
      }
    }
    store.settings.mascot_personalities = chosen;
    store.settings.mascot_presets = all;
    await call("update_settings", { changes: { mascot_presets: all, mascot_personalities: chosen } });
    return true;
  }
  if (answer === "save") {
    all[id] = { name: name.value.trim() || preset.name, lines: editor.read() };
    await savePresets(all);
    return true;
  }
  return false;
}

async function viewLines(item, personality, personalities) {
  const lines = await call("personality_lines", { personality });
  const name = personalities.find(({ id }) => id === personality)?.name || personality;
  const sections = ALL_LINE_FIELDS.map(([key, label]) =>
    el(
      "div",
      { class: "line-view" },
      el("b", {}, label),
      el("ul", {}, ...asList(lines[key]).map((line) => el("li", {}, line))),
    ),
  );
  const answer = await openDialog({
    title: t("{name}'s lines", { name: t(name) }),
    wide: true,
    body: el("div", { class: "line-fields" }, ...sections),
    actions: [
      { label: "Close", kind: "secondary", value: null },
      { label: "Edit a copy…", value: "copy" },
    ],
  });
  if (answer !== "copy") {
    return false;
  }
  const saved = await writeLines(item, personalities, lines);
  if (saved && !isPreset(item.personality)) {
    await setPersonality(item, CUSTOM);
  }
  return saved;
}

const fileName = (path) => path.split(/[\\/]/).pop();

const mascotVolume = (id) => store.settings.mascot_voice_volumes?.[id] ?? 100;

let preview = null;
function playPreview(path, id) {
  preview?.pause();
  preview = new Audio(fileUrl(path));
  preview.volume = ((store.settings.mascot_voice_volume ?? 80) / 100) * (mascotVolume(id) / 100);
  preview.play().catch(() => {});
}

function voiceVolume(item) {
  const range = el("input", { type: "range", min: 0, max: 100, step: 5, value: mascotVolume(item.id) });
  const label = el("span", { class: "muted", style: { width: "44px", textAlign: "right" } });
  const show = () => (label.textContent = Number(range.value) ? `${range.value}%` : t("Off"));
  range.oninput = show;
  range.onchange = async () => {
    const volumes = { ...(store.settings.mascot_voice_volumes || {}), [item.id]: Number(range.value) };
    store.settings.mascot_voice_volumes = volumes;
    await call("update_settings", { changes: { mascot_voice_volumes: volumes } });
  };
  show();
  return el(
    "div",
    { class: "field" },
    el("span", {}, "This mascot's volume"),
    el("div", { class: "row" }, range, label),
  );
}

async function editVoices(item) {
  const body = el("div", { class: "line-fields" });
  const volume = voiceVolume(item);

  const render = async () => {
    const voices = await call("mascot_voices", { id: item.id });
    const muted = store.settings.mascot_muted_moments?.[item.id] || [];
    const rows = VOICE_MOMENTS.map(([moment, label]) => {
      const talks = el("input", { type: "checkbox", checked: !muted.includes(moment) });
      talks.onchange = () => {
        const all = { ...(store.settings.mascot_muted_moments || {}) };
        const list = (all[item.id] || []).filter((m) => m !== moment);
        if (!talks.checked) {
          list.push(moment);
        }
        if (list.length) {
          all[item.id] = list;
        } else {
          delete all[item.id];
        }
        store.settings.mascot_muted_moments = all;
        row.classList.toggle("off", !talks.checked);
        call("update_settings", { changes: { mascot_muted_moments: all } });
      };
      const files = (voices[moment] || []).map((path) => {
        const play = el("button", { class: "btn secondary small", title: "Play" }, "▶");
        play.onclick = () => playPreview(path, item.id);
        const remove = el("button", { class: "btn danger small", title: "Remove" }, "✕");
        remove.onclick = async () => {
          await call("remove_mascot_voice", { path });
          render();
        };
        return el("div", { class: "voice-file" }, play, el("span", {}, fileName(path)), remove);
      });

      const add = el("button", { class: "btn secondary small" }, "Add a sound…");
      add.onclick = async () => {
        const path = await pickFile({ title: "Choose a sound", filters: AUDIO_FILTERS });
        if (path) {
          await call("add_mascot_voice", { id: item.id, event: moment, path });
          render();
        }
      };

      const row = el(
        "div",
        { class: `voice-moment ${talks.checked ? "" : "off"}` },
        el(
          "div",
          { class: "row" },
          el("label", { class: "voice-talks", title: "Untick so this mascot stays quiet here. The others talk instead." }, talks, el("b", {}, label)),
          add,
        ),
        files.length
          ? el("div", { class: "voice-files" }, ...files)
          : el("span", { class: "small-text muted" }, "No sound: it only shows the text."),
      );
      return row;
    });
    body.replaceChildren(
      el(
        "p",
        { class: "muted small-text" },
        "Sounds play with what the mascot says. When a moment has several lines, sounds go " +
          "with the lines in order: the 1st sound (by file name) with the 1st line, and so on. " +
          "Otherwise, one is picked at random.",
      ),
      el("p", { class: "muted small-text" }, "Untick a moment to keep this mascot quiet then: the others talk instead."),
      volume,
      ...rows,
    );
  };

  await render();
  await openDialog({
    title: t("{name}'s voice", { name: t(item.name) }),
    wide: true,
    body,
    actions: [{ label: "Done", value: true }],
  });
  preview?.pause();
}

const BALLOON_ANIM_NAMES = [
  ["pop", "Pop"],
  ["fade", "Fade"],
  ["bounce", "Bounce"],
  ["slide", "Slide"],
  ["type", "Letter by letter"],
];

const BALLOON_FONT_NAMES = [
  ["app", "App font"],
  ["rounded", "Rounded"],
  ["serif", "Serif"],
  ["mono", "Monospace"],
  ["hand", "Handwritten"],
];

function hexOf(color) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color.trim() || "#000000";
  const value = ctx.fillStyle;
  if (value.startsWith("#")) {
    return value;
  }
  const [r, g, b] = value.match(/\d+/g).map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function themeColor(name) {
  return hexOf(getComputedStyle(document.documentElement).getPropertyValue(name));
}

function sameStyle(a, b, keys = Object.keys(BALLOON_DEFAULT)) {
  return keys.every((key) => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null));
}

const LOOK_KEYS = Object.keys(BALLOON_DEFAULT).filter((key) => !["pos", "size", "anim"].includes(key));

function pictureBox(img, stage) {
  const box = img.getBoundingClientRect();
  const frame = stage.getBoundingClientRect();
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : box.width / box.height;
  let width = box.width;
  let height = box.height;
  if (width / height > ratio) {
    width = height * ratio;
  } else {
    height = width / ratio;
  }
  return {
    left: box.left - frame.left + (box.width - width) / 2,
    top: box.top - frame.top + (box.height - height) / 2,
    width,
    height,
  };
}

function draggableBubble(bubble, picture, stage, getPos, setPos) {
  const place = () => {
    const pic = pictureBox(picture, stage);
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const pos = getPos();
    let x;
    let y;
    let toRight;
    if (pos) {
      x = pic.left + pos[0] * pic.width - w / 2;
      y = pic.top + pos[1] * pic.height - h / 2;
      toRight = pos[0] < 0.5;
    } else {
      x = pic.left - w + pic.width / 6;
      toRight = x >= 0;
      if (!toRight) {
        x = pic.left + pic.width - pic.width / 6;
      }
      y = pic.top + pic.height / 10;
    }
    x = Math.max(0, Math.min(x, stage.clientWidth - w));
    y = Math.max(0, Math.min(y, stage.clientHeight - h));
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
    bubble.classList.toggle("to-right", toRight);
  };

  bubble.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    bubble.setPointerCapture(event.pointerId);
    bubble.classList.add("dragging");
    const startX = event.clientX - bubble.offsetLeft;
    const startY = event.clientY - bubble.offsetTop;
    const move = (e) => {
      const pic = pictureBox(picture, stage);
      const x = Math.max(0, Math.min(e.clientX - startX, stage.clientWidth - bubble.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - startY, stage.clientHeight - bubble.offsetHeight));
      const cx = (x + bubble.offsetWidth / 2 - pic.left) / pic.width;
      const cy = (y + bubble.offsetHeight / 2 - pic.top) / pic.height;
      setPos([Math.round(cx * 1000) / 1000, Math.round(cy * 1000) / 1000]);
      place();
    };
    const up = () => {
      bubble.classList.remove("dragging");
      bubble.removeEventListener("pointermove", move);
      bubble.removeEventListener("pointerup", up);
      bubble.removeEventListener("pointercancel", up);
    };
    bubble.addEventListener("pointermove", move);
    bubble.addEventListener("pointerup", up);
    bubble.addEventListener("pointercancel", up);
  });

  picture.addEventListener("load", place);
  new ResizeObserver(place).observe(bubble);
  return place;
}

async function editBalloon(item) {
  let draft = balloonStyle(store.settings, item.id);

  const sampleText = t("Hi! This is how I'll talk to you while you read.");
  const words = el("span", { class: "balloon-text" }, sampleText);
  const bubble = el("div", { class: "balloon to-right" }, words);
  const replay = () => playBalloon(bubble, words, sampleText, draft);
  const picture = el("img", {
    src: item.built_in ? "assets/mascot.png" : fileUrl(item.file),
    alt: "",
    draggable: "false",
  });
  const stage = el("div", { class: "balloon-stage" }, picture, bubble);
  const controls = el("div", { class: "balloon-controls" });
  const autoPlace = el("button", { class: "btn secondary small" }, "Put it back automatically");
  const placeBubble = draggableBubble(
    bubble,
    picture,
    stage,
    () => draft.pos,
    (pos) => {
      draft.pos = pos;
      autoPlace.disabled = false;
    },
  );
  autoPlace.disabled = !draft.pos;
  autoPlace.onclick = () => {
    draft.pos = null;
    autoPlace.disabled = true;
    placeBubble();
  };

  const update = (changes) => {
    draft = { ...draft, ...changes };
    applyBalloon(bubble, draft);
    placeBubble();
  };

  const colorInput = (key, label, fallback) => {
    const input = el("input", { type: "color", value: draft[key] || themeColor(fallback) });
    input.oninput = () => update({ [key]: input.value });
    return el("label", {}, input, label);
  };

  const range = (key, label, min, max, unit = "px") => {
    const input = el("input", { type: "range", min, max, step: 1, value: draft[key] });
    const shown = el("span", { class: "muted" });
    const show = () => (shown.textContent = `${input.value}${unit}`);
    input.oninput = () => {
      show();
      update({ [key]: Number(input.value) });
    };
    show();
    return el("div", { class: "field" }, el("span", {}, label), el("div", { class: "row" }, input, shown));
  };

  const render = () => {
    applyBalloon(bubble, draft);
    requestAnimationFrame(placeBubble);
    const presets = el(
      "div",
      { class: "balloon-presets" },
      ...BALLOON_PRESETS.map(([name, preset]) => {
        const style = { ...BALLOON_DEFAULT, ...preset };
        const sample = el("span", { class: "balloon" }, el("span", { class: "balloon-text" }, "Aa"));
        applyBalloon(sample, { ...style, tail: false, shadow: false, size: 12 });
        const button = el(
          "button",
          { class: `balloon-preset ${sameStyle(style, draft, LOOK_KEYS) ? "on" : ""}`, title: name },
          sample,
          el("span", { class: "small-text" }, name),
        );
        button.onclick = () => {
          draft = { ...style, size: draft.size, pos: draft.pos, anim: draft.anim };
          render();
        };
        return button;
      }),
    );

    const font = el(
      "select",
      {},
      ...BALLOON_FONT_NAMES.map(([value, label]) =>
        el("option", { value, selected: value === draft.font }, t(label)),
      ),
    );
    font.onchange = () => update({ font: font.value });

    const anim = el(
      "select",
      {},
      ...BALLOON_ANIM_NAMES.map(([value, label]) =>
        el("option", { value, selected: value === draft.anim }, t(label)),
      ),
    );
    anim.onchange = () => {
      update({ anim: anim.value });
      replay();
    };
    const again = el("button", { class: "btn secondary small", title: "Replay" }, "▶");
    again.onclick = replay;

    controls.replaceChildren(
      el("div", { class: "field-label" }, "Style"),
      presets,
      el(
        "div",
        { class: "custom-colors" },
        colorInput("bg", "Background", "--surface"),
        colorInput("border", "Border", "--accent"),
        colorInput("text", "Text", "--text"),
      ),
      range("width", "Border width", 0, 6),
      range("radius", "Roundness", 0, 30),
      range("size", "Text size", 11, 20),
      el("div", { class: "field" }, el("span", {}, "Font"), font),
      el("div", { class: "field" }, el("span", {}, "Animation"), el("div", { class: "row" }, again, anim)),
      toggle("Tail", draft.tail, (on) => update({ tail: on }), "Points at the mascot."),
      toggle("Shadow", draft.shadow, (on) => update({ shadow: on })),
      toggle("Bold text", draft.bold, (on) => update({ bold: on })),
    );
  };
  render();

  const answer = await openDialog({
    title: t("{name}'s bubble", { name: t(item.name) }),
    width: 1000,
    body: el(
      "div",
      { class: "balloon-editor" },
      el(
        "div",
        { class: "balloon-left" },
        stage,
        el("div", { class: "hint-text" }, "Drag the bubble to choose where it shows up next to the mascot."),
        autoPlace,
      ),
      controls,
    ),
    actions: [
      { label: "Reset", kind: "secondary", value: "reset" },
      { label: "Cancel", kind: "secondary", value: null },
      { label: "Save", value: "save" },
    ],
  });
  if (!answer) {
    return;
  }
  const balloons = { ...(store.settings.mascot_balloons || {}) };
  if (answer === "reset" || sameStyle(draft, BALLOON_DEFAULT)) {
    delete balloons[item.id];
  } else {
    balloons[item.id] = draft;
  }
  store.settings.mascot_balloons = balloons;
  await call("update_settings", { changes: { mascot_balloons: balloons } });
}

async function shareMascot(item) {
  const name = t(item.name);
  const path = await pickSaveFile({
    title: "Share this mascot",
    defaultPath: `${name}.${PACK_EXTENSION}`,
    filters: PACK_FILTERS,
  });
  if (path) {
    await call("export_mascot", { id: item.id, path });
    toast(t("Saved. Send this file so others can add {name}.", { name }));
  }
}

async function addMascot() {
  const path = await pickFile({ title: "Choose a mascot image", filters: MASCOT_FILTERS });
  if (path) {
    await call("add_mascot", { path });
  }
}

register({ id: "mascots", build, show: () => load({ fresh: true }) });
