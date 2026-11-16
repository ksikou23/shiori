import { el } from "../dom.js";
import { invoke } from "../tauri.js";
import { store } from "../store.js";
import { call, openDialog } from "../ui.js";
import { COMMUNITY_URL } from "../links.js";
import { t } from "../i18n.js";

export async function offerCommunity() {
  if (store.settings.community_offered) {
    return false;
  }
  store.settings.community_offered = true;
  await invoke("update_settings", { changes: { community_offered: true } });
  const open = await openDialog({
    title: t("Try the Shiori community"),
    body: el(
      "div",
      { class: "community-offer" },
      el("p", { class: "muted" }, "See what other people are reading, follow them and get your own profile page on shiori.maia.moe."),
      el(
        "p",
        { class: "muted small-text" },
        "Nobody sees what you read until you turn on Public profile in Settings → Cloud backup.",
      ),
    ),
    actions: [
      { label: t("Not now"), kind: "secondary", value: false },
      { label: t("Open the website"), value: true },
    ],
  });
  if (open) {
    await call("open_url", { url: COMMUNITY_URL });
  }
  return true;
}
