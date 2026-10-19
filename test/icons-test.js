// End-to-end test of state icons: driver + fake Core API + builder HTTP API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, activities, devices, icons as uploaded, TV, MARANTZ } from "./mock-core.js";
import { lookFor, applyLook, validateIcons, levelIndex } from "../src/bin/stateicons.js";

const CORE_PORT = 18083;
const WS_PORT = 19097;
const WEB = "http://127.0.0.1:10934";
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-icons-"));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACT = "uc.main.act1"; // Watch TV, one page
const item = (x, y) => activities[ACT].pages[0].items.find((it) => it.location.x === x && it.location.y === y);
// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---- pure helpers ---------------------------------------------------------------
const b0 = { default: { type: "text", icon: null, text: "Receiver" }, states: [{ value: "ON", icon: "custom:on.png", text: "Receiver ON" }, { value: "PAUSED", icon: null, text: "Paused" }] };
ok(JSON.stringify(lookFor(b0, "on")) === JSON.stringify({ type: "icon", icon: "custom:on.png", text: "Receiver ON", state: "ON" }), "matching state (case-insensitive) gives its icon and label");
ok(lookFor(b0, "OFF").type === "text" && lookFor(b0, "OFF").text === "Receiver" && lookFor(b0, "OFF").state === null, "no match gives the default look");
ok(lookFor(b0, "PAUSED").type === "text" && lookFor(b0, "PAUSED").text === "Paused", "label-only state shows the label");
const applied = applyLook({ type: "text", text: "Receiver", location: { x: 1, y: 0 }, command: { cmd_id: "x" } }, lookFor(b0, "ON"));
ok(applied.type === "icon" && applied.icon === "custom:on.png" && applied.command.cmd_id === "x" && applied.location.x === 1, "applying a look keeps the command and position");
ok(validateIcons({ icons: [{ id: "Bad id", states: [] }] }).errors.length >= 4, "validation lists what's missing");
ok(validateIcons({ icons: [{ id: "a1", activity: "x", location: { x: 0, y: 0 }, entity: "e", states: [{ value: "ON" }] }] }).errors.some((e) => /drop an image or type a label/.test(e)), "a state needs an image or a label");

const FR = Array.from({ length: 11 }, (_, i) => `custom:lv_bar_orange_${String(i * 10).padStart(3, "0")}.png`);
const lv = { kind: "level", min: 0, max: 80, frames: FR, default: { type: "text", text: "Vol" } };
ok(levelIndex(lv, 0) === 0 && levelIndex(lv, 40) === 5 && levelIndex(lv, 80) === 10 && levelIndex(lv, 200) === 10 && levelIndex(lv, -5) === 0, "level: value → frame (0..10), clamped to the range");
ok(lookFor(lv, 24).icon === FR[3] && lookFor(lv, 24).state === "30 %" && lookFor(lv, "n/a").type === "text", "level look: frame for numbers, default look otherwise");
ok(validateIcons({ icons: [{ id: "l1", activity: "a", location: { x: 0, y: 0 }, entity: "e.x", attr: "volume", kind: "level", min: 0, max: 80, frames: FR.slice(0, 5) }] }).errors.some((e) => /level design/.test(e)), "level without its 11 images refused");
ok(validateIcons({ icons: [{ id: "l1", activity: "a", location: { x: 0, y: 0 }, entity: "e.x", attr: "volume", kind: "level", min: 0, max: 80, frames: FR }] }).errors.length === 0, "level binding with 11 frames and no states is valid");
const many = (n, devs) => ({ icons: Array.from({ length: n }, (_, i) => ({ id: "i" + i, activity: "a", location: { x: i % 4, y: Math.floor(i / 4) }, entity: "e.d" + (i % devs), states: [{ value: "ON", text: "on" }] })) });
ok(validateIcons(many(60, 25)).errors.length === 0, "60 state icons on 25 devices allowed");
ok(validateIcons(many(61, 5)).errors.some((e) => /at most 60 state icons/.test(e)), "61 state icons refused");
ok(validateIcons(many(30, 26)).errors.some((e) => /at most 25 different devices/.test(e)), "26 different devices refused; icons on the same device count once");
ok(validateIcons({ icons: [{ id: "l1", activity: "a", location: { x: 0, y: 0 }, entity: "e.x", attr: "volume", kind: "level", min: 0, max: 80, frames: FR, slider: "slider_rv", bg: "custom:tile.png", scale: 0.6 }] }).icons[0].bg === "custom:tile.png", "a level graphic keeps its slider, background picture and size");

// ---- driver -----------------------------------------------------------------------
activities["uc.main.act3"] = { name: { en: "Movie Night" }, state: "OFF", entity_ids: [], buttons: {}, pages: [
  { page_id: "m1", name: "One", grid: { width: 4, height: 6 }, items: [{ type: "text", text: "A", location: { x: 0, y: 0 } }] },
  { page_id: "m2", name: "Two", grid: { width: 4, height: 6 }, items: [] }] };
devices[MARANTZ].state = "OFF";
devices[TV].state = "ON";
const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const drv = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10934", UC_SELF_RETURN_POLL_MS: "250" },
  stdio: ["ignore", "pipe", "pipe"]
});
let drvLog = "";
drv.stdout.on("data", (d) => (drvLog += d));
drv.stderr.on("data", (d) => (drvLog += d));
await sleep(1200);
const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
const events = [];
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.kind === "resp" && pending.has(m.req_id)) { pending.get(m.req_id)(m); pending.delete(m.req_id); }
  else if (m.kind === "event") events.push(m);
});
let rid = 1;
const req = (msg, msg_data) => new Promise((r) => { const id = rid++; pending.set(id, r); ws.send(JSON.stringify({ kind: "req", id, msg, msg_data })); });
await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { pin: "1234", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
ws.send(JSON.stringify({ kind: "event", msg: "connect", cat: "DEVICE" }));
await sleep(500);

let cookie = "";
const http = async (method, url, body) => {
  const res = await fetch(WEB + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, type };
};
let h = await http("GET", "/api/icons");
ok(h.status === 401, "state icons API needs a login");
await http("POST", "/api/login", { pin: "1234" });

// ---- activities list ---------------------------------------------------------------
h = await http("GET", "/api/icons");
const acts = h.data.activities || [];
ok(h.status === 200 && acts.map((a) => `${a.name}:${a.pageCount}`).join() === "Play Music:1,Watch TV:1,Movie Night:2", "activities: single-page first, multi-page listed with page count: " + acts.map((a) => `${a.name}:${a.pageCount}`).join());
ok(acts.find((a) => a.id === ACT)?.page?.items?.length === 2 && !acts.find((a) => a.name === "Movie Night").page, "single-page activities include their page; multi-page ones don't");
ok(Array.isArray(h.data.icons) && h.data.icons.length === 0, "no state icons yet");

// ---- upload + image proxy ---------------------------------------------------------------
h = await http("POST", "/api/icons/upload", { name: "si_test_on.png", data: PNG });
ok(h.status === 200 && h.data.icon === "custom:si_test_on.png" && uploaded["si_test_on.png"], "image uploaded to the remote as a custom icon");
h = await http("POST", "/api/icons/upload", { name: "si_test_on.png", data: PNG });
ok(h.status === 200 && h.data.icon === "custom:si_test_on.png", "uploading the same name again reuses it");
h = await http("POST", "/api/icons/upload", { name: "x.png", data: Buffer.from("hello").toString("base64") });
ok(h.status === 400, "non-PNG upload refused");
h = await http("POST", "/api/icons/upload", { name: "../x.png", data: PNG });
ok(h.status === 400, "bad file name refused");
h = await http("GET", "/api/icons/image?id=si_test_on.png");
ok(h.status === 200 && h.type.startsWith("image/png"), "icon images are served to the builder for thumbnails");

// ---- validation against the remote ------------------------------------------------------
const receiver = { id: "receiver_power", name: "Receiver power", activity: ACT, location: { x: 1, y: 0 }, entity: MARANTZ, attr: "state", states: [{ value: "ON", icon: "custom:si_test_on.png", text: "Receiver ON" }] };
h = await http("POST", "/api/icons", { icons: [{ ...receiver, activity: "uc.main.act3", location: { x: 0, y: 0 } }] });
ok(h.status === 422 && /exactly one page/.test(h.data.errors.join()), "multi-page activity refused: " + h.data.errors);
h = await http("POST", "/api/icons", { icons: [{ ...receiver, location: { x: 3, y: 3 } }] });
ok(h.status === 422 && /no icon or text button/.test(h.data.errors.join()), "empty spot refused");
h = await http("POST", "/api/icons", { icons: [{ ...receiver, states: [] }] });
ok(h.status === 422, "binding without states refused");

// ---- receiver power on a text button ------------------------------------------------------
h = await http("POST", "/api/icons", { icons: [receiver] });
ok(h.status === 200 && h.data.icons[0].default.text === "Receiver" && h.data.icons[0].default.type === "text", "saved; the button's current look became the default");
ok(h.data.icons[0].status.look === "default" && item(1, 0).type === "text" && item(1, 0).text === "Receiver", "receiver OFF: button keeps its default look");
devices[MARANTZ].state = "ON";
await sleep(900);
ok(item(1, 0).type === "icon" && item(1, 0).icon === "custom:si_test_on.png" && item(1, 0).text === "Receiver ON", "receiver ON: button shows the dropped image and label");
devices[MARANTZ].state = "OFF";
await sleep(900);
ok(item(1, 0).type === "text" && item(1, 0).text === "Receiver" && !item(1, 0).icon, "receiver OFF again: back to the default look");

// ---- TV state on an icon button with a command --------------------------------------------
const tv = { id: "tv_power", name: "TV", activity: ACT, location: { x: 0, y: 0 }, entity: TV, attr: "state", states: [{ value: "OFF", text: "TV off" }] };
devices[MARANTZ].state = "ON";
h = await http("POST", "/api/icons", { icons: [{ ...receiver, states: [...receiver.states, { value: "STANDBY", text: "Receiver standby" }] }, tv] });
await sleep(600);
ok(h.status === 200 && h.data.icons.find((b) => b.id === "receiver_power").default.text === "Receiver", "editing an existing state icon keeps its original default (not the look it's showing)");
ok(item(1, 0).icon === "custom:si_test_on.png", "receiver ON still shown after re-saving");
devices[TV].state = "OFF";
await sleep(900);
ok(item(0, 0).type === "text" && item(0, 0).text === "TV off" && item(0, 0).command?.cmd_id === "media_player.toggle", "TV OFF: icon button shows the label and keeps its command");
devices[TV].state = "ON";
await sleep(900);
ok(item(0, 0).type === "icon" && item(0, 0).icon === "uc:tv" && !item(0, 0).text, "TV ON: original icon restored");
ok(JSON.parse(fs.readFileSync(path.join(cfgDir, "state_icons.json"), "utf8")).icons.length === 2, "state icons saved in state_icons.json");

// ---- level graphic on the receiver volume ---------------------------------------------------
devices[MARANTZ].volume = 40;
h = await http("POST", "/api/icons", { icons: [tv, { id: "rcv_level", name: "Receiver volume", activity: ACT, location: { x: 1, y: 0 }, entity: MARANTZ, attr: "volume", kind: "level", min: 0, max: 80, design: "bar", color: "orange", frames: FR }] });
await sleep(600);
ok(h.status === 200 && item(1, 0).type === "icon" && item(1, 0).icon === FR[5], "level graphic: volume 40 of 80 shows the 50 % image: " + item(1, 0).icon);
devices[MARANTZ].volume = 72;
await sleep(900);
ok(item(1, 0).icon === FR[9], "volume 72 → 90 % image");
h = await http("GET", "/api/icons");
ok(h.data.icons.find((b) => b.id === "rcv_level")?.status?.look === "90 %", "builder shows which step is on the remote");
ok(h.data.check && h.data.check.devices >= 1 && h.data.check.ms >= 0 && h.data.limits.icons === 60 && h.data.limits.devices === 25, `builder gets the last check time: ${h.data.check?.ms} ms for ${h.data.check?.devices} devices`);

// ---- level graphic over several tiles, shown only for a while after a change -----------------
activities["uc.main.act5"] = { name: { en: "Skin" }, state: "OFF", entity_ids: [], buttons: {}, pages: [
  { page_id: "s1", name: "Main", grid: { width: 2, height: 3 }, items: [0, 1, 2].map((y) => ({ type: "icon", icon: `custom:skin_${y}.png`, location: { x: 0, y }, size: { width: 1, height: 1 } })) }] };
const skin = (y) => activities["uc.main.act5"].pages[0].items.find((it) => it.location.y === y);
const cf = (y) => Array.from({ length: 11 }, (_, i) => `custom:col_${y}_${String(i * 10).padStart(3, "0")}.png`);
const column = { id: "col_level", name: "Volume column", activity: "uc.main.act5", location: { x: 0, y: 0 }, entity: MARANTZ, attr: "volume", kind: "level", min: 0, max: 80,
  design: "column", color: "orange", frames: cf(0), cells: [0, 1, 2].map((y) => ({ x: 0, y, frames: cf(y) })), show: "change", showMs: 1200 };
devices[MARANTZ].volume = 40;
h = await http("POST", "/api/icons", { icons: [tv, column] });
ok(h.status === 200 && h.data.icons.find((b) => b.id === "col_level")?.cellDefaults?.length === 3, "column over 3 tiles saved; each tile's own picture kept as its default");
await sleep(600);
ok(skin(0).icon === "custom:skin_0.png" && skin(2).icon === "custom:skin_2.png", "show on change: nothing shown before the volume changes");
devices[MARANTZ].volume = 72;
await sleep(700);
ok(skin(0).icon === cf(0)[9] && skin(1).icon === cf(1)[9] && skin(2).icon === cf(2)[9], "volume changed: all 3 tiles show their part of the 90 % picture");
await sleep(1800);
ok(skin(0).icon === "custom:skin_0.png" && skin(1).icon === "custom:skin_1.png" && skin(2).icon === "custom:skin_2.png", "after the show time the tiles go back to their own pictures");
ok(validateIcons({ icons: [{ ...column, cells: [{ x: 0, y: 0, frames: cf(0) }, { x: 0, y: 1, frames: [] }] }] }).errors.some((e) => /images are missing/.test(e)), "every tile needs its 11 images");
h = await http("POST", "/api/icons", { icons: [tv] });
await sleep(300);
ok(skin(1).icon === "custom:skin_1.png", "removing the column leaves the tiles as they were");

// ---- removing one restores its button --------------------------------------------------------
h = await http("POST", "/api/icons", { icons: [tv] });
await sleep(300);
ok(h.status === 200 && item(1, 0).type === "text" && item(1, 0).text === "Receiver", "removed state icon: its button gets its default look back");

// ---- page gets a second page -------------------------------------------------------------------
activities[ACT].pages.push({ page_id: "p9", name: "Extra", grid: { width: 4, height: 6 }, items: [] });
devices[TV].state = "OFF";
await sleep(900);
h = await http("GET", "/api/icons");
ok(/2 pages/.test(h.data.icons[0].status.error || ""), "activity gained a page: no update, error shown in the builder: " + h.data.icons[0].status.error);
ok(item(0, 0).type === "icon", "button left alone on a multi-page activity");
activities[ACT].pages.pop();

await http("POST", "/api/logout", {});
cookie = "";
h = await http("GET", "/api/icons");
ok(h.status === 401, "after logout the API needs a login again");

drv.kill();
ws.terminate();
srv.close();
fs.rmSync(path.join(binDir, "driver.json"));
console.log("\n--- driver log (state icon lines) ---\n" + drvLog.split("\n").filter((l) => /state icon/i.test(l)).slice(0, 15).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
