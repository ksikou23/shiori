import { $, el, html } from "../dom.js";
import { currentPage, register, show } from "../router.js";
import { store } from "../store.js";
import { ask, call, openDialog, setCover, toast, toggle } from "../ui.js";
import { language as uiLanguage, plural, t } from "../i18n.js";
import { defaultReleaseMedium, matchesRelease } from "../release-filters.js";

const RELEASE_TYPES = {
  pkgfront: "Front",
  pkgback: "Back",
  pkgside: "Side",
  pkgmed: "Medium",
  dig: "Digital",
};

const PLATFORM_NAMES = {
  win: "Windows",
  lin: "Linux",
  mac: "macOS",
  web: "Web",
  and: "Android",
  ios: "iOS",
  swi: "Nintendo Switch",
  sw2: "Nintendo Switch 2",
  ps1: "PlayStation 1",
  ps2: "PlayStation 2",
  ps3: "PlayStation 3",
  ps4: "PlayStation 4",
  ps5: "PlayStation 5",
  psp: "PSP",
  psv: "PlayStation Vita",
};

const platformName = (code) => PLATFORM_NAMES[code] || code.toUpperCase();

const TEMPLATE = `
  <button class="back" data-id="back">← Back</button>
  <h2 data-id="title"></h2>

  <div class="card">
    <div class="tabs" data-id="tabs">
      <button data-tab="vndb">Search VNDB</button>
      <button data-tab="url">Image link</button>
    </div>

    <div data-tab-body="vndb">
      <form class="row" data-id="search-form" style="margin: 14px 0 6px">
        <input type="search" class="wide" data-id="query" placeholder="Visual novel title…" />
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="hint-text" data-id="search-status"></div>
      <div class="vn-results" data-id="results"></div>
    </div>

    <div data-tab-body="url" hidden>
      <p class="muted small-text" style="margin-top: 14px">
        A direct link to a public image (jpg / png / webp). This link is what Discord will display.
      </p>
      <input type="text" class="wide" data-id="url" placeholder="https://…" style="width: 100%" />
      <div class="preview-area">
        <div class="cover preview" data-id="url-preview"></div>
        <div class="row">
          <button class="btn secondary" data-id="url-show">Preview</button>
          <button class="btn" data-id="url-use">Use this image</button>
        </div>
        <div class="hint-text" data-id="url-status"></div>
      </div>
    </div>
  </div>
`;

let root;
let key = "";
let backTo = "home";
let pageVersion = 0;
let selectedVnId = "";

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));

  part("back").onclick = goBack;
  for (const tab of root.querySelectorAll("[data-tab]")) {
    tab.onclick = () => openTab(tab.dataset.tab);
  }

  part("search-form").onsubmit = (event) => {
    event.preventDefault();
    search();
  };

  part("url-show").onclick = previewUrl;
  part("url-use").onclick = useUrl;
  part("url").onkeydown = (event) => {
    if (event.key === "Enter") {
      previewUrl();
    }
  };

}

async function showPage({ key: wanted, back = "home", chooseRelease = false }) {
  key = wanted;
  backTo = back;
  const version = ++pageVersion;

  const game = await call("get_game", { key });
  if (version !== pageVersion || currentPage()?.id !== "cover") return;
  selectedVnId = game.entry.vndb_id || game.entry.matched_vndb_id || "";
  part("title").textContent = t("VN & cover — {name}", { name: game.name });

  openTab("vndb");

  part("query").value = game.entry.title || game.entry.name || game.name;
  part("url").value = "";
  setCover(part("url-preview"));
  part("url-status").textContent = "";
  search();
  const vnId = selectedVnId;
  if (chooseRelease && vnId) {
    try {
      const vn = await call("get_vndb", { vnId });
      if (version === pageVersion && currentPage()?.id === "cover") selectRelease(vn);
    } catch {
      return;
    }
  }
}

function goBack() {
  if (backTo === "game") {
    show("game", { key });
  } else {
    show("home");
  }
}

function openTab(name) {
  for (const tab of root.querySelectorAll("[data-tab]")) {
    tab.classList.toggle("on", tab.dataset.tab === name);
  }
  for (const body of root.querySelectorAll("[data-tab-body]")) {
    body.hidden = body.dataset.tabBody !== name;
  }
}

async function okToUseNsfw(nsfw) {
  if (!nsfw || store.settings.allow_nsfw_covers) {
    return true;
  }
  return ask(
    "NSFW cover",
    "VNDB flags this cover as NSFW. It will be shown blurred in the app and NOT sent to Discord " +
      "unless you allow NSFW covers in Settings. Use it anyway?",
    { yes: "Use it" },
  );
}

function isAutomaticCover(entry) {
  const source = entry.cover_source || "";
  return !source || source === "vndb" || source === "vndb_release";
}

async function chooseReleaseCoverAction() {
  return openDialog({
    title: t("Change cover?"),
    body: el(
      "p",
      { class: "muted" },
      t("The current cover is not automatic. Replace it with the selected release cover (or the VN cover if none is available), or keep the current cover?"),
    ),
    actions: [
      { label: t("Cancel"), kind: "secondary", value: null },
      { label: t("Keep current cover"), kind: "secondary", value: "keep" },
      { label: t("Use automatic cover"), value: "auto" },
    ],
  });
}

async function done(message) {
  toast(message);
  goBack();
}

async function search() {
  const query = part("query").value.trim();
  if (!query) {
    return;
  }

  part("search-status").textContent = t("Searching…");
  part("results").replaceChildren();

  let results;
  try {
    results = await call("search_vndb", { query });
  } catch {
    part("search-status").textContent = t("Search failed.");
    return;
  }

  part("search-status").textContent = results.length
    ? plural(results.length, "result")
    : t("No results — try the original (Japanese) or a shorter title.");
  part("results").replaceChildren(...results.map(resultRow));
}

function rating(value) {
  return value > 10 ? (value / 10).toFixed(1) : value.toFixed(1);
}

function vndbIdButton(id) {
  return el(
    "button",
    {
      class: "chip quiet",
      type: "button",
      title: "View on VNDB",
      onclick: () => call("open_url", { url: `https://vndb.org/${id}` }),
    },
    id,
  );
}

function resultRow(vn) {
  const selected = vn.id === selectedVnId;
  const picture = el("div", { class: "cover tiny" });
  setCover(picture, { url: vn.image_url, nsfw: vn.nsfw, label: vn.title });

  const chips = el(
    "div",
    { class: "chips" },
    vndbIdButton(vn.id),
    vn.rating > 0 && el("span", { class: "chip quiet" }, `★ ${rating(vn.rating)}`),
    vn.nsfw && el("span", { class: "chip warn" }, "NSFW cover"),
    selected && el("span", { class: "chip quiet" }, "Selected"),
  );

  const title = vn.year ? `${vn.title}  (${vn.year})` : vn.title;
  const info = el(
    "div",
    { class: "info" },
    el("div", { class: "title" }, title),
    vn.alt_title && el("div", { class: "muted small-text" }, vn.alt_title),
    chips,
  );

  const buttons = el(
    "div",
    { class: "row" },
    el(
      "button",
      { class: "btn secondary small", onclick: () => releaseCovers(vn) },
      "Other covers…",
    ),
    el(
      "button",
      { class: "btn secondary small", onclick: () => selectRelease(vn) },
      "Choose release…",
    ),
    el("button", { class: "btn small", onclick: () => useVn(vn) }, "Use"),
  );

  return el("div", { class: `card vn-result${selected ? " selected" : ""}` }, picture, info, buttons);
}

async function useVn(vn) {
  if (!(await okToUseNsfw(vn.nsfw))) {
    return;
  }
  await call("set_game_vn", { key, vnId: vn.id, title: vn.title, nsfw: vn.nsfw });
  done(t("Now using {title}", { title: vn.title }));
}

function releaseCover(release) {
  for (const kind of ["pkgfront", "dig"]) {
    const image = release.images.find((item) => item.type === kind && item.url);
    if (image) return image;
  }
  return null;
}

export function chooseReleaseForGame(gameKey, vn) {
  return selectRelease(vn, gameKey, true);
}

async function selectRelease(vn, gameKey = key, inPlace = false) {
  const list = el("div", { class: "vn-results" }, el("div", { class: "muted" }, "Loading releases…"));
  let productOnly = true;
  let render = () => {};
  const product = toggle("Official products only", productOnly, (checked) => {
    productOnly = checked;
    render();
  });
  const language = el("select", { "aria-label": "Language" });
  const platform = el("select", { "aria-label": "Platform" });
  const mediumHelp = "Change the default in Settings → General → Covers & matching.";
  const medium = el(
    "select",
    { "aria-label": "Release medium", title: mediumHelp },
    el("option", { value: "" }, "Any"),
    el("option", { value: "package" }, "Package"),
    el("option", { value: "download" }, "Download"),
    el("option", { value: "other" }, "Other / unknown"),
  );
  medium.value = defaultReleaseMedium(store.settings.vndb_release_medium);
  const filters = el(
    "div",
    { class: "reco-filters", hidden: true },
    product,
    el("label", { class: "reco-filter" }, el("span", {}, "Language"), language),
    el("label", { class: "reco-filter" }, el("span", {}, "Platform"), platform),
    el("label", { class: "reco-filter", title: mediumHelp }, el("span", {}, "Release medium"), medium),
  );
  const hint = el("p", { class: "hint-text" });
  const count = el("span", { class: "muted small-text" });
  const summary = el(
    "div",
    { class: "row release-count", hidden: true },
    count,
    el("button", {
      class: "btn secondary small",
      onclick: () => {
        productOnly = false;
        product.querySelector("input").checked = false;
        language.value = "";
        platform.value = "";
        medium.value = "";
        render();
      },
    }, "View all"),
  );
  const current = el("div", { class: "vn-results" });
  const body = el(
    "div",
    {},
    filters,
    hint,
    current,
    summary,
    list,
  );
  let closeDialog;
  let closed = false;
  let busy = false;
  const isCurrent = () => !closed && (inPlace || key === gameKey);
  const dialog = openDialog({
    title: t("Choose release — {title}", { title: vn.title }),
    body,
    wide: true,
    closeOnBackdrop: true,
    actions: [{ label: "Close", kind: "secondary", value: null }],
    onOpen: (close) => (closeDialog = close),
  });
  dialog.then(() => (closed = true));

  let result;
  let selected;
  let automaticCover = false;
  try {
    const [releases, game] = await Promise.all([
      call("vndb_releases", { vnId: vn.id }),
      call("get_game", { key: gameKey }),
    ]);
    result = releases;
    selected = game.entry.vndb_id === vn.id && game.entry.vndb_release_id
      ? { id: game.entry.vndb_release_id, title: game.entry.vndb_release_title }
      : null;
    automaticCover = isAutomaticCover(game.entry);
  } catch {
    if (!closed) list.replaceChildren(el("div", { class: "error-text" }, "Couldn't load the releases."));
    await dialog;
    return;
  }
  if (!isCurrent()) return;
  const releases = result.releases;
  const languages = new Set(releases.flatMap((release) => release.languages.map((item) => item.lang)));
  if (result.original_language) languages.add(result.original_language);
  const displayNames = new Intl.DisplayNames([uiLanguage], { type: "language" });
  const languageLabel = (code) => {
    try {
      return `${displayNames.of(code) || code} (${code})`;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return code;
    }
  };
  language.replaceChildren(
    el("option", { value: "" }, "All languages"),
    ...[...languages].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b), uiLanguage))
      .map((code) => el(
        "option",
        { value: code },
        code === result.original_language
          ? t("{language} (original)", { language: languageLabel(code) })
          : languageLabel(code),
      )),
  );
  language.value = result.original_language || "";
  const platforms = new Set(["win", ...releases.flatMap((release) => release.platforms)]);
  platform.replaceChildren(
    el("option", { value: "" }, "All platforms"),
    ...[...platforms].sort((a, b) => platformName(a).localeCompare(platformName(b), uiLanguage))
      .map((code) => el("option", { value: code }, platformName(code))),
    ...(releases.some((release) => !release.platforms.length)
      ? [el("option", { value: "__unknown" }, "Platform not specified")]
      : []),
  );
  platform.value = "win";
  hint.textContent = result.original_language
    ? t("Official products exclude trials, patches and unofficial releases. Download cards match both media filters.")
    : t("Original language unavailable; showing all languages. Official products exclude trials, patches and unofficial releases.");
  filters.hidden = false;
  summary.hidden = false;

  render = () => {
    const visible = releases.filter((release) => matchesRelease(release, vn.id, {
      productOnly,
      language: language.value,
      platform: platform.value,
      medium: medium.value,
    }));
    const selectedRelease = selected && releases.find((release) => release.id === selected.id);
    const selectedVisible = selected && visible.some((release) => release.id === selected.id);
    current.replaceChildren(...(selected && !selectedVisible
      ? [
          el("div", { class: "muted small-text" }, "Current release (not in filtered results)"),
          selectedRelease ? releaseRow(selectedRelease) : missingReleaseRow(),
        ]
      : []));
    count.textContent = t("{count} of {total} releases", { count: visible.length, total: releases.length });
    if (!visible.length) {
      list.replaceChildren(el("div", { class: "muted" }, "No releases match these filters."));
      return;
    }
    list.replaceChildren(...visible.map(releaseRow));
  };
  language.onchange = render;
  platform.onchange = render;
  medium.onchange = render;

  async function clearSelected() {
    if (busy || !isCurrent() || !selected) return;
    busy = true;
    try {
      await call("clear_game_release", { key: gameKey, vnId: vn.id, releaseId: selected.id });
      selected = null;
      if (isCurrent()) {
        render();
        toast("Release selection cleared");
      }
    } finally {
      busy = false;
    }
  }

  function missingReleaseRow() {
    return el(
      "div",
      { class: "card vn-result selected" },
      el("div", { class: "info" },
        selected.title && el("div", { class: "title" }, selected.title),
        el("div", { class: "chips" }, vndbIdButton(selected.id), el("span", { class: "muted small-text release-status" }, "Selected")),
      ),
      el("button", { class: "btn secondary small", onclick: clearSelected }, "Clear release"),
    );
  }

  function releaseRow(release) {
    const isSelected = selected?.id === release.id;
    const releaseType = release.vns.find((item) => item.id === vn.id)?.rtype;
    const media = release.media.map(({ medium }) => {
      if (medium === "in") return t("Download");
      if (medium === "dc") return t("Download card");
      if (medium === "otc") return t("Other / unknown");
      return medium.toUpperCase();
    });
    if (!media.length) media.push(t("Other / unknown"));
    const image = releaseCover(release);
    const nsfw = image ? (image.sexual >= 1 || image.violence >= 1) : vn.nsfw;
    const title = release.title;
    const alternateTitle = [
      ...release.languages.filter((language) => language.lang === result.original_language)
        .map((language) => language.title),
      release.alttitle,
    ].map((value) => value?.trim()).find((value) => value && value !== title.trim());
    const picture = el("div", { class: "cover tiny" });
    setCover(picture, { url: image?.url || vn.image_url, nsfw, label: title });
    const details = [
      release.released,
      release.languages.map((language) => language.lang).join(", "),
      release.platforms.map(platformName).join(", "),
      media.join(", "),
    ].filter(Boolean).join(" · ");
    const use = async () => {
      if (busy) return;
      busy = true;
      try {
        let keepCover = false;
        if (!automaticCover) {
          const choice = await chooseReleaseCoverAction();
          if (!choice || !isCurrent()) return;
          keepCover = choice === "keep";
        }
        if ((!keepCover && !(await okToUseNsfw(nsfw))) || !isCurrent()) return;
        await call("set_game_release", {
          key: gameKey,
          vnId: vn.id,
          title: vn.title,
          releaseId: release.id,
          keepCover,
        });
        if (isCurrent()) {
          closeDialog(null);
          const message = t("Now using {title}", { title });
          if (inPlace) {
            toast(message);
          } else {
            done(message);
          }
        }
      } finally {
        busy = false;
      }
    };
    return el(
      "div",
      { class: `card vn-result${isSelected ? " selected" : ""}` },
      picture,
      el(
        "div",
        { class: "info" },
        el("div", { class: "title" }, document.createTextNode(title)),
        alternateTitle && el("div", { class: "muted small-text" }, document.createTextNode(alternateTitle)),
        el("div", { class: "muted small-text" }, details),
        el(
          "div",
          { class: "chips" },
          vndbIdButton(release.id),
          isSelected && el("span", { class: "muted small-text release-status" }, "Selected"),
          release.vns.length > 1 && el("span", { class: "chip quiet" }, "Multiple VNs"),
          releaseType === "trial" && el("span", { class: "chip quiet" }, "Trial"),
          release.patch && el("span", { class: "chip quiet" }, "Patch"),
          !release.official && el("span", { class: "chip quiet" }, "Unofficial"),
          nsfw && el("span", { class: "chip warn" }, "NSFW cover"),
        ),
      ),
      isSelected
        ? el("button", { class: "btn secondary small", onclick: clearSelected }, "Clear release")
        : el("button", { class: "btn small", onclick: use }, "Use"),
    );
  }
  render();
  await dialog;
}

async function releaseCovers(vn) {
  const grid = el(
    "div",
    { class: "release-grid" },
    el("div", { class: "muted" }, "Loading releases…"),
  );
  let closeDialog = () => {};

  const dialog = openDialog({
    title: t("Release covers — {title}", { title: vn.title }),
    body: grid,
    wide: true,
    actions: [{ label: "Close", kind: "secondary", value: null }],
    onOpen: (close) => (closeDialog = close),
  });

  let covers;
  try {
    covers = await call("release_covers", { vnId: vn.id });
  } catch {
    grid.replaceChildren(el("div", { class: "error-text" }, "Couldn't load the releases."));
    return;
  }

  if (!covers.length) {
    grid.replaceChildren(
      el("div", { class: "muted" }, "No other release covers found for this VN."),
    );
    return;
  }

  grid.replaceChildren(
    ...covers.map((cover) => {
      const picture = el("div", { class: "cover" });
      setCover(picture, { url: cover.url, nsfw: cover.nsfw });

      const caption =
        (RELEASE_TYPES[cover.kind] || cover.kind || "Cover") + (cover.nsfw ? " · NSFW" : "");

      const use = async () => {
        if (!(await okToUseNsfw(cover.nsfw))) {
          return;
        }
        closeDialog(null);
        await call("set_release_cover", { key, vnId: vn.id, title: vn.title, url: cover.url });
        done("Cover changed");
      };

      return el(
        "div",
        { class: "card release-cell" },
        picture,
        el("b", { class: cover.nsfw ? "chip warn" : "" }, caption),
        el("div", { class: "muted small-text" }, cover.release_title),
        el("div", { class: "row" }, el("button", { class: "btn small", onclick: use }, "Use")),
      );
    }),
  );
  await dialog;
}

function linkIsValid(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

async function previewUrl() {
  const url = part("url").value.trim();
  if (!linkIsValid(url)) {
    part("url-status").textContent = t("Enter a http(s) image link.");
    return;
  }

  part("url-status").textContent = t("Loading preview…");
  try {
    const image = await call("prepare_image", { source: url });
    setCover(part("url-preview"), { path: image.path });
    part("url-status").textContent = "";
  } catch {
    part("url-status").textContent = t("Couldn't load an image from that link.");
  }
}

async function useUrl() {
  const url = part("url").value.trim();
  if (!linkIsValid(url)) {
    toast("Enter a http(s) image link.", { error: true });
    return;
  }
  await call("set_cover_url", { key, url });
  done("Cover changed");
}

register({
  id: "cover",
  nav: "home",
  build,
  show: showPage,
  onKey: (event) => event.key === "Escape" && goBack(),
});
