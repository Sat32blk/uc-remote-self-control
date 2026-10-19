// End-to-end test of "Return to previous activity": driver + fake Core API + fake remote WebSocket client.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, activities, groups } from "./mock-core.js";
import { freeSpot, isReturnItem } from "../src/bin/returnbtn.js";

const CORE_PORT = 18082;
const WS_PORT = 19096;
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-return-"));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TV_ACT = "uc.main.act1"; // Watch TV
const MUSIC = "uc.main.act2"; // Play Music

// ---- pure helpers -----------------------------------------------------------
ok(JSON.stringify(freeSpot({ width: 4, height: 6 }, [], 2, 1)) === '{"x":0,"y":5}', "free spot: bottom-left of an empty page");
ok(JSON.stringify(freeSpot({ width: 4, height: 6 }, [{ location: { x: 0, y: 0 }, size: { width: 4, height: 5 } }, { location: { x: 0, y: 5 }, size: { width: 1, height: 1 } }], 2, 1)) === '{"x":1,"y":5}', "free spot: skips used cells");
ok(freeSpot({ width: 4, height: 1 }, [{ location: { x: 0, y: 0 }, size: { width: 4, height: 1 } }], 1, 1) === null, "free spot: none on a full page");
ok(isReturnItem({ type: "text", text: "↩ Watch TV" }) && isReturnItem({ type: "icon", icon: "uc:back" }) && !isReturnItem({ type: "icon", icon: "uc:back", command: { cmd_id: "media_player.back" } }) && !isReturnItem({ type: "text", text: "Back" }), "↩ items recognised; a normal back button is left alone");

// ---- driver -------------------------------------------------------------------
const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const env = { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10933", UC_SELF_RETURN_POLL_MS: "250" };
let drv = spawn(process.execPath, ["driver.js"], { cwd: binDir, env, stdio: ["ignore", "pipe", "pipe"] });
let drvLog = "";
drv.stdout.on("data", (d) => (drvLog += d));
drv.stderr.on("data", (d) => (drvLog += d));
await sleep(1200);

let ws, events, pending, id = 1;
async function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  events = [];
  pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.kind === "resp" && pending.has(m.req_id)) { pending.get(m.req_id)(m); pending.delete(m.req_id); }
    else if (m.kind === "event") events.push(m);
  });
}
await connect();
const req = (msg, msg_data) => new Promise((r) => { const rid = id++; pending.set(rid, r); ws.send(JSON.stringify({ kind: "req", id: rid, msg, msg_data })); });
const send = (msg) => ws.send(JSON.stringify({ kind: "event", msg, cat: "DEVICE" }));
const lastSetup = () => [...events].reverse().find((e) => e.msg === "driver_setup_change");
const prevValue = async () => (await req("get_entity_states")).msg_data.find((e) => e.entity_id === "previous_activity")?.attributes?.value;

await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { pin: "1234", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
ok(lastSetup()?.msg_data.state === "OK", "PIN setup OK");
await req("subscribe_events", { entity_ids: ["previous_activity"] });
send("connect");
await sleep(500);

const returnSetup = async (inputs) => {
  events.length = 0;
  await req("setup_driver", { reconfigure: true, setup_data: {} });
  await sleep(400);
  const menu = lastSetup()?.msg_data.require_user_action?.input?.settings?.find((x) => x.id === "action")?.field.dropdown.items.map((i) => i.id) || [];
  await req("set_driver_user_data", { input_values: { action: "return" } });
  await sleep(900);
  const page = lastSetup()?.msg_data.require_user_action?.input?.settings || [];
  if (inputs) {
    await req("set_driver_user_data", { input_values: inputs });
    await sleep(1500);
  }
  return { menu, page, after: lastSetup() };
};

// ---- setup screen -------------------------------------------------------------
let r = await returnSetup(null);
ok(r.menu.includes("return"), "setup menu offers the return button");
const labels = r.page.filter((x) => x.id.startsWith("host_")).map((x) => x.label.en);
ok(labels.join() === "Play Music,Watch TV", "one checkbox per editable activity: " + labels);
const btnItems = r.page.find((x) => x.id === "button")?.field.dropdown.items.map((i) => i.id) || [];
ok(btnItems[0] === "NONE" && btnItems.includes("BACK") && btnItems.includes("RECORD"), "physical button list from the remote: " + btnItems.join(","));
ok(r.page.find((x) => x.id === "screen")?.field.dropdown.items.map((i) => i.id).join() === "text,icon,none", "on-screen choice: text, icon, none");
ok(r.page.find((x) => x.id === "press")?.field.dropdown.items.map((i) => i.id).join() === "short_press,long_press", "press: short, long");
ok(r.page.find((x) => x.id === "scope")?.field.dropdown.items.map((i) => i.id).join() === "all,nofit", "physical button scope: every activity, or only where the screen button doesn't fit");

r = await returnSetup({ host_0: "true", host_1: "true", screen: "none", button: "NONE", press: "short_press" });
const err = r.after?.msg_data.require_user_action?.input?.settings?.find((x) => x.id === "errors");
ok(err && /on-screen button, a physical button/.test(err.field.label.value.en), "nothing to show -> asks for a screen or physical button");

r = await returnSetup({ host_0: "true", host_1: "true", screen: "text", button: "RECORD", press: "short_press", scope: "nofit" });
ok(r.after?.msg_data.state === "OK", "return button set up for both activities");
const tvItem = () => activities[TV_ACT].pages[0].items.find(isReturnItem);
const musicItem = () => activities[MUSIC].pages[0].items.find(isReturnItem);
ok(tvItem()?.text === "↩ Previous" && JSON.stringify(tvItem().location) === '{"x":0,"y":5}' && tvItem().size.width === 2 && !tvItem().command, "Watch TV: text button placed bottom-left, no target yet");
ok(activities[MUSIC].pages[0].grid.height === 1 && !musicItem() && activities[MUSIC].pages[0].items.length === 1, "Play Music: page is full, so it's left exactly as it was (no row added, no button)");
ok(/no free spot/.test(drvLog), "the log says why Play Music got no on-screen button");

// ---- start Watch TV ---------------------------------------------------------------
activities[TV_ACT].state = "ON";
await sleep(1200);
const musicRec = () => activities[MUSIC].buttons.RECORD?.short_press;
ok(musicRec()?.entity_id === TV_ACT && musicRec().cmd_id === "activity.start", "Play Music's ↩ (RECORD, no room on screen) already points at Watch TV (current)");
ok(activities[MUSIC].entity_ids.includes(TV_ACT) && activities[MUSIC].entity_ids.includes("uc_denon_driver.main.media_player.YOUR_RECEIVER_ID"), "Watch TV added to Play Music's devices, existing kept");
ok(!activities[TV_ACT].buttons.RECORD?.short_press, "Watch TV has its ↩ on screen, so its RECORD button is left alone");

// ---- start Play Music (Watch TV stays on) ---------------------------------------
activities[MUSIC].state = "ON";
await sleep(1200);
ok(tvItem()?.command?.entity_id === MUSIC && tvItem().text === "↩ Play Music", "Watch TV's ↩ now points at Play Music");
ok(musicRec()?.entity_id === TV_ACT, "Play Music's ↩ still points at Watch TV (old activity not turned off)");
ok(!activities[TV_ACT].buttons.RECORD?.short_press && activities[TV_ACT].buttons.BACK.short_press.cmd_id === "media_player.back", "Watch TV: RECORD and BACK untouched");
ok((await prevValue()) === "Watch TV", "Previous Activity sensor: Watch TV");

// ---- old one turned off, then started again ---------------------------------------
activities[TV_ACT].state = "OFF";
activities[MUSIC].state = "OFF";
await sleep(700);
activities[TV_ACT].state = "ON";
await sleep(1200);
ok(musicRec()?.entity_id === TV_ACT && tvItem()?.command?.entity_id === MUSIC, "after turning off and back on: still the last two");
ok((await prevValue()) === "Play Music", "Previous Activity sensor: Play Music");

// ---- user moved the button -----------------------------------------------------------
const moved = tvItem();
moved.location = { x: 3, y: 0 };
moved.size = { width: 1, height: 1 };
activities[MUSIC].state = "ON";
await sleep(1200);
ok(activities[TV_ACT].pages[0].items.filter(isReturnItem).length === 1 && tvItem().location.x === 3 && tvItem().command.entity_id === MUSIC, "a moved ↩ button is kept where the user put it and still updated");

// ---- icon style on a fresh page ------------------------------------------------------
activities[TV_ACT].pages[0].items = [];
r = await returnSetup({ host_0: "false", host_1: "true", screen: "icon", button: "NONE", press: "short_press" });
const icon = activities[TV_ACT].pages[0].items.find(isReturnItem);
ok(r.after?.msg_data.state === "OK" && icon?.type === "icon" && icon.icon === "uc:back" && icon.size.width === 1 && icon.command?.entity_id === MUSIC, "icon style: back-arrow icon placed and pointed at Play Music");

// ---- survives a restart -----------------------------------------------------------------
drv.kill();
ws.terminate();
await sleep(400);
const saved = JSON.parse(fs.readFileSync(path.join(cfgDir, "return.json"), "utf8"));
ok(saved.history[0] === MUSIC && saved.cfg.hosts.join() === TV_ACT && saved.cfg.screen === "icon", "history and settings saved to return.json");
drv = spawn(process.execPath, ["driver.js"], { cwd: binDir, env, stdio: ["ignore", "pipe", "pipe"] });
drv.stdout.on("data", (d) => (drvLog += d));
await sleep(1200);
await connect();
send("connect");
await sleep(600);
activities[MUSIC].state = "OFF";
await sleep(600);
activities[MUSIC].state = "ON";
await sleep(1200);
ok(activities[TV_ACT].pages[0].items.find(isReturnItem)?.command?.entity_id === MUSIC, "after restart it keeps tracking");

// ---- builder: the same settings over HTTP -------------------------------------------------
{
  const WEB = "http://127.0.0.1:10933";
  let cookie = "";
  const http = async (method, url, body) => {
    const res = await fetch(WEB + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
  let h = await http("GET", "/api/return");
  ok(h.status === 401, "builder: return settings need a login");
  await http("POST", "/api/login", { pin: "1234" });
  h = await http("GET", "/api/return");
  ok(h.status === 200 && h.data.cfg.hosts.join() === TV_ACT && h.data.activities.length === 2 && h.data.current, "builder: reads the ↩ settings, activities and current activity");
  h = await http("POST", "/api/return", { hosts: [TV_ACT], screen: "none", button: "NONE" });
  ok(h.status === 422 && /on-screen button, a physical button/.test(h.data.errors[0]), "builder: nothing to show is refused");
  h = await http("POST", "/api/return", { hosts: [TV_ACT, MUSIC, "uc.main.bogus"], screen: "icon", button: "RECORD", press: "long_press", buttonScope: "nofit" });
  ok(h.status === 200 && h.data.cfg.hosts.join() === `${TV_ACT},${MUSIC}` && h.data.cfg.press === "long_press" && h.data.cfg.buttonScope === "nofit", "builder: saving ticks activities (unknown ones dropped) and applies the settings");
  await sleep(400);
  ok(activities[MUSIC].buttons.RECORD?.long_press?.cmd_id === "activity.start", "builder: Play Music (no room on screen) got RECORD long press");

  // ---- per-activity settings: custom picture, own button, turn off when leaving ------------------
  h = await http("GET", "/api/return");
  ok(h.data.groups.length === 2 && h.data.groups[0].name === "Living room AV" && TV_ACT in h.data.targets, "builder: lists the remote's activity groups and each ↩'s target");
  h = await http("POST", "/api/return", { hosts: [TV_ACT, MUSIC], group: "g_av", hostCfg: {
    [TV_ACT]: { screen: "custom", button: "NONE" } } });
  ok(h.status === 422 && /drop a picture/.test(h.data.errors[0]), "builder: custom look without a picture is refused");
  h = await http("POST", "/api/return", { hosts: [TV_ACT, MUSIC], group: "g_av", hostCfg: {
    [TV_ACT]: { screen: "custom", icon: "custom:ret_back.png", button: "BACK", press: "long_press", close: true },
    [MUSIC]: { screen: "none", button: "STOP", press: "short_press", close: true } } });
  await sleep(500);
  const tvRet = activities[TV_ACT].pages[0].items.find((it) => isReturnItem(it, ["custom:ret_back.png"]));
  ok(h.status === 200 && tvRet?.type === "icon" && tvRet.icon === "custom:ret_back.png", "Watch TV: the ↩ button now shows the custom picture (same spot): " + JSON.stringify(tvRet?.location));
  ok(activities[TV_ACT].buttons.BACK?.long_press?.cmd_id === "activity.start" && activities[TV_ACT].buttons.BACK.short_press?.cmd_id === "media_player.back", "Watch TV: its own button (BACK long press); BACK short press untouched");
  ok(activities[MUSIC].buttons.STOP?.short_press?.cmd_id === "activity.start", "Play Music: its own button (STOP short press)");
  const av = groups.find((g) => g.group_id === "g_av");
  ok(av.activity_ids.includes(TV_ACT) && av.activity_ids.includes(MUSIC), "turn off when leaving: both activities put in the chosen activity group");
  ok(groups.find((g) => g.group_id === "g_other").activity_ids.join() === "uc.main.ro", "other groups left alone");
  h = await http("POST", "/api/return", { hosts: [TV_ACT, MUSIC], group: "g_av", hostCfg: {
    [TV_ACT]: { screen: "text", button: "NONE", close: false },
    [MUSIC]: { screen: "none", button: "STOP", close: true } } });
  await sleep(500);
  ok(!av.activity_ids.includes(TV_ACT) && av.activity_ids.includes(MUSIC), "unticking 'turn off' takes Watch TV out of the group again");
  ok(activities[TV_ACT].pages[0].items.find(isReturnItem)?.type === "text", "Watch TV: back to a text ↩ button");
}

// ---- turn off ---------------------------------------------------------------------------
r = await returnSetup({ host_0: "false", host_1: "false", screen: "text", button: "NONE", press: "short_press" });
ok(r.after?.msg_data.state === "OK" && JSON.parse(fs.readFileSync(path.join(cfgDir, "return.json"), "utf8")).cfg.hosts.length === 0, "unticking every activity turns it off");

drv.kill();
ws.terminate();
srv.close();
fs.rmSync(path.join(binDir, "driver.json"));
console.log("\n--- driver log (return lines) ---\n" + drvLog.split("\n").filter((l) => /return/i.test(l)).slice(0, 25).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
