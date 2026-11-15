import { $, el, html } from "../dom.js";
import { register, show } from "../router.js";
import { store } from "../store.js";
import { ask, call, openDialog, setCover, toast } from "../ui.js";
import { plural, t } from "../i18n.js";

const RELEASE_TYPES = {
  pkgfront: "Front",
  pkgback: "Back",
  pkgside: "Side",
  pkgmed: "Medium",
  dig: "Digital",
};

const TEMPLATE = `
  <button class="back" data-id="back">← Back</button>
  <h2 data-id="title"></h2>

  <div class="card">
    <div class="tabs" data-id="tabs">
      <button data-tab="vndb">Search VNDB</button>
      <button data-tab="url">Image link</button>
      <button data-tab="erogamescape">Search ErogameScape</button>
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

    <div data-tab-body="erogamescape" hidden>
      <div class="row" data-id="erogamescape-current" style="margin: 14px 0"></div>
      <form class="row" data-id="erogamescape-search-form" style="margin: 0 0 6px">
        <input
          type="search"
          class="wide"
          data-id="erogamescape-query"
          placeholder="Game title"
        />
        <button class="btn" data-id="erogamescape-search-button" type="submit">Search</button>
      </form>
      <div class="hint-text" data-id="erogamescape-search-status"></div>
      <div class="vn-results" data-id="erogamescape-results"></div>
    </div>
  </div>
`;

let root;
let key = "";
let backTo = "home";
let searchErogamescapeAfterVn = false;
let gameEntry = {};
let gameName = "";
let erogamescapeSearchVersion = 0;

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));

  part("back").onclick = goBack;
  for (const tab of root.querySelectorAll("[data-tab]")) {
    tab.onclick = () => {
      openTab(tab.dataset.tab);
      if (tab.dataset.tab === "erogamescape") {
        searchErogameScape(true);
      }
    };
  }

  part("search-form").onsubmit = (event) => {
    event.preventDefault();
    search();
  };

  part("erogamescape-search-form").onsubmit = (event) => {
    event.preventDefault();
    searchErogameScape();
  };

  part("url-show").onclick = previewUrl;
  part("url-use").onclick = useUrl;
  part("url").onkeydown = (event) => {
    if (event.key === "Enter") {
      previewUrl();
    }
  };

}

async function showPage({
  key: wanted,
  back = "home",
  tab = "vndb",
  searchErogamescapeAfterVn: searchAfterVn = false,
}) {
  key = wanted;
  backTo = back;
  searchErogamescapeAfterVn = searchAfterVn;

  const game = await call("get_game", { key });
  gameEntry = game.entry;
  gameName = game.name;
  part("title").textContent = t("VN & cover — {name}", { name: game.name });

  const selectedTab = searchAfterVn ? "vndb" : tab;
  openTab(selectedTab);

  part("query").value = game.name;
  part("erogamescape-query").value = game.name;
  part("url").value = "";
  setCover(part("url-preview"));
  part("url-status").textContent = "";
  renderErogameScape(game.entry);
  if (selectedTab === "erogamescape") {
    await searchErogameScape(true);
  } else {
    search();
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

async function done(message) {
  toast(message);
  goBack();
}

async function finishVnSelection(message) {
  if (!searchErogamescapeAfterVn) {
    done(message);
    return;
  }
  toast(message);
  const game = await call("get_game", { key });
  gameEntry = game.entry;
  gameName = game.name;
  part("erogamescape-query").value = game.name;
  renderErogameScape(game.entry);
  openTab("erogamescape");
  await searchErogameScape(true);
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

function renderErogameScape(entry) {
  const box = part("erogamescape-current");
  const id = entry.erogamescape_id;
  if (id === undefined || id === null || id === "") {
    box.replaceChildren(el("span", { class: "muted small-text" }, t("No ErogameScape ID registered.")));
    return;
  }

  box.replaceChildren(
    el(
      "button",
      {
        class: "btn secondary small",
        onclick: () =>
          call("open_url", {
            url: `https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/game.php?game=${id}`,
          }),
      },
      t("ErogameScape ID {id}", { id }),
    ),
    el(
      "button",
      { class: "btn danger small", onclick: removeErogameScape },
      t("Remove ErogameScape ID"),
    ),
  );
}

async function removeErogameScape() {
  const targetKey = key;
  try {
    await call("update_game", {
      key: targetKey,
      fields: { erogamescape_id: null },
    });
    if (targetKey !== key) {
      return;
    }
    delete gameEntry.erogamescape_id;
    renderErogameScape(gameEntry);
    for (const result of part("erogamescape-results").querySelectorAll('[aria-pressed="true"]')) {
      result.classList.remove("btn");
      result.classList.add("btn", "secondary");
      result.setAttribute("aria-pressed", "false");
    }
    toast("ErogameScape ID removed");
  } catch (error) {
    part("erogamescape-search-status").textContent = String(error);
  }
}

async function searchErogameScape(useVndbAltTitle = false) {
  const targetKey = key;
  const searchVersion = ++erogamescapeSearchVersion;
  const queryInput = part("erogamescape-query");
  const status = part("erogamescape-search-status");
  const results = part("erogamescape-results");
  const searchButton = part("erogamescape-search-button");
  searchButton.disabled = true;
  results.replaceChildren();

  try {
    const vnId = gameEntry.vndb_id || gameEntry.matched_vndb_id;
    if (useVndbAltTitle && vnId && queryInput.value.trim() === gameName) {
      status.textContent = t("Loading VNDB alternate title…");
      try {
        const altTitle = await call("vndb_alt_title", { vnId });
        if (targetKey !== key || searchVersion !== erogamescapeSearchVersion) {
          return;
        }
        if (altTitle && queryInput.value.trim() === gameName) {
          queryInput.value = altTitle;
        }
      } catch (error) {
        if (targetKey !== key || searchVersion !== erogamescapeSearchVersion) {
          return;
        }
        status.textContent = String(error);
      }
    }

    const query = queryInput.value.trim();
    if (!query) {
      status.textContent = t("Enter a game title.");
      return;
    }

    status.textContent = t("Searching ErogameScape…");
    const matches = await call("search_erogamescape", { query });
    if (targetKey !== key || searchVersion !== erogamescapeSearchVersion) {
      return;
    }
    if (!matches.length) {
      status.textContent = t("No ErogameScape matches found.");
      return;
    }

    status.textContent = plural(matches.length, "result");
    results.replaceChildren(
      ...matches.map((match) => {
        const isCurrent =
          gameEntry.erogamescape_id !== undefined &&
          gameEntry.erogamescape_id !== null &&
          String(match.id) === String(gameEntry.erogamescape_id);
        return el(
          "div",
          { class: "row", style: { flexWrap: "nowrap" } },
          el(
            "button",
            {
              class: isCurrent ? "btn" : "btn secondary",
              type: "button",
              "aria-pressed": String(isCurrent),
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                gap: "4px",
                textAlign: "left",
                whiteSpace: "normal",
                flex: "1",
                minWidth: "0",
              },
              onclick: async () => {
                if (targetKey !== key || searchVersion !== erogamescapeSearchVersion) {
                  return;
                }
                try {
                  status.textContent = t("Fetching ErogameScape details…");
                  const details = await call("confirm_erogamescape", {
                    key: targetKey,
                    id: Number(match.id),
                  });
                  if (targetKey !== key || searchVersion !== erogamescapeSearchVersion) {
                    return;
                  }
                  Object.assign(gameEntry, details);
                  renderErogameScape(gameEntry);
                  await done("ErogameScape match saved");
                } catch (error) {
                  status.textContent = String(error);
                }
              },
            },
            el(
              "span",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-start",
                  gap: "8px",
                },
              },
              el("span", { style: { minWidth: "0", overflowWrap: "anywhere" } }, match.title),
              match.label &&
                el(
                  "span",
                  {
                    class: "chip quiet",
                    style: { flexShrink: "0", fontSize: "11px", padding: "2px 8px" },
                  },
                  match.label,
                ),
            ),
            el(
              "span",
              {
                style: {
                  fontSize: "12px",
                  fontWeight: "400",
                  opacity: "0.8",
                  overflowWrap: "anywhere",
                },
              },
              [match.brand, match.release_date, `ID ${match.id}`]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
          el(
            "button",
            {
              class: "btn secondary small",
              type: "button",
              onclick: () =>
                call("open_url", {
                  url: `https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/game.php?game=${match.id}`,
                }),
            },
            t("View details"),
          ),
        );
      }),
    );
  } catch (error) {
    if (targetKey === key && searchVersion === erogamescapeSearchVersion) {
      status.textContent = String(error);
    }
  } finally {
    if (searchVersion === erogamescapeSearchVersion) {
      searchButton.disabled = false;
    }
  }
}

function rating(value) {
  return value > 10 ? (value / 10).toFixed(1) : value.toFixed(1);
}

function resultRow(vn) {
  const picture = el("div", { class: "cover tiny" });
  setCover(picture, { url: vn.image_url, nsfw: vn.nsfw, label: vn.title });

  const chips = el(
    "div",
    { class: "chips" },
    el("span", { class: "chip quiet" }, vn.id),
    vn.rating > 0 && el("span", { class: "chip quiet" }, `★ ${rating(vn.rating)}`),
    vn.nsfw && el("span", { class: "chip warn" }, "NSFW cover"),
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
    el("button", { class: "btn small", onclick: () => useVn(vn) }, "Use"),
  );

  return el("div", { class: "card vn-result" }, picture, info, buttons);
}

async function useVn(vn) {
  if (!(await okToUseNsfw(vn.nsfw))) {
    return;
  }
  await call("set_game_vn", { key, vnId: vn.id, title: vn.title, aliases: vn.aliases || [] });
  await finishVnSelection(t("Now using {title}", { title: vn.title }));
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
        await call("set_release_cover", {
          key,
          vnId: vn.id,
          title: vn.title,
          aliases: vn.aliases || [],
          url: cover.url,
        });
        await finishVnSelection("Cover changed");
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
