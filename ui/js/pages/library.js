import { $, el, html } from "../dom.js";
import {
  addDays,
  capitalize,
  formatPlaytime,
  isoDay,
  lastPlayed,
  midnight,
  parseDay,
  plural,
} from "../format.js";
import { register, show } from "../router.js";
import { store, subscribe } from "../store.js";
import { call, confirmButton, segmented, setCover, toast, toggle } from "../ui.js";
import { playGame } from "../components/play.js";
import { drawHeatmap } from "../components/heatmap.js";
import { t } from "../i18n.js";

const TEMPLATE = `
  <div class="page-head lib-head">
    <div class="lib-title">
      <h2>Library</h2>
      <div data-id="brand-toggle"></div>
    </div>
    <div class="row">
      <div class="view-menu" data-id="view-menu">
        <button class="btn secondary" data-id="view-button" aria-haspopup="menu">
          <span data-id="view-label"></span> ▾
        </button>
        <div class="menu" data-id="view-list" role="menu" hidden>
          <button data-v="list" role="menuitemradio">List</button>
          <button data-v="grid" role="menuitemradio">Grid</button>
          <button data-v="compact" role="menuitemradio">Compact</button>
          <button data-v="shelves" role="menuitemradio">Shelves</button>
          <button data-v="years" role="menuitemradio">Shelves by year</button>
        </div>
      </div>
      <div class="lib-filter" data-id="filter-container">
        <div class="lib-filter-control">
          <div class="lib-filter-chips" data-id="filter-chips"></div>
          <input
            type="search"
            data-id="filter"
            placeholder="Filter…"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
          />
        </div>
        <div class="lib-filter-suggestions" data-id="filter-suggestions" role="listbox" hidden></div>
      </div>
    </div>
  </div>

  <div class="page-head lib-tools brand-tools" data-id="brand-tools" hidden>
    <div class="seg sort-bar">
      <span class="sort-label">Sort brands</span>
      <div class="sort-options" data-id="brand-sort">
        <button data-v="most">Most read</button>
        <button data-v="recent">Recent</button>
        <button data-v="az">A–Z</button>
        <button data-v="furigana">Furigana</button>
        <button data-v="release">Release date</button>
      </div>
      <span class="sort-sep"></span>
      <button class="sort-dir" data-id="brand-reverse" title="Reverse order"></button>
    </div>
  </div>

  <div class="page-head lib-tools">
    <div class="seg sort-bar">
      <div class="sort-options" data-id="sort">
        <button data-v="most">Most read</button>
        <button data-v="recent">Recent</button>
        <button data-v="az">A–Z</button>
        <button data-v="furigana">Furigana</button>
        <button data-v="release">Release date</button>
      </div>
      <span class="sort-sep"></span>
      <button class="sort-dir" data-id="reverse" title="Reverse order"></button>
    </div>
    <div class="row">
      <button class="btn secondary" data-id="wishlist">My VNDB lists</button>
      <select data-id="status">
        <option value="">All statuses</option>
        <option value="playing">Reading</option>
        <option value="finished">Finished</option>
        <option value="stalled">Stalled</option>
        <option value="dropped">Dropped</option>
      </select>
    </div>
  </div>

  <div class="muted" data-id="summary"></div>

  <div class="card" data-id="activity" hidden>
    <div class="card-title">
      <b>Reading days</b>
      <span class="muted small-text" data-id="streaks"></span>
    </div>
    <div data-id="heatmap"></div>
  </div>

  <div class="lib-list" data-id="list"></div>
`;

const SORTERS = {
  most: (a, b) => b.playtime - a.playtime,
  recent: (a, b) => b.last_played - a.last_played,
  az: (a, b) => a.name.localeCompare(b.name),
  furigana: (a, b) =>
    (a.furigana || a.name).localeCompare(b.furigana || b.name, "ja") ||
    a.name.localeCompare(b.name, "ja"),
  release: (a, b) => b.released.localeCompare(a.released),
};

const yearOf = (game) => (/^\d{4}/.test(game.released) ? game.released.slice(0, 4) : "");
const UNKNOWN_BRAND_ID = "unknown";

const SHELVES = [
  ["playing", "Reading"],
  ["finished", "Finished"],
  ["stalled", "Stalled"],
  ["dropped", "Dropped"],
  ["", "No status"],
];

const VIEWS = {
  list: (shown, most) => shown.map((game) => row(game, most)),
  grid: (shown) => shown.map(tile),
  compact: (shown) => [compactHead(), ...shown.map(line)],
  shelves: (shown) => shelves(shown),
  years: (shown) => yearShelves(shown),
};

let root;
let games = [];
let brandById = new Map();
let selectedBrandId = null;
let brandsAsked = false;
let datesAsked = false;
let selectedFilterBrandIds = [];
let selectedFilterYears = [];
let activeFilterTokenIndex = -1;
let brandSuggestionsOpen = false;
let brandSuggestionIndex = -1;

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));
  part("sort").querySelector('[data-v="furigana"]').textContent = t("Furigana");
  part("brand-sort").querySelector('[data-v="furigana"]').textContent = t("Furigana");

  part("filter").oninput = () => {
    brandSuggestionsOpen = true;
    activeFilterTokenIndex = -1;
    brandSuggestionIndex = -1;
    render();
  };
  part("filter").onfocus = () => {
    brandSuggestionsOpen = true;
    brandSuggestionIndex = -1;
    renderFilterControls();
  };
  part("filter").onkeydown = (event) => {
    const input = part("filter");
    const candidates = brandSuggestionsOpen ? filterCandidates(input.value) : [];
    const hasExplicitFilterPrefix = /(?:^|\s)(?:brand|year):/i.test(input.value.trim());
    if (event.key === "ArrowDown" && candidates.length) {
      event.preventDefault();
      brandSuggestionIndex =
        brandSuggestionIndex < 0 ? 0 : (brandSuggestionIndex + 1) % candidates.length;
      renderFilterControls();
    } else if (event.key === "ArrowUp" && candidates.length) {
      event.preventDefault();
      brandSuggestionIndex =
        brandSuggestionIndex < 0
          ? candidates.length - 1
          : (brandSuggestionIndex - 1 + candidates.length) % candidates.length;
      renderFilterControls();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const current =
        activeFilterTokenIndex >= 0
          ? part("filter-chips").querySelectorAll("[data-filter-token-index]")[
              activeFilterTokenIndex
            ]
          : input;
      if (current && focusFilterVertically(current, event.key === "ArrowUp" ? -1 : 1)) {
        event.preventDefault();
      }
    } else if (
      event.key === "Enter" &&
      candidates.length &&
      (brandSuggestionIndex >= 0 || (candidates.length === 1 && hasExplicitFilterPrefix))
    ) {
      event.preventDefault();
      selectFilterCandidate(candidates[brandSuggestionIndex >= 0 ? brandSuggestionIndex : 0]);
    } else if (event.key === "Enter" && brandSuggestionsOpen) {
      brandSuggestionsOpen = false;
      renderFilterControls();
    } else if (event.key === "Escape" && brandSuggestionsOpen) {
      event.preventDefault();
      if (brandSuggestionIndex >= 0) {
        brandSuggestionIndex = -1;
      } else {
        brandSuggestionsOpen = false;
      }
      renderFilterControls();
    } else if (event.key === "ArrowRight" && activeFilterTokenIndex >= 0) {
      event.preventDefault();
      if (activeFilterTokenIndex + 1 < selectedFilterTokens().length) {
        focusFilterToken(activeFilterTokenIndex + 1);
      } else {
        focusFilterInputAtStart();
      }
    } else if (
      event.key === "ArrowLeft" &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      selectedFilterTokens().length
    ) {
      event.preventDefault();
      focusFilterToken(
        activeFilterTokenIndex >= 0
          ? Math.max(0, activeFilterTokenIndex - 1)
          : selectedFilterTokens().length - 1,
      );
    } else if (
      (event.key === "Backspace" || event.key === "Delete") &&
      activeFilterTokenIndex >= 0
    ) {
      event.preventDefault();
      removeFilterTokenAt(activeFilterTokenIndex);
    } else if (event.key === "Backspace" && !input.value && selectedFilterTokens().length) {
      event.preventDefault();
      removeFilterTokenAt(selectedFilterTokens().length - 1);
    } else if (
      event.key === "Backspace" &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      selectedFilterTokens().length
    ) {
      event.preventDefault();
      focusFilterToken(selectedFilterTokens().length - 1);
    }
  };
  part("status").onchange = render;
  part("wishlist").onclick = () => show("vndb-lists");
  part("reverse").onclick = () => {
    store.settings.library_sort_reverse = !store.settings.library_sort_reverse;
    render();
    call("update_settings", { changes: { library_sort_reverse: store.settings.library_sort_reverse } });
  };
  part("brand-reverse").onclick = () => {
    store.settings.library_brand_sort_reverse = !store.settings.library_brand_sort_reverse;
    render();
    call("update_settings", {
      changes: { library_brand_sort_reverse: store.settings.library_brand_sort_reverse },
    });
  };

  part("view-button").onclick = () => (part("view-list").hidden = !part("view-list").hidden);
  for (const item of part("view-list").children) {
    item.onclick = () => {
      part("view-list").hidden = true;
      const changes = { library_view: item.dataset.v };
      if (store.settings.library_view === "brands") {
        changes.library_group_by_brand = true;
        store.settings.library_group_by_brand = true;
      }
      store.settings.library_view = item.dataset.v;
      render();
      call("update_settings", { changes });
    };
  }
  document.addEventListener("click", (event) => {
    if (!part("view-menu").contains(event.target)) {
      part("view-list").hidden = true;
    }
    if (!part("filter-container").contains(event.target) && brandSuggestionsOpen) {
      brandSuggestionsOpen = false;
      renderFilterControls();
    }
  });

  subscribe("library", () => root.classList.contains("active") && load());
  subscribe("settings", () => root.classList.contains("active") && load());

  let shownKey = playingKey();
  subscribe("snapshot", () => {
    if (playingKey() !== shownKey) {
      shownKey = playingKey();
      if (root.classList.contains("active") && games.length) {
        render();
      }
    }
  });
}

async function load() {
  games = await call("get_library");
  brandsAsked = false;
  render();
  renderActivity();
  requestBrandDetails();
}

function requestBrandDetails() {
  if (brandsAsked) {
    return;
  }
  brandsAsked = true;
  if (!games.some((game) => game.brand_id && !brandById.has(String(game.brand_id)))) {
    return;
  }
  call("get_library_brands")
    .then((loaded) => {
      brandById = new Map(loaded.map((brand) => [String(brand.id), brand]));
      render();
    })
    .catch(() => render());
}

function gameBrandName(game) {
  if (!game.brand_id) {
    return t("Unknown brand");
  }
  return (
    brandById.get(String(game.brand_id))?.name ||
    t("Brand {id}", { id: game.brand_id })
  );
}

function matchesFilter(game, terms) {
  const gameBrandId = game.brand_id ? String(game.brand_id) : UNKNOWN_BRAND_ID;
  if (selectedFilterBrandIds.length && !selectedFilterBrandIds.includes(gameBrandId)) {
    return false;
  }
  if (selectedFilterYears.length && !selectedFilterYears.includes(yearOf(game))) {
    return false;
  }
  if (!terms.length) {
    return true;
  }
  const brand = game.brand_id ? brandById.get(String(game.brand_id)) : null;
  const brandNames = game.brand_id
    ? [brand?.name, brand?.furigana, ...(brand?.search_names || [])]
    : [t("Unknown brand")];
  const names = [game.name, ...(game.search_names || []), ...brandNames].map((name) =>
    String(name || "").toLowerCase(),
  );
  return terms.every((term) => names.some((name) => name.includes(term)));
}

function filterBrandCandidates(query) {
  const brands = [...brandById.values()];
  if (games.some((game) => !game.brand_id)) {
    brands.push({ id: UNKNOWN_BRAND_ID, name: t("Unknown brand"), search_names: [] });
  }
  return brands
    .filter((brand) => String(brand.name || "").trim())
    .filter((brand) => !selectedFilterBrandIds.includes(String(brand.id)))
    .filter((brand) =>
      [brand.name, brand.furigana, ...(brand.search_names || [])].some((name) =>
        String(name || "")
          .toLowerCase()
          .includes(query),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ja"))
    .slice(0, 8);
}

function filterYearCandidates(query) {
  return [...new Set(games.map(yearOf).filter(Boolean))]
    .filter((year) => year === query && !selectedFilterYears.includes(year))
    .sort((a, b) => b.localeCompare(a))
    .map((year) => ({ type: "year", year }));
}

function filterCandidates(value) {
  const query = value.trim();
  const prefixCandidates = filterPrefixCandidates(query);
  if (prefixCandidates) {
    return prefixCandidates;
  }
  if (/(?:^|\s)brand:/i.test(query)) {
    return filterBrandCandidates(brandSuggestionQuery(query)).map((brand) => ({
      type: "brand",
      brand,
    }));
  }
  const year = yearSuggestionQuery(query);
  if (year) {
    return filterYearCandidates(year);
  }
  return filterBrandCandidates(brandSuggestionQuery(query)).map((brand) => ({
    type: "brand",
    brand,
  }));
}

function filterPrefixCandidates(query) {
  const normalized = query.toLowerCase();
  if (normalized === "brand:" || normalized === "year:") {
    return null;
  }
  const prefixes = ["brand:", "year:"].filter((prefix) => prefix.startsWith(normalized));
  return prefixes.length ? prefixes.map((prefix) => ({ type: "prefix", prefix })) : null;
}

function filterBrandName(id) {
  if (id === UNKNOWN_BRAND_ID) {
    return t("Unknown brand");
  }
  return brandById.get(id)?.name || t("Brand {id}", { id });
}

function brandSuggestionQuery(value) {
  const query = value.trim();
  const explicitBrandQuery = /(?:^|\s)brand:\s*(.*)$/i.exec(query);
  return (explicitBrandQuery ? explicitBrandQuery[1] : query).trim().toLowerCase();
}

function yearSuggestionQuery(value) {
  return /(?:^|\s)(?:year:\s*)?(\d{4})$/i.exec(value.trim())?.[1] || null;
}

function filterTextAfterCandidateSelection(value, candidate) {
  const prefix =
    candidate.type === "brand"
      ? /(?:^|\s)brand:\s*/i.exec(value)
      : /(?:^|\s)(?:year:\s*)?\d{4}$/i.exec(value);
  return prefix ? value.slice(0, prefix.index).trim() : "";
}

function selectedFilterTokens() {
  return [
    ...selectedFilterBrandIds.map((id) => ({ type: "brand", id })),
    ...selectedFilterYears.map((year) => ({ type: "year", year })),
  ];
}

function focusFilterInputAtStart() {
  activeFilterTokenIndex = -1;
  renderFilterControls();
  const input = part("filter");
  input.focus();
  input.setSelectionRange(0, 0);
}

function focusFilterToken(index) {
  if (index < 0 || index >= selectedFilterTokens().length) {
    return false;
  }
  activeFilterTokenIndex = index;
  part("filter").focus();
  renderFilterControls();
  return true;
}

function focusFilterVertically(current, direction) {
  const chips = [...part("filter-chips").querySelectorAll("[data-filter-token-index]")];
  const input = part("filter");
  const currentRect = current.getBoundingClientRect();
  const currentTop = currentRect.top;
  const currentCenter = currentRect.left + currentRect.width / 2;
  const isInDirection = (rect) =>
    direction < 0 ? rect.top < currentTop - 6 : rect.top > currentTop + 6;
  const chipCandidates = chips
    .filter((element) => element !== current)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => isInDirection(rect));
  const inputRect = input.getBoundingClientRect();
  const candidates =
    chipCandidates.length || current === input
      ? chipCandidates
      : direction > 0 || isInDirection(inputRect)
        ? [{ element: input, rect: inputRect }]
        : [];
  if (!candidates.length) {
    return false;
  }

  const nextRow =
    direction < 0
      ? Math.max(...candidates.map(({ rect }) => rect.top))
      : Math.min(...candidates.map(({ rect }) => rect.top));
  const target = candidates
    .filter(({ rect }) => Math.abs(rect.top - nextRow) <= 2)
    .sort(
      (a, b) =>
        Math.abs(a.rect.left + a.rect.width / 2 - currentCenter) -
        Math.abs(b.rect.left + b.rect.width / 2 - currentCenter),
    )[0]?.element;
  if (!target) {
    return false;
  }
  if (target === input) {
    focusFilterInputAtStart();
  } else {
    focusFilterToken(Number(target.dataset.filterTokenIndex));
  }
  return true;
}

function removeFilterTokenAt(index) {
  const token = selectedFilterTokens()[index];
  if (!token) {
    return;
  }
  if (token.type === "brand") {
    selectedFilterBrandIds = selectedFilterBrandIds.filter((id) => id !== token.id);
  } else {
    selectedFilterYears = selectedFilterYears.filter((year) => year !== token.year);
  }
  activeFilterTokenIndex =
    selectedFilterTokens().length > 0 ? Math.min(index, selectedFilterTokens().length - 1) : -1;
  brandSuggestionsOpen = true;
  brandSuggestionIndex = -1;
  render();
  part("filter").focus();
}

function renderFilterControls() {
  const input = part("filter");
  const suggestions = part("filter-suggestions");
  const tokens = selectedFilterTokens();
  part("filter-chips").replaceChildren(
    ...tokens.map((token, index) =>
      el(
        "span",
        {
          class: `chip lib-filter-chip ${index === activeFilterTokenIndex ? "selected" : ""}`,
          "data-filter-token-index": String(index),
        },
        el(
          "span",
          { class: "lib-filter-chip-label" },
          token.type === "brand" ? `brand:${filterBrandName(token.id)}` : `year:${token.year}`,
        ),
        el(
          "button",
          {
            type: "button",
            title: "Remove",
            "aria-label": "Remove",
            tabindex: "-1",
            onclick: (event) => {
              event.stopPropagation();
              removeFilterTokenAt(index);
            },
          },
          "×",
        ),
      ),
    ),
  );

  const candidates = brandSuggestionsOpen ? filterCandidates(input.value) : [];
  brandSuggestionIndex = Math.min(brandSuggestionIndex, Math.max(0, candidates.length - 1));
  input.setAttribute("aria-expanded", String(candidates.length > 0));
  suggestions.hidden = candidates.length === 0;
  suggestions.replaceChildren(
    ...candidates.map((candidate, index) => {
      const label =
        candidate.type === "brand"
          ? `brand:${candidate.brand.name}`
          : candidate.type === "year"
            ? `year:${candidate.year}`
            : candidate.prefix;
      return el(
        "button",
        {
          type: "button",
          class: `chip lib-filter-chip lib-filter-suggestion ${index === brandSuggestionIndex ? "on" : ""}`,
          role: "option",
          "aria-selected": String(index === brandSuggestionIndex),
          onclick: (event) => {
            event.preventDefault();
            selectFilterCandidate(candidate);
          },
        },
        el("span", { class: "lib-filter-chip-label" }, label),
      );
    }),
  );
}

function selectFilterCandidate(candidate) {
  const input = part("filter");
  if (candidate.type === "prefix") {
    input.value = candidate.prefix;
    brandSuggestionsOpen = true;
  } else if (candidate.type === "brand") {
    const id = String(candidate.brand.id);
    if (!selectedFilterBrandIds.includes(id)) {
      selectedFilterBrandIds.push(id);
    }
    input.value = filterTextAfterCandidateSelection(input.value, candidate);
    brandSuggestionsOpen = true;
  } else {
    if (!selectedFilterYears.includes(candidate.year)) {
      selectedFilterYears.push(candidate.year);
    }
    input.value = filterTextAfterCandidateSelection(input.value, candidate);
    brandSuggestionsOpen = true;
  }
  activeFilterTokenIndex = -1;
  brandSuggestionIndex = -1;
  render();
  part("filter").focus();
  if (candidate.type === "prefix") {
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function brandView(shown, most, view, brandSort, brandReverse) {
  const brandFor = (id) => {
    if (id === UNKNOWN_BRAND_ID) {
      return { id: UNKNOWN_BRAND_ID, name: t("Unknown brand"), furigana: "" };
    }
    const found = brandById.get(String(id));
    return found?.name
      ? found
      : {
          id: Number(id),
          name: t("Brand {id}", { id }),
          furigana: found?.furigana || "",
        };
  };

  requestBrandDetails();

  if (selectedBrandId !== null) {
    const brand = brandFor(selectedBrandId);
    const brandGames = shown.filter((game) =>
      selectedBrandId === UNKNOWN_BRAND_ID
        ? !game.brand_id
        : String(game.brand_id) === selectedBrandId,
    );
    return [
      el(
        "div",
        { class: "brand-detail-head" },
        el(
          "button",
          {
            class: "btn secondary",
            onclick: () => {
              selectedBrandId = null;
              render();
            },
          },
          t("All brands"),
        ),
        el(
          "div",
          {},
          el("b", {}, brand.name),
        ),
      ),
      ...(brandGames.length
        ? VIEWS[view](brandGames, most)
        : [el("div", { class: "card lib-empty" }, t("Nothing matches."))]),
    ];
  }

  const groups = new Map();
  for (const game of shown) {
    const id = game.brand_id ? String(game.brand_id) : UNKNOWN_BRAND_ID;
    const group = groups.get(id) || {
      count: 0,
      playtime: 0,
      last_played: 0,
      released: "",
      games: [],
    };
    group.count++;
    group.playtime += game.playtime;
    group.last_played = Math.max(group.last_played, game.last_played);
    if (group.games.length < 3) {
      group.games.push(game);
    }
    if (yearOf(game) && game.released > group.released) {
      group.released = game.released;
    }
    groups.set(id, group);
  }

  const brandSorters = {
    most: (a, b) => b.playtime - a.playtime,
    recent: (a, b) => b.last_played - a.last_played,
    az: (a, b) => a.brand.name.localeCompare(b.brand.name),
    furigana: (a, b) =>
      (a.brand.furigana || a.brand.name).localeCompare(
        b.brand.furigana || b.brand.name,
        "ja",
      ) || a.brand.name.localeCompare(b.brand.name, "ja"),
    release: (a, b) => b.released.localeCompare(a.released),
  };
  const entries = [...groups.entries()].map(([id, stats]) => ({ brand: brandFor(id), ...stats }));
  const unknown = entries.find(({ brand }) => brand.id === UNKNOWN_BRAND_ID);
  const ordered = entries
    .filter(({ brand }) => brand.id !== UNKNOWN_BRAND_ID)
    .sort(brandSorters[brandSort]);
  if (brandReverse) {
    ordered.reverse();
  }
  if (brandSort === "release") {
    ordered.sort((a, b) => Number(!a.released) - Number(!b.released));
  }
  if (unknown) {
    ordered.push(unknown);
  }
  if (!ordered.length) {
    return [el("div", { class: "card lib-empty" }, t("No ErogameScape brands are linked to these games."))];
  }

  return ordered.map(({ brand, count, games: samples }) =>
    el(
      "button",
      {
        class: "card brand-group",
        type: "button",
        onclick: () => {
          selectedBrandId = String(brand.id);
          render();
        },
      },
      el("b", {}, brand.name),
      el(
        "div",
        { class: "brand-thumbnails" },
        ...samples.map((game) => {
          const cover = coverOf(game, "brand-thumb-cover");
          cover.title = game.name;
          return cover;
        }),
      ),
      el("span", { class: "muted small-text" }, plural(count, "game")),
    ),
  );
}

function readingDays() {
  const days = {};
  for (const game of games) {
    for (const [day, seconds] of Object.entries(game.daily || {})) {
      if (seconds > 0) {
        days[day] ??= { seconds: 0, names: [] };
        days[day].seconds += seconds;
        days[day].names.push(game.name);
      }
    }
  }
  return days;
}

function milestones() {
  const marks = {};
  const add = (day, kind, name) => {
    marks[day] ??= { started: [], finished: [] };
    marks[day][kind].push(name);
  };
  for (const game of games) {
    const read = Object.entries(game.daily || {}).filter(([, seconds]) => seconds > 0).map(([day]) => day);
    if (read.length) {
      add(read.sort()[0], "started", game.name);
    }
    if (game.status === "finished" && game.finished_at > 0) {
      add(isoDay(new Date(game.finished_at * 1000)), "finished", game.name);
    }
  }
  return marks;
}

function streaks(days) {
  const today = midnight(new Date());
  let day = days[isoDay(today)] ? today : addDays(today, -1);
  let current = 0;
  while (days[isoDay(day)]) {
    current++;
    day = addDays(day, -1);
  }

  let longest = 0;
  let run = 0;
  let previous = "";
  for (const text of Object.keys(days).sort()) {
    run = previous && isoDay(addDays(parseDay(previous), 1)) === text ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = text;
  }
  return { current, longest };
}

function renderActivity() {
  const days = readingDays();
  const yearAgo = isoDay(addDays(new Date(), -365));
  const lastYear = Object.keys(days).filter((day) => day > yearAgo).length;

  part("activity").hidden = !lastYear;
  if (!lastYear) {
    return;
  }

  const { current, longest } = streaks(days);
  part("streaks").textContent = [
    t("{days} in the last year", { days: plural(lastYear, "day") }),
    current && t("streak: {days}", { days: plural(current, "day") }),
    t("best: {days}", { days: plural(longest, "day") }),
  ]
    .filter(Boolean)
    .join("  ·  ");
  drawHeatmap(part("heatmap"), days, milestones());
}

function weekSeconds(daily) {
  const today = midnight(new Date());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  let total = 0;
  for (let day = monday; day <= today; day = addDays(day, 1)) {
    total += daily[isoDay(day)] || 0;
  }
  return total;
}

function render() {
  renderFilterControls();
  const sort = SORTERS[store.settings.library_sort] ? store.settings.library_sort : "most";
  segmented(part("sort"), sort, (value) => {
    store.settings.library_sort = value;
    render();
    call("update_settings", { changes: { library_sort: value } });
  });
  const legacyBrandView = store.settings.library_view === "brands";
  const view = VIEWS[store.settings.library_view] ? store.settings.library_view : "list";
  const groupByBrand = store.settings.library_group_by_brand === true || legacyBrandView;
  const showingBrandGames = groupByBrand && selectedBrandId !== null;
  const brandSort = SORTERS[store.settings.library_brand_sort]
    ? store.settings.library_brand_sort
    : "most";
  segmented(part("brand-sort"), brandSort, (value) => {
    store.settings.library_brand_sort = value;
    render();
    call("update_settings", { changes: { library_brand_sort: value } });
  });
  const brandReverse = !!store.settings.library_brand_sort_reverse;
  part("brand-reverse").textContent = brandReverse ? "↑" : "↓";
  part("brand-tools").hidden = !groupByBrand || selectedBrandId !== null;
  if (!datesAsked && groupByBrand && brandSort === "release" && games.some((game) => game.vndb_id && !game.released)) {
    datesAsked = true;
    call("fill_release_dates").catch(() => {});
  }
  const brandToggle = toggle(t("Group by brand"), groupByBrand, (enabled) => {
    const changes = { library_group_by_brand: enabled };
    store.settings.library_group_by_brand = enabled;
    selectedBrandId = null;
    if (legacyBrandView) {
      changes.library_view = view;
      store.settings.library_view = view;
    }
    render();
    call("update_settings", { changes });
  });
  brandToggle.classList.add("lib-brand-toggle");
  brandToggle.querySelector("input").setAttribute("aria-label", t("Group by brand"));
  part("brand-toggle").replaceChildren(brandToggle);
  for (const item of part("view-list").children) {
    item.classList.toggle("on", item.dataset.v === view);
    if (item.dataset.v === view) {
      part("view-label").textContent = item.textContent;
    }
  }

  const reverse = !!store.settings.library_sort_reverse;
  part("reverse").textContent = reverse ? "↑" : "↓";
  if (!datesAsked && (sort === "release" || view === "years") && games.some((game) => game.vndb_id && !game.released)) {
    datesAsked = true;
    call("fill_release_dates").catch(() => {});
  }

  const filterTerms = part("filter").value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const status = part("status").value;
  const shown = games
    .filter((game) => matchesFilter(game, filterTerms))
    .filter((game) => !status || game.status === status)
    .sort(SORTERS[sort]);
  if (reverse) {
    shown.reverse();
  }
  if (sort === "release") {
    shown.sort((a, b) => !yearOf(a) - !yearOf(b));
  }

  const total = games.reduce((sum, game) => sum + game.playtime, 0);
  const week = games.reduce((sum, game) => sum + weekSeconds(game.daily), 0);
  part("summary").textContent = [
    plural(games.length, "game"),
    t("{time} read in total", { time: formatPlaytime(total) }),
    t("{time} this week", { time: formatPlaytime(week) }),
  ].join("  ·  ");

  if (!shown.length && !showingBrandGames) {
    const message = games.length ? "Nothing matches." : "The VNs you read will show up here.";
    part("list").className = "lib-list";
    part("list").replaceChildren(el("div", { class: "card lib-empty" }, message));
    return;
  }

  const most = Math.max(1, ...games.map((game) => game.playtime));
  part("list").className = `lib-list view-${showingBrandGames ? view : groupByBrand ? "brands" : view}`;
  part("list").replaceChildren(
    ...(groupByBrand
      ? brandView(shown, most, view, brandSort, brandReverse)
      : VIEWS[view](shown, most)),
  );
}

function opener(game) {
  const open = () => show("game", { key: game.key });
  return {
    role: "button",
    tabindex: "0",
    onclick: open,
    onkeydown: (event) => event.key === "Enter" && open(),
  };
}

function coverOf(game, size = "") {
  const cover = el("div", { class: `cover ${size}` });
  setCover(cover, { path: game.cover, nsfw: game.nsfw, label: game.name });
  return cover;
}

const playingKey = () => (store.snapshot?.detected ? store.snapshot.key : "");
const isPlaying = (game) => !!game.key && game.key === playingKey();

function nowBadge(game) {
  return isPlaying(game) && el("span", { class: "now-badge" }, t("Now reading"));
}

function readText(game) {
  return game.from_vndb && !game.playtime
    ? t("From your VNDB list")
    : t("{time} read", { time: formatPlaytime(game.playtime) });
}

function statusChip(game) {
  if (!game.status) {
    return null;
  }
  const label = SHELVES.find(([status]) => status === game.status)?.[1] || capitalize(game.status);
  return el("span", { class: `status ${game.status}` }, label);
}

function playButton(game, label = "▶  Play", kind = "") {
  const play = el("button", { class: `btn small ${kind}`, title: "Play" }, label);
  play.onclick = (event) => {
    event.stopPropagation();
    playGame(game.key);
  };
  play.hidden = !game.has_path;
  return play;
}

function row(game, most) {
  const meta = el(
    "div",
    { class: "meta" },
    nowBadge(game),
    statusChip(game),
    el("span", { class: "brand-name" }, gameBrandName(game)),
    el("span", {}, readText(game)),
    game.last_played > 0 && el("span", {}, `·  ${lastPlayed(game.last_played)}`),
    game.vndb_id && el("span", {}, `·  ${game.vndb_id}`),
  );

  const bar = el(
    "div",
    { class: "bar" },
    el("i", { style: { width: `${(game.playtime / most) * 100}%` } }),
  );

  const remove = el("button", { class: "btn danger small" });
  confirmButton(remove, "Remove", async () => {
    await call("remove_game", { key: game.key });
    toast(t("{name} was removed (its screenshots are kept)", { name: game.name }));
  });

  return el(
    "div",
    { class: `card lib-row${isPlaying(game) ? " now-playing" : ""}`, ...opener(game) },
    coverOf(game, "small"),
    el("div", { class: "info" }, el("div", { class: "name" }, game.name), meta, bar),
    el("div", { class: "actions" }, playButton(game), remove),
  );
}

function tile(game) {
  return el(
    "div",
    { class: `lib-tile${isPlaying(game) ? " now-playing" : ""}`, ...opener(game) },
    el("div", { class: "tile-cover" }, coverOf(game), statusChip(game), nowBadge(game), playButton(game, "▶")),
    el("div", { class: "name" }, game.name),
    el("div", { class: "muted small-text brand-name" }, gameBrandName(game)),
    el("div", { class: "muted small-text" }, readText(game)),
  );
}

function compactHead() {
  return el(
    "div",
    { class: "lib-line head" },
    el("span"),
    el("span", {}, "Title"),
    el("span", {}, "Status"),
    el("span", {}, "Read"),
    el("span", {}, "Last played"),
    el("span"),
  );
}

function line(game) {
  return el(
    "div",
    { class: `lib-line${isPlaying(game) ? " now-playing" : ""}`, ...opener(game) },
    coverOf(game),
    el(
      "div",
      { class: "line-title" },
      el("div", { class: "name" }, game.name, nowBadge(game)),
      el("span", { class: "muted small-text brand-name" }, gameBrandName(game)),
    ),
    el("span", {}, statusChip(game) || ""),
    el(
      "span",
      { class: "muted" },
      game.from_vndb && !game.playtime ? "—" : formatPlaytime(game.playtime),
    ),
    el("span", { class: "muted" }, game.last_played > 0 ? lastPlayed(game.last_played) : "—"),
    el("span", {}, playButton(game, "▶", "secondary")),
  );
}

function shelves(shown) {
  return SHELVES.map(([status, title]) => {
    const group = shown.filter((game) => (game.status || "") === status);
    return group.length ? shelf(title, group) : null;
  }).filter(Boolean);
}

function shelf(title, group) {
  return el(
    "div",
    { class: "shelf" },
    el("div", { class: "shelf-title" }, el("b", {}, title), el("span", { class: "muted" }, String(group.length))),
    el("div", { class: "shelf-row" }, group.map(tile)),
  );
}

function yearShelves(shown) {
  const years = [...new Set(shown.map(yearOf).filter(Boolean))].sort().reverse();
  if (store.settings.library_sort_reverse) {
    years.reverse();
  }
  return [...years, ""]
    .map((year) => {
      const group = shown.filter((game) => yearOf(game) === year);
      return group.length ? shelf(year || t("Unknown year"), group) : null;
    })
    .filter(Boolean);
}

register({
  id: "library",
  build,
  show: (params) => {
    if (params.filterBrandId !== undefined && params.filterBrandId !== null) {
      selectedBrandId = null;
      selectedFilterBrandIds = [String(params.filterBrandId)];
      selectedFilterYears = [];
      activeFilterTokenIndex = -1;
      brandSuggestionsOpen = false;
      brandSuggestionIndex = -1;
      part("filter").value = "";
    } else if (params.brandId !== undefined && params.brandId !== null) {
      selectedBrandId = String(params.brandId);
      if (store.settings.library_group_by_brand !== true) {
        store.settings.library_group_by_brand = true;
        call("update_settings", { changes: { library_group_by_brand: true } }).catch(() => {});
      }
    } else if (params.resetBrandSelection) {
      selectedBrandId = null;
    }
    return load();
  },
  onKey: (event) => event.key === "Escape" && (part("view-list").hidden = true),
});
