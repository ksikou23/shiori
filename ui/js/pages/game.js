import { $, el, html } from "../dom.js";
import {
  addDays,
  formatPlaytime,
  isoDay,
  lastPlayed,
  lengthText,
  midnight,
  parseDay,
  readingProgress,
  shortDate,
  weekday,
} from "../format.js";
import { invoke, fileUrl, listen } from "../tauri.js";
import { register, show } from "../router.js";
import { store, subscribe, update } from "../store.js";
import { ask, call, openDialog, segmented, setCover, toast, toggle } from "../ui.js";
import { drawChart } from "../components/chart.js";
import {
  SOURCES,
  choiceCount,
  findWalkthrough,
  nextChoice,
  raw,
  say,
  secret,
  stepRow,
} from "../components/walkthrough.js";
import { LAUNCHERS, createShortcut, locateGame, locateTool, playGame } from "../components/play.js";
import { t } from "../i18n.js";

const PRIVACY_HELP = {
  full: "Discord shows the name, the current section and the cover.",
  partial: "Discord shows the name and cover, but not where you are in the story.",
  private: "Discord only shows a generic “Visual Novel” — no name, no cover.",
  off: "Nothing is shared on Discord while this game is open.",
};

const TEMPLATE = `
  <button class="back" data-id="back">← Library</button>

  <div class="banner info dupe" data-id="dupe" hidden>
    <i></i><span data-id="dupe-text"></span>
    <button class="btn small" data-id="dupe-merge">Merge them</button>
  </div>

  <div class="game-grid">
    <div class="card game-head">
      <div class="cover mid" data-id="cover"></div>
      <div class="details">
        <h2 data-id="name"></h2>
        <button class="path" data-id="path" title="Show in folder"></button>
        <div class="row" data-id="vndb"></div>
        <button class="link" data-id="change-cover">Change VN / cover…</button>
      </div>
    </div>

    <div class="col">
      <div class="stats">
        <div class="stat">
          <span>Total read</span><b data-id="total"></b>
          <button class="stat-edit" data-id="edit-total" title="Edit total read">✎</button>
        </div>
        <div class="stat"><span>This week</span><b data-id="week"></b></div>
        <div class="stat"><span>Sessions</span><b data-id="sessions"></b></div>
        <div class="stat"><span>Last played</span><b data-id="last"></b></div>
      </div>

      <div class="card" data-id="progress" hidden>
        <div class="card-title">
          <b>Progress</b>
          <span class="muted" data-id="progress-text"></span>
        </div>
        <div class="bar"><i data-id="progress-bar"></i></div>
        <div class="hint-text">
          Compared with the average length on VNDB. Your reading speed and routes change it.
        </div>
      </div>
    </div>

    <div class="col">
      <div class="card">
        <div class="field">
          <b>Status</b>
          <div class="seg" data-id="status">
            <button data-v="playing">Reading</button>
            <button data-v="finished">Finished</button>
            <button data-v="stalled">Stalled</button>
            <button data-v="dropped">Dropped</button>
          </div>
        </div>
        <div class="field">
          <b>Rating</b>
          <div class="row">
            <span class="muted small-text" data-id="vote-state"></span>
            <select data-id="vote"></select>
          </div>
        </div>
        <div class="hint-text" data-id="vndb-note"></div>
      </div>

      <div class="card">
        <div class="field">
          <b>Launch with</b>
          <div class="seg" data-id="launcher">
            <button data-v="">Normal</button>
            <button data-v="le">Locale Emulator</button>
            <button data-v="ntlea">NTLEA</button>
            <button data-v="sandboxie">Sandboxie</button>
          </div>
        </div>
        <div class="hint-text" data-id="launcher-note"></div>
        <div data-id="sandboxie-use-default-box" hidden></div>
        <div class="hint-text" data-id="sandboxie-box-note" hidden></div>
        <div class="field" data-id="sandboxie-box-field" hidden>
          <b data-id="sandboxie-box-label"></b>
          <div class="row grow">
            <input class="wide" type="text" data-id="sandboxie-box-input" spellcheck="false" />
          </div>
        </div>
        <div data-id="sandboxie-auto-update-box" hidden></div>
        <button class="btn secondary small" data-id="sandboxie-location" hidden></button>
      </div>

      <div class="card">
        <div class="field">
          <b>Discord privacy</b>
          <div class="seg" data-id="privacy">
            <button data-v="full">Full</button>
            <button data-v="partial">Partial</button>
            <button data-v="private">Private</button>
            <button data-v="off">Off</button>
          </div>
        </div>
        <div class="hint-text" data-id="privacy-help"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <b>Time read</b>
        <div class="seg" data-id="range">
          <button data-v="days">30 days</button>
          <button data-v="weeks">12 weeks</button>
        </div>
      </div>
      <div data-id="chart"></div>
      <div class="hint-text" data-id="history-note"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">
      <div class="row"><b>Screenshots</b><span class="muted" data-id="shot-count"></span></div>
      <button class="btn secondary small" data-id="all-shots">View all</button>
    </div>
    <div class="shot-strip" data-id="shots"></div>
    <div class="hint-text" data-id="shots-hint"></div>
  </div>

  <div class="card" data-id="guide-card">
    <div class="card-title">
      <div class="row"><b>Walkthrough</b> <span class="labs-tag">beta</span><span class="muted" data-id="guide-count"></span></div>
      <div class="row">
        <label class="guide-spoilers"><input type="checkbox" data-id="guide-english" /> English</label>
        <label class="guide-spoilers"><input type="checkbox" data-id="guide-spoilers" /> Show spoilers</label>
        <button class="btn secondary small" data-id="guide-overlay">Show over the game</button>
      </div>
    </div>
    <div data-id="guide"></div>
  </div>

  <div class="game-footer">
    <button class="btn" data-id="play">▶  Play</button>
    <button
      class="btn secondary"
      data-id="locate"
      title="Pick the program Play starts, like the game's launcher. The app won't change it."
    >
      Locate…
    </button>
    <button
      class="btn secondary"
      data-id="shortcut"
      title="Starts the game with the options above (Locale Emulator, Steam…) and Shiori RPC"
    >
      Desktop shortcut
    </button>
    <button class="btn danger" data-id="remove"></button>
  </div>
`;

const VOTES = [0];
for (let vote = 100; vote >= 10; vote -= 5) {
  VOTES.push(vote);
}

let root;
let key = "";
let game = null;
let range = "days";
let guide = null;
let guideFor = "";
let lastScroll = null;
let translating = false;

const part = (id) => $(`[data-id="${id}"]`, root);

function build(container) {
  root = container;
  root.append(html(TEMPLATE));

  part("back").onclick = () => show("library");
  part("change-cover").onclick = () => show("cover", { key, back: "game" });
  part("all-shots").onclick = () => show("screenshots", { key, back: "game" });
  part("play").onclick = () => playGame(key);
  part("shortcut").onclick = () => createShortcut(key, game.name);
  part("locate").onclick = async () => (await locateGame(key)) && load();
  part("vote").onchange = saveVote;

  part("edit-total").onclick = editTotal;

  subscribe("library", (change) => isShown() && (!change?.key || change.key === key) && load());
  subscribe("screenshots", (change) => isShown() && change?.key === key && load());

  part("guide-overlay").onclick = () => call("toggle_walkthrough_overlay");
  part("guide-english").onchange = async (event) => {
    const changes = { walkthrough_english: event.target.checked };
    update("settings", { ...store.settings, ...changes });
    await call("update_settings", { changes });
    renderGuide();
    ensureEnglish();
  };
  part("guide-spoilers").onchange = async (event) => {
    const changes = { walkthrough_spoilers: event.target.checked };
    update("settings", { ...store.settings, ...changes });
    await call("update_settings", { changes });
    renderGuide();
  };
  listen("walkthrough-changed", (event) => {
    if (isShown() && event.payload?.key === key) {
      loadGuide(false, true);
    }
  });
}

function isShown() {
  return root.classList.contains("active");
}

async function showPage(params) {
  if (params.key !== key) {
    range = "days";
  }
  key = params.key;
  await load();
}

async function load() {
  game = await call("get_game", { key });
  const entry = game.entry;

  part("name").textContent = game.name;
  const exe = entry.launch_path || entry.path;
  part("path").textContent = exe || t("Executable not located yet");
  part("path").disabled = !exe;
  part("path").onclick = () => call("show_in_folder", { path: exe });
  part("sandboxie-location").hidden = entry.launcher !== "sandboxie";
  part("sandboxie-location").textContent = t("Show game folder");
  part("sandboxie-location").title = t(
    "Open the game location in Explorer inside Sandboxie.",
  );
  part("sandboxie-location").onclick = () => call("show_game_in_sandboxie", { key });
  setCover(part("cover"), { path: game.cover, nsfw: entry.cover_nsfw, label: game.name });

  renderVndb(entry);
  renderStatus(entry);
  renderPrivacy(entry.privacy || "full");
  renderVote(entry);
  renderLauncher(entry);
  renderDuplicates();
  renderStats(entry);
  renderProgress(entry);
  renderChart();
  renderShots();
  const guideOn = store.settings.walkthrough_enabled !== false;
  part("guide-card").hidden = !guideOn;
  if (guideOn && guideFor !== key) {
    loadGuide(false);
  }
  document.dispatchEvent(new CustomEvent("game-loaded", { detail: game }));

  part("play").hidden = !exe;
  part("shortcut").hidden = !exe;
  part("remove").textContent = t("Delete…");
  part("remove").onclick = () => deleteGame(key, game.name);
}

async function deleteGame(key, name) {
  const sure = await openDialog({
    title: t("Delete {name}?", { name }),
    body: el(
      "div",
      { class: "delete-list" },
      el("p", { class: "muted" }, "This removes from Shiori:"),
      el(
        "ul",
        {},
        el("li", {}, "its time read, history and status"),
        el("li", {}, "its covers and VNDB info saved on this PC"),
      ),
      el("p", { class: "hint-text" }, "Screenshots are kept. If you start it again, it comes back as a new VN."),
    ),
    actions: [
      { label: "Cancel", kind: "secondary", value: false },
      { label: "Delete", kind: "danger", value: true },
    ],
  });
  if (!sure) {
    return;
  }
  await call("delete_game", { key });
  toast(t("{name} was deleted (its screenshots are kept)", { name }));
  show("library");
}

function renderVndb(entry) {
  const box = part("vndb");
  const vnId = entry.vndb_id;
  const matched = entry.matched_vndb_id;
  const link = (id) =>
    el(
      "button",
      {
        class: "btn secondary small",
        onclick: () => call("open_url", { url: `https://vndb.org/${id}` }),
      },
      `VNDB ${id}`,
    );

  if (vnId) {
    box.replaceChildren(link(vnId));
  } else if (matched) {
    const confirm = el("button", { class: "btn small", onclick: confirmMatch }, "Confirm");
    box.replaceChildren(
      link(matched),
      el("span", { class: "muted small-text" }, "found automatically"),
      confirm,
    );
  } else {
    box.replaceChildren(
      el(
        "span",
        { class: "muted small-text" },
        "Not matched on VNDB — pick it with “Change VN / cover…”.",
      ),
    );
  }
}

async function confirmMatch() {
  await call("confirm_match", { key });
  toast("VNDB entry confirmed");
}

function renderStatus(entry) {
  segmented(part("status"), entry.status || "", async (value) => {
    const status = value === entry.status ? "" : value;
    await call("update_game", { key, fields: { status } });
  });
}

function renderPrivacy(value) {
  part("privacy-help").textContent = t(PRIVACY_HELP[value] || "");
  segmented(part("privacy"), value, async (picked) => {
    await call("update_game", { key, fields: { privacy: picked } });
    renderPrivacy(picked);
  });
}

function voteLabel(vote) {
  return vote ? String(vote / 10) : "No rating";
}

function renderVote(entry) {
  const canRate = game.has_token && !!entry.vndb_id;
  const select = part("vote");
  const current = entry.vndb_vote || 0;

  const choices = VOTES.includes(current)
    ? VOTES
    : [...VOTES, current].sort((a, b) => (a && b ? b - a : a - b));
  select.replaceChildren(
    ...choices.map((v) => el("option", { value: v, selected: v === current }, voteLabel(v))),
  );
  select.disabled = !canRate;

  let note;
  if (!game.has_token) {
    note = "Add your VNDB token in Settings to rate it and sync its status to your VNDB list.";
  } else if (!entry.vndb_id) {
    note = "Confirm the VNDB match above to rate it and sync it to your VNDB list.";
  } else if (game.vndb_sync) {
    note = "Status and rating are sent to your VNDB list.";
  } else {
    note =
      "The rating is sent to your VNDB list. Turn on list sync in Settings for the status too.";
  }
  part("vndb-note").textContent = t(note);
  part("vote-state").textContent = "";

  if (canRate) {
    refreshVote();
  }
}

async function refreshVote() {
  const forKey = key;
  part("vote-state").textContent = t("Checking VNDB…");
  try {
    const vote = await invoke("get_vote", { key: forKey });
    if (forKey === key && (vote || 0) !== (game.entry.vndb_vote || 0)) {
      game.entry.vndb_vote = vote || 0;
      renderVote(game.entry);
    }
    part("vote-state").textContent = "";
  } catch (error) {
    part("vote-state").textContent = String(error);
  }
}

async function saveVote() {
  const vote = Number(part("vote").value) || null;
  part("vote").disabled = true;
  part("vote-state").textContent = t("Saving…");
  try {
    await invoke("set_vote", { key, vote });
    game.entry.vndb_vote = vote || 0;
    part("vote-state").textContent = t("Saved on VNDB ✓");
  } catch (error) {
    part("vote-state").textContent = String(error);
    renderVote(game.entry);
  }
  part("vote").disabled = false;
}

function renderLauncher(entry) {
  const launcher = entry.launcher in LAUNCHERS ? entry.launcher : "";

  const hasCustomBox = typeof entry.sandboxie_box === "string" && !!entry.sandboxie_box.trim();
  let usingDefaultBox =
    entry.sandboxie_use_default_box === true ||
    (entry.sandboxie_use_default_box !== false &&
      !hasCustomBox &&
      entry.sandboxie_auto_update_box === false);

  const defaultBoxContainer = part("sandboxie-use-default-box");
  defaultBoxContainer.hidden = launcher !== "sandboxie";
  const defaultBoxToggle = toggle(
    t("Use default box"),
    usingDefaultBox,
    async (checked) => {
      const input = defaultBoxToggle.querySelector("input");
      input.disabled = true;
      try {
        await call("update_game", { key, fields: { sandboxie_use_default_box: checked } });
      } catch (error) {
        input.checked = usingDefaultBox;
        input.disabled = false;
        toast(t("Couldn't update Sandboxie box setting: {error}", { error: error?.detail || error }), {
          error: true,
        });
        return;
      }
      usingDefaultBox = checked;
      entry.sandboxie_use_default_box = checked;
      input.disabled = false;
      applyBoxMode();
    },
  );
  defaultBoxContainer.replaceChildren(defaultBoxToggle);

  part("sandboxie-box-field").hidden = launcher !== "sandboxie";
  part("sandboxie-box-note").hidden = launcher !== "sandboxie";
  const autoUpdateBoxContainer = part("sandboxie-auto-update-box");
  autoUpdateBoxContainer.hidden = launcher !== "sandboxie";
  const autoUpdateBox = toggle(
    t("Automatically update box name"),
    entry.sandboxie_auto_update_box !== false,
    (checked) => call("update_game", { key, fields: { sandboxie_auto_update_box: checked } }),
  );
  autoUpdateBox.title = t("When on, Shiori follows the box detected from the running game.");
  autoUpdateBoxContainer.replaceChildren(autoUpdateBox);
  part("sandboxie-box-label").textContent = t("Sandboxie box");
  const boxInput = part("sandboxie-box-input");
  const sandboxieBoxField = part("sandboxie-box-field");
  const sandboxieBoxNote = part("sandboxie-box-note");
  const autoUpdateInput = autoUpdateBox.querySelector("input");
  const disabledBoxTitle = t(
    "Can't be changed while using the default box. Change it in Settings > General.",
  );
  const applyBoxMode = () => {
    const defaultName = store.settings.sandboxie_default_box || "DefaultBox";
    boxInput.value = usingDefaultBox ? defaultName : entry.sandboxie_box || defaultName;
    sandboxieBoxNote.textContent = t(
      "This game will launch inside the selected Sandboxie box.",
    );
    boxInput.disabled = usingDefaultBox;
    boxInput.title = usingDefaultBox ? disabledBoxTitle : "";
    sandboxieBoxField.classList.toggle("sandboxie-disabled", usingDefaultBox);
    autoUpdateInput.disabled = usingDefaultBox;
    autoUpdateBox.classList.toggle("sandboxie-disabled", usingDefaultBox);
    autoUpdateBox.title = usingDefaultBox
      ? t("Unavailable while using the default box.")
      : t("When on, Shiori follows the box detected from the running game.");
  };
  applyBoxMode();

  boxInput.onchange = async () => {
    const box = boxInput.value.trim();
    const previousBox = entry.sandboxie_box || store.settings.sandboxie_default_box || "DefaultBox";
    if (!box) {
      toast(t("Sandboxie box name must not be empty."), { error: true });
      boxInput.value = previousBox;
      return;
    }
    if (box === previousBox) {
      boxInput.value = box;
      return;
    }
    try {
      await call("update_game", { key, fields: { sandboxie_box: box } });
    } catch {
      boxInput.value = previousBox;
      return;
    }
    entry.sandboxie_box = box;
    boxInput.value = box;
    toast(t("Sandboxie box updated."));
  };
  boxInput.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      boxInput.blur();
    }
  };
  segmented(part("launcher"), launcher, async (value) => {
    if (value && value !== "sandboxie" && !toolIsSet(value) && !(await locateTool(value))) {
      return;
    }
    if (entry.launcher === "sandboxie" && value !== "sandboxie") {
      const confirmed = await ask(
        t("Switch away from Sandboxie?"),
        t("This may make the game run outside its sandbox and expose your system to risk. Continue?"),
        {
          yes: t("Go ahead"),
          no: t("Stay in Sandboxie"),
          danger: true,
        },
      );
      if (!confirmed) {
        return;
      }
    }
    await call("update_game", { key, fields: { launcher: value } });
  });

  const launcherNote = part("launcher-note");
  launcherNote.hidden = launcher === "sandboxie";
  if (!launcher) {
    launcherNote.textContent = t(
      "For Japanese VNs with garbled text or that won't start: Play can go through Locale Emulator or NTLEA.",
    );
  } else if (launcher === "sandboxie") {
    launcherNote.textContent = "";
  } else if (game.tool) {
    launcherNote.textContent = t("Play starts it through {tool}.", { tool: game.tool });
  } else {
    launcherNote.textContent = t("{exe} can't be found anymore — Play will ask where it is.", {
      exe: LAUNCHERS[launcher].exe,
    });
  }
}

function toolIsSet(launcher) {
  const path = launcher === "le" ? store.settings.locale_emulator_path : store.settings.ntlea_path;
  return !!path;
}

function daySeconds(day) {
  return (game.entry.daily || {})[isoDay(day)] || 0;
}

function renderStats(entry) {
  const today = midnight(new Date());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  let week = 0;
  for (let day = monday; day <= today; day = addDays(day, 1)) {
    week += daySeconds(day);
  }

  part("total").textContent = formatPlaytime(entry.playtime_seconds || 0);
  part("week").textContent = formatPlaytime(week);
  part("sessions").textContent = entry.sessions || "—";
  part("last").textContent = lastPlayed(entry.last_played) || "—";
}

function renderDuplicates() {
  const other = game.duplicates[0];
  part("dupe").hidden = !other;
  if (!other) {
    return;
  }
  part("dupe-text").textContent = t("Looks like the same game as “{name}” ({time} read).", {
    name: other.name,
    time: formatPlaytime(other.playtime),
  });
  part("dupe-merge").onclick = () => mergeWith(other);
}

async function mergeWith(other) {
  const keepThis = (game.entry.playtime_seconds || 0) >= other.playtime;
  const [from, into, name] = keepThis
    ? [other.key, key, game.name]
    : [key, other.key, other.name];

  const sure = await ask(
    "Merge these entries?",
    t("Time read, history, sessions and screenshots are combined into “{name}”. This can't be undone.", {
      name,
    }),
    { yes: "Merge" },
  );
  if (!sure) {
    return;
  }
  await call("merge_games", { from, into });
  toast(t("Merged into {name}", { name }));
  show("game", { key: into });
}

async function renderProgress(entry) {
  const shownKey = key;
  const vnId = entry.vndb_id || entry.matched_vndb_id;
  const minutes = vnId ? await invoke("vn_length", { vnId }).catch(() => 0) : 0;
  if (shownKey !== key) {
    return;
  }

  const percent = readingProgress(entry.playtime_seconds, minutes);
  part("progress").hidden = percent === null;
  if (percent === null) {
    return;
  }
  part("progress-bar").style.width = `${Math.min(percent, 100)}%`;
  part("progress-text").textContent =
    percent < 100
      ? t("{percent}% · average {length}", { percent, length: lengthText(minutes) })
      : t("Past the average ({length})", { length: lengthText(minutes) });
}

function dailyPoints(today) {
  const points = [];
  for (let back = 29; back >= 0; back--) {
    const day = addDays(today, -back);
    points.push({ day, seconds: daySeconds(day), tip: `${weekday(day)} ${shortDate(day, today)}` });
  }
  return points;
}

function weeklyPoints(today) {
  const thisMonday = addDays(today, -((today.getDay() + 6) % 7));
  const points = [];
  for (let back = 11; back >= 0; back--) {
    const monday = addDays(thisMonday, -7 * back);
    let seconds = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      if (day <= today) {
        seconds += daySeconds(day);
      }
    }
    points.push({ day: monday, seconds, tip: t("Week of {date}", { date: shortDate(monday, today) }) });
  }
  return points;
}

function renderChart() {
  segmented(part("range"), range, (value) => {
    range = value;
    renderChart();
  });

  const today = midnight(new Date());
  const points = range === "weeks" ? weeklyPoints(today) : dailyPoints(today);

  const every = range === "weeks" ? 3 : 7;
  for (const [i, point] of points.entries()) {
    point.axis = (points.length - 1 - i) % every === 0 ? shortDate(point.day, today) : "";
  }
  drawChart(part("chart"), points);

  const days = Object.keys(game.entry.daily || {}).sort();
  part("history-note").textContent = days.length
    ? t("History since {date}. Time read before that only counts in the total.", {
        date: shortDate(parseDay(days[0]), today),
      })
    : t("History fills in as you read — time read before it was tracked only counts in the total.");
}

async function editTotal() {
  const seconds = game.entry.playtime_seconds || 0;
  const hours = el("input", { type: "number", min: 0, value: Math.floor(seconds / 3600) });
  const minutes = el("input", {
    type: "number",
    min: 0,
    max: 59,
    value: Math.floor((seconds % 3600) / 60),
  });

  const answer = await openDialog({
    title: "Total read",
    body: el(
      "div",
      { style: { display: "grid", gap: "12px" } },
      el("div", { class: "row" }, hours, "h", minutes, "min"),
      el(
        "p",
        { class: "muted small-text" },
        "Time read before the app tracked it, or a correction. The day-by-day history " +
          "(this week, the chart) stays as it is.",
      ),
    ),
    actions: [
      { label: "Cancel", kind: "secondary", value: null },
      { label: "Save", value: "save" },
    ],
    onOpen: (finish) => {
      hours.select();
      for (const input of [hours, minutes]) {
        input.onkeydown = (event) => {
          if (event.key === "Enter") {
            finish("save");
          }
        };
      }
    },
  });
  if (!answer) {
    return;
  }

  const h = Number(hours.value || 0);
  const m = Number(minutes.value || 0);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) {
    toast("Enter whole numbers of hours and minutes.", { error: true });
    return;
  }
  await call("set_playtime", { key, seconds: h * 3600 + m * 60 });
  setTimeout(load, 400);
}

async function renderShots() {
  const strip = part("shots");
  part("shot-count").textContent = game.shot_count ? String(game.shot_count) : "";
  part("all-shots").hidden = !game.shot_count;

  const hotkey = game.hotkey;
  part("shots-hint").hidden = game.shot_count > 0;
  part("shots-hint").textContent = hotkey
    ? t("Press {key} while reading to capture the game's window.", { key: hotkey })
    : t("Pick a screenshot key in Settings to capture the game's window.");

  strip.replaceChildren();
  for (const path of game.shots) {
    const clip = /\.mp4$/i.test(path);
    const img = clip
      ? el("video", { muted: true, preload: "metadata", playsinline: true, src: `${fileUrl(path)}#t=0.5` })
      : el("img", { alt: "" });
    strip.append(
      el(
        "button",
        { onclick: () => show("screenshots", { key, select: path, back: "game" }) },
        img,
        clip && el("span", { class: "tile-clip" }, "▶"),
      ),
    );
    if (!clip) {
      invoke("thumbnail", { path, width: 320, height: 180 }).then(
        (thumb) => (img.src = fileUrl(thumb)),
      );
    }
  }
}

async function loadGuide(refresh, quiet = false) {
  const forKey = key;
  guideFor = key;
  if (!quiet) {
    guide = { loading: true };
    renderGuide();
  }
  try {
    const result = await invoke("walkthrough_get", { key: forKey, refresh });
    if (forKey !== key) {
      return;
    }
    guide = result.found ? result.walkthrough : { missing: true };
    ensureEnglish();
  } catch (error) {
    if (forKey !== key) {
      return;
    }
    guide = { error: String(error) };
  }
  renderGuide();
}

const wantsEnglish = () => store.settings.walkthrough_english !== false;

async function ensureEnglish() {
  if (!wantsEnglish() || !guide?.routes || guide.translated || translating) {
    return;
  }
  const forKey = key;
  translating = true;
  renderGuide();
  try {
    const result = await invoke("walkthrough_translate", { key: forKey });
    if (forKey === key && result.found) {
      guide = result.walkthrough;
    }
  } catch {
    if (forKey === key && guide) {
      guide.translateFailed = true;
    }
  }
  translating = false;
  if (forKey === key) {
    renderGuide();
  }
}

async function useSource(source) {
  if (guide?.source === source || translating) {
    return;
  }
  const previous = guide;
  guide = { loading: true };
  renderGuide();
  const result = await call("walkthrough_source", { key, source });
  if (result?.found) {
    guide = result.walkthrough;
    renderGuide();
    ensureEnglish();
    return;
  }
  guide = previous;
  renderGuide();
  if (result?.no_match) {
    const label = SOURCES.find((s) => s.id === source)?.label || source;
    toast(t("No walkthrough found on {site}. Search it yourself:", { site: label }));
    pickGuide(source);
  }
}

function sourcePicker() {
  return el(
    "div",
    { class: "guide-sources" },
    el("span", { class: "muted" }, "Source"),
    SOURCES.map((source) =>
      el(
        "button",
        {
          class: guide?.source === source.id ? "on" : "",
          title: source.hint,
          onclick: () => useSource(source.id),
        },
        source.label,
      ),
    ),
  );
}

async function pickGuide(source = "") {
  const result = await findWalkthrough(key, game.entry.title || game.name, source);
  if (result?.found) {
    guide = result.walkthrough;
    renderGuide();
    ensureEnglish();
  }
}

async function markGuide(id, done) {
  const result = await call("walkthrough_mark", { key, id, done });
  if (result?.found) {
    guide = result.walkthrough;
    renderGuide();
  }
}

async function pickRoute(route) {
  const result = await call("walkthrough_route", { key, route });
  if (result?.found) {
    guide = result.walkthrough;
    renderGuide();
  }
}

async function clearRoute() {
  const result = await call("walkthrough_clear", { key });
  if (result?.found) {
    guide = result.walkthrough;
    renderGuide();
  }
}

function guideNote(english) {
  if (guide.source === "nook") {
    return "From NookGaming, in English. Tick the choices as you make them.";
  }
  if (!english) {
    return "From Seiya-Saiga, in Japanese. Tick the choices as you make them.";
  }
  if (translating) {
    return "Translating to English…";
  }
  if (guide.translateFailed && !guide.translated) {
    return "Couldn't translate it, so it stays in Japanese. Try again later.";
  }
  return "From Seiya-Saiga, translated by Google. Hover a line to see the Japanese.";
}

function renderGuide() {
  const box = part("guide");
  const spoilers = !!store.settings.walkthrough_spoilers;
  const english = wantsEnglish();
  part("guide-spoilers").checked = spoilers;
  part("guide-english").checked = english;
  part("guide-count").textContent = "";
  const found = guide && guide.routes;
  part("guide-overlay").hidden = !found;
  part("guide-spoilers").parentElement.hidden = !found;
  part("guide-english").parentElement.hidden = !found || guide.source === "nook";

  if (!guide || guide.loading) {
    box.replaceChildren(el("div", { class: "hint-text" }, "Looking for a walkthrough…"));
    return;
  }
  if (guide.error || guide.missing) {
    box.replaceChildren(
      el(
        "div",
        { class: "guide-empty" },
        el(
          "span",
          { class: "hint-text" },
          guide.error ? "Couldn't load the walkthrough. Check your connection." : "No walkthrough found for this VN.",
        ),
        el(
          "div",
          { class: "row" },
          guide.error && el("button", { class: "btn secondary small", onclick: () => loadGuide(false) }, "Try again"),
          el("button", { class: "btn secondary small", onclick: () => pickGuide() }, "Find it…"),
        ),
      ),
      sourcePicker(),
    );
    return;
  }

  const count = choiceCount(guide);
  part("guide-count").textContent = count.total ? `${count.done}/${count.total}` : "";
  const next = nextChoice(guide);

  const tabs = el(
    "div",
    { class: "guide-tabs" },
    guide.routes.map((route, i) =>
      el(
        "button",
        { class: i === guide.route ? "on" : "", onclick: () => i !== guide.route && pickRoute(i) },
        secret("span", {}, say(guide, route.name, english), !spoilers && i !== guide.route),
      ),
    ),
  );
  const route = guide.routes[guide.route];
  const steps = el(
    "div",
    { class: "guide-steps" },
    route.steps.map((_, i) =>
      stepRow(guide, guide.route, i, {
        spoilers,
        english,
        onMark: markGuide,
        current: i === next,
      }),
    ),
  );
  const footer = el(
    "div",
    { class: "guide-footer" },
    el(
      "button",
      { class: "link", onclick: () => call("open_url", { url: guide.url }) },
      raw("span", {}, `${guide.source === "nook" ? "NookGaming" : "Seiya-Saiga"} · ${guide.title}`),
    ),
    el(
      "div",
      { class: "row" },
      count.done > 0 && el("button", { class: "btn secondary small", onclick: clearRoute }, "Untick this route"),
      el("button", { class: "btn secondary small", onclick: () => pickGuide(guide.source) }, "Wrong game?"),
      el("button", { class: "btn secondary small", onclick: () => loadGuide(true) }, "Refresh"),
    ),
  );
  const scroll = steps.scrollTop;
  const sameRoute = box.dataset.route === String(guide.route);
  box.dataset.route = String(guide.route);
  box.replaceChildren(
    el("div", { class: "guide-head" }, el("p", { class: "hint-text" }, guideNote(english)), sourcePicker()),
    tabs,
    steps,
    footer,
  );
  const old = sameRoute ? lastScroll : null;
  if (old !== null) {
    steps.scrollTop = old;
  } else {
    const current = steps.querySelector(".current");
    steps.scrollTop = current ? Math.max(0, current.offsetTop - steps.offsetTop - 60) : scroll;
  }
  steps.onscroll = () => (lastScroll = steps.scrollTop);
  lastScroll = steps.scrollTop;
}

register({
  id: "game",
  nav: "library",
  build,
  show: showPage,
  onKey: (event) => event.key === "Escape" && show("library"),
});
