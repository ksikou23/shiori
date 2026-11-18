import { invoke, fileUrl, currentWindow, listenHere } from "../tauri.js";

const DRAG_SLOP = 4;
const DOUBLE_CLICK_MS = 280;

const character = document.getElementById("character");
const sprite = document.getElementById("sprite");
const SPRING = { bounce: "boing", pop: "pop" };

let pressedAt = null;
let dragging = false;
let clickTimer = null;

let spriteTimer = null;

function swap(speaking, effect) {
  document.body.dataset.effect = effect;
  document.body.classList.toggle("speaking", speaking);
  const shown = speaking ? sprite : character;
  const spring = SPRING[effect];
  if (spring) {
    shown.classList.remove("boing", "pop");
    void shown.offsetWidth;
    shown.classList.add(spring);
  }
}

listenHere("sprite", (event) => {
  const { file, seconds, effect } = event.payload;
  const url = fileUrl(file);
  const ready = new Image();
  ready.onload = () => {
    clearTimeout(spriteTimer);
    sprite.src = url;
    swap(true, effect);
    spriteTimer = setTimeout(() => swap(false, effect), Math.max(1, Number(seconds) || 4) * 1000);
  };
  ready.src = url;
});

for (const image of [character, sprite]) {
  image.addEventListener("animationend", () => image.classList.remove("boing", "pop"));
}

async function start() {
  clearTimeout(spriteTimer);
  document.body.classList.remove("speaking");
  const info = await invoke("mascot_info");
  if (info) {
    character.src = fileUrl(info.file);
  }
}

character.addEventListener("pointerdown", (event) => {
  if (event.button === 0) {
    pressedAt = { x: event.screenX, y: event.screenY };
    dragging = false;
  }
});

character.addEventListener("pointermove", (event) => {
  if (!pressedAt || dragging || !(event.buttons & 1)) {
    return;
  }
  const distance = Math.abs(event.screenX - pressedAt.x) + Math.abs(event.screenY - pressedAt.y);
  if (distance >= DRAG_SLOP) {
    dragging = true;
    invoke("hide_balloon");
    currentWindow().startDragging();
  }
});

character.addEventListener("pointerup", (event) => {
  if (event.button !== 0 || !pressedAt) {
    return;
  }
  pressedAt = null;
  if (dragging) {
    return;
  }

  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    invoke("mascot_open_app");
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    invoke("mascot_poke");
  }, DOUBLE_CLICK_MS);
});

character.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  invoke("mascot_menu");
});

let voice = null;
listenHere("voice", (event) => {
  voice?.pause();
  voice = new Audio(fileUrl(event.payload.file));
  voice.volume = Math.min(event.payload.volume, 100) / 100;
  voice.play().catch(() => {});
});

const tuck = (tucked) => document.body.classList.toggle("tucked", !!tucked);
const syncTuck = () => invoke("mascot_tucked").then(tuck).catch(() => {});
listenHere("tuck", (event) => tuck(event.payload)).then(syncTuck);
setInterval(syncTuck, 2000);

listenHere("mascot-refresh", start);
setInterval(() => invoke("mascot_alive"), 10000);
start();
