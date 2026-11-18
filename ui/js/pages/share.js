import { $, html, svg } from "../dom.js";
import { isoDay } from "../format.js";
import { invoke, pickSaveFile } from "../tauri.js";
import { register } from "../router.js";
import { store } from "../store.js";
import { resolveTheme } from "../themes.js";
import { call, flashLabel } from "../ui.js";
import { collect, render, MAX_COVERS, PERIODS } from "../components/share-card.js";
import { openRecap, recapYear } from "../components/recap.js";
import { t } from "../i18n.js";

const TEMPLATE = `
  <div class="page-head">
    <h2>Share your reading</h2>
    <div class="seg" data-id="period">
      <button data-v="this_week">This week</button>
      <button data-v="last_week">Last week</button>
      <button data-v="this_month">This month</button>
      <button data-v="last_month">Last month</button>
    </div>
  </div>

  <div class="share-preview"><canvas class="loading" data-id="canvas" width="1280" height="720"></canvas></div>

  <div class="row">
    <button class="btn" data-id="copy">Copy image</button>
    <button class="btn secondary" data-id="save">Save…</button>
    <span class="muted">Then paste it in a Discord message with Ctrl+V.</span>
  </div>

  <div class="row">
    <button class="btn secondary btn-ext" data-id="recap"></button>
  </div>
`;

let root;
let periodKind = "this_week";
let drawing = 0;
const coverImages = new Map();
const readyCovers = new Map();
const knownNsfw = new Map();
const lastGames = new Map();
let iconImage = null;

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));

  for (const button of part("period").querySelectorAll("button")) {
    button.onclick = () => {
      periodKind = button.dataset.v;
      draw();
    };
  }
  part("copy").onclick = copy;
  part("save").onclick = save;
  const icon = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  icon.append(svg("path", { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }));
  part("recap").replaceChildren(t("My {year} recap", { year: recapYear() }), icon);
  part("recap").onclick = () => openRecap();
}

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function learnNsfw(vns) {
  const unknown = vns.filter((vn) => vn.nsfw === null).map((vn) => vn.key);
  if (!unknown.length) {
    return;
  }
  try {
    const learned = await invoke("learn_cover_nsfw", { keys: unknown });
    for (const vn of vns) {
      if (vn.key in learned) {
        vn.nsfw = learned[vn.key];
        knownNsfw.set(vn.key, vn.nsfw);
      }
    }
  } catch {}
}

// Each cover is resized once by the backend (and cached on disk), then kept here.
function coverImage(path) {
  if (!coverImages.has(path)) {
    const loading = invoke("image_data_url", { path, width: 288, height: 408 })
      .then((url) => loadImage(url))
      .catch(() => null)
      .then((image) => {
        if (image) {
          readyCovers.set(path, image);
        } else {
          coverImages.delete(path);
        }
        return image;
      });
    coverImages.set(path, loading);
  }
  return coverImages.get(path);
}

async function draw() {
  const job = ++drawing;
  for (const button of part("period").querySelectorAll("button")) {
    button.classList.toggle("on", button.dataset.v === periodKind);
  }
  part("copy").disabled = true;

  const allowNsfw = !!store.settings.allow_nsfw_covers;
  iconImage ??= loadImage("assets/app_icon.png");
  const kind = periodKind;
  const paint = (games, icon) => {
    const data = collect(games, kind);
    const shown = data.vns.slice(0, MAX_COVERS);
    for (const vn of shown) {
      if (vn.nsfw === null && knownNsfw.has(vn.key)) {
        vn.nsfw = knownNsfw.get(vn.key);
      }
    }
    const covers = new Map();
    for (const vn of shown) {
      const image = vn.cover && readyCovers.get(vn.cover);
      if (image && (allowNsfw || vn.nsfw !== null)) {
        covers.set(vn.key, image);
      }
    }
    const palette = resolveTheme(store.settings.theme || "system", store.settings.custom_theme);
    render(part("canvas"), data, { palette, covers, icon, allowNsfw });
    return shown;
  };

  const icon = await iconImage;
  if (job !== drawing) {
    return;
  }
  if (lastGames.has(kind)) {
    paint(lastGames.get(kind), icon);
    part("canvas").classList.remove("loading");
  }

  const games = await call("share_games");
  if (job !== drawing) {
    return;
  }
  lastGames.set(kind, games);
  const shown = paint(games, icon);

  await Promise.all([
    allowNsfw ? null : learnNsfw(shown),
    ...shown.filter((vn) => vn.cover).map((vn) => coverImage(vn.cover)),
  ]);
  if (job !== drawing) {
    return;
  }
  paint(games, icon);
  part("canvas").classList.remove("loading");
  part("copy").disabled = false;
}

async function copy() {
  await call("copy_png", { dataUrl: part("canvas").toDataURL("image/png") });
  flashLabel(part("copy"), "Copied ✓", "Copy image");
}

async function save() {
  const name = `vn-${PERIODS[periodKind].toLowerCase().replace(" ", "-")}-${isoDay(new Date())}.png`;
  const path = await pickSaveFile({
    title: "Save the card",
    defaultPath: name,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (path) {
    await call("save_png", { path, dataUrl: part("canvas").toDataURL("image/png") });
  }
}

register({
  id: "share",
  fill: true,
  build,
  show: draw,
  onKey: (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "c") {
      copy();
    }
  },
});
