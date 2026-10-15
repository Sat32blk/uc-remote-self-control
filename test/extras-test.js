// End-to-end test of virtual sliders and quick menus: driver + fake Core API + fake remote + builder HTTP API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, devices, commands, selfEntities, entityIcons, activities, TV, MARANTZ } from "./mock-core.js";
import { snap, toBrightness, fromBrightness, validateExtras, Extras } from "../src/bin/extras.js";

const CORE_PORT = 18084;
const WS_PORT = 19098;
const WEB = "http://127.0.0.1:10935";
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-extras-"));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers ----------------------------------------------------------------
const r080 = { min: 0, max: 80, step: 1 };
ok(snap(40.4, r080) === 40 && snap(-3, r080) === 0 && snap(99, r080) === 80, "values snap to the step and stay in range");
ok(snap(21.26, { min: 16, max: 30, step: 0.5 }) === 21.5, "half steps work (16–30 °C)");
ok(toBrightness(40, r080) === 128 && toBrightness(0, r080) === 0 && toBrightness(80, r080) === 255, "value → slider position");
ok(fromBrightness(128, r080) === 40 && fromBrightness(255, r080) === 80, "slider position → value");
let v = validateExtras({ sliders: [{ id: "bad", name: "", entity: "x", min: 5, max: 1 }], menus: [{ id: "menu_x", name: "M", options: [] }] });
ok(v.errors.length >= 5, "validation lists what's wrong: " + v.errors.slice(0, 3).join(" | "));
v = validateExtras({ menus: [{ id: "menu_a", name: "A", options: [{ label: "X", do: [{ cmd: "media_player.on", entity: TV }] }, { label: "x", do: [{ delay: 1 }] }] }] });
ok(v.errors.some((e) => /used twice/.test(e)), "duplicate choice labels refused");
v = validateExtras({ sliders: [{ id: "slider_a", name: "A", entity: TV, mode: "steps", up: "media_player.volume_up", down: "media_player.volume_down" }] }, [], ["slider_a"]);
ok(v.errors.some((e) => /used twice/.test(e)), "ids already used by other entities are refused");

// latest value wins: a slow device gets the first and the last value, not every step of a drag
{
  const sent = [];
  const slowCore = { request: async (m, url, body) => { sent.push(body.params.volume); await sleep(80); }, get: async () => ({}) };
  const x = new Extras({ getCore: () => slowCore, engine: () => null, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-x-")), "x.json"), publish: () => {}, log: () => {}, warn: () => {} });
  x.replace({ sliders: [{ id: "slider_v", name: "V", entity: "a.b", attr: "", min: 0, max: 100, step: 1, mode: "command", cmd: "media_player.volume", param: "volume" }], menus: [] });
  for (const val of [10, 20, 30, 40, 50]) x.setValue("slider_v", val);
  await x.setValue("slider_v", 60);
  ok(sent.join() === "10,60" && x.values.slider_v === 60, "fast drag on a slow device: only the first and last values are sent (" + sent.join() + ")");
}

// ---- driver -------------------------------------------------------------------------
devices[MARANTZ].state = "ON";
devices[MARANTZ].volume = 24;
devices[MARANTZ].source = "SHIELD";
devices[TV].volume = 10;
const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const drv = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10935", UC_SELF_RETURN_POLL_MS: "250", UC_SELF_SLIDER_HOLD_MS: "600" },
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
  return { status: res.status, data: await res.json() };
};
let h = await http("GET", "/api/extras");
ok(h.status === 401, "sliders/menus API needs a login");
await http("POST", "/api/login", { pin: "1234" });
h = await http("GET", "/api/extras");
ok(h.status === 200 && h.data.sliders.length === 0 && h.data.menus.length === 0, "nothing defined yet");

// ---- save ----------------------------------------------------------------------------
const config = {
  sliders: [
    { id: "slider_receiver_volume", name: "Receiver Volume", entity: MARANTZ, attr: "volume", min: 0, max: 80, step: 1, mode: "command", cmd: "media_player.volume", param: "volume", icon: "custom:ti_volume.png" },
    { id: "slider_tv_volume", name: "TV Volume", entity: TV, attr: "volume", min: 0, max: 50, step: 1, mode: "steps", up: "media_player.volume_up", down: "media_player.volume_down", per_press: 1, delay: 0 }
  ],
  menus: [
    { id: "menu_receiver_input", name: "Receiver Input", options: [
      { label: "TV", do: [{ cmd: "media_player.select_source", entity: MARANTZ, params: { source: "HDMI1" } }], when: { entity: MARANTZ, attr: "source", is: "HDMI1" } },
      { label: "Shield", do: [{ cmd: "media_player.select_source", entity: MARANTZ, params: { source: "SHIELD" } }], when: { entity: MARANTZ, attr: "source", is: "SHIELD" } },
      { label: "Backlight next", do: [{ self: "backlight_color", option: "next" }] }
    ] }
  ]
};
h = await http("POST", "/api/extras", { ...config, sliders: [{ ...config.sliders[0], id: "slider_x", max: -1 }] });
ok(h.status === 422 && h.data.errors.some((e) => /highest value/.test(e)), "invalid slider refused: " + h.data.errors);
h = await http("POST", "/api/extras", { menus: [{ id: "menu_x", name: "X", options: [{ label: "a", do: [{ self: "nonsense", option: "x" }] }] }] });
ok(h.status === 422 && h.data.errors.some((e) => /unknown control/.test(e)), "unknown control in a menu step refused");
h = await http("POST", "/api/extras", config);
ok(h.status === 200 && h.data.sliders.length === 2 && h.data.menus.length === 1, "sliders and menu saved");
ok(JSON.parse(fs.readFileSync(path.join(cfgDir, "sliders_menus.json"), "utf8")).sliders.length === 2, "saved in sliders_menus.json");
await sleep(300);
ok(!entityIcons["self_control.main.slider_receiver_volume"], "tile icon not set while the slider isn't added to the integration yet");
selfEntities.slider_receiver_volume = "Receiver Volume"; // the user adds it in the web configurator

let r = await req("get_available_entities");
const avail = r.msg_data.available_entities;
const rv = avail.find((e) => e.entity_id === "slider_receiver_volume");
const mi = avail.find((e) => e.entity_id === "menu_receiver_input");
ok(rv?.entity_type === "light" && rv.features.includes("dim") && rv.area === "Remote Sliders & Menus", "slider is a dimmable light in its own group");
ok(mi?.entity_type === "select" && mi.area === "Remote Sliders & Menus", "menu is a select in the same group");
await req("subscribe_events", { entity_ids: ["slider_receiver_volume", "slider_tv_volume", "menu_receiver_input"] });
await sleep(400);
ok(entityIcons["self_control.main.slider_receiver_volume"] === "custom:ti_volume.png", "after adding it, the slider's tile icon is set on the remote");
h = await http("POST", "/api/extras", { ...config, sliders: [{ ...config.sliders[0], icon: "bad icon" }] });
ok(h.status === 422 && h.data.errors.some((e) => /icon must be/.test(e)), "invalid tile icon refused");
const states = async () => Object.fromEntries((await req("get_entity_states")).msg_data.map((e) => [e.entity_id, e.attributes]));
const cmd = async (entity_id, entity_type, cmd_id, params) => (await req("entity_command", { entity_id, entity_type, cmd_id, params })).code;

await sleep(800);
let s = await states();
ok(s.slider_receiver_volume.brightness === toBrightness(24, r080) && s.slider_receiver_volume.state === "ON", "slider follows the receiver's volume (24 of 80)");
ok(s.menu_receiver_input.current_option === "Shield", "menu shows the current input (Shield) from its condition");
ok(JSON.stringify(s.menu_receiver_input.options) === JSON.stringify(["TV", "Shield", "Backlight next"]), "menu lists its choices");

// ---- command-mode slider -------------------------------------------------------------------
commands.length = 0;
ok((await cmd("slider_receiver_volume", "light", "on", { brightness: 128 })) === 200, "slider drag accepted");
await sleep(300);
ok(devices[MARANTZ].volume === 40 && commands.some((c) => c.cmd_id === "media_player.volume" && c.params.volume === 40), "dragging to the middle sets the receiver volume to 40 in one command");
ok((await cmd("slider_receiver_volume", "light", "light.dim", { brightness: 25 })) === 200, "percent form (light.dim) accepted");
await sleep(300);
ok(devices[MARANTZ].volume === 20, "dim 25 % = volume 20");
await cmd("slider_receiver_volume", "light", "off");
await sleep(300);
ok(devices[MARANTZ].volume === 0 && (await states()).slider_receiver_volume.state === "OFF", "off = lowest value");
await cmd("slider_receiver_volume", "light", "on");
await sleep(300);
ok(devices[MARANTZ].volume === 20, "on = back to the last value (20)");
devices[MARANTZ].volume = 60;
await sleep(1200);
ok((await states()).slider_receiver_volume.brightness === toBrightness(60, r080), "volume changed elsewhere: the slider follows");

// latest value wins while dragging
commands.length = 0;
for (const b of [30, 60, 90, 120, 200]) await cmd("slider_receiver_volume", "light", "on", { brightness: b });
await sleep(400);
const sent = commands.filter((c) => c.cmd_id === "media_player.volume").map((c) => c.params.volume);
ok(devices[MARANTZ].volume === fromBrightness(200, r080) && sent[sent.length - 1] === fromBrightness(200, r080), `fast drag: ends on the last value (${sent.join(", ")})`);

// ---- steps-mode slider ---------------------------------------------------------------------
commands.length = 0;
await cmd("slider_tv_volume", "light", "on", { brightness: toBrightness(15, { min: 0, max: 50 }) });
await sleep(500);
ok(devices[TV].volume === 15 && commands.filter((c) => c.cmd_id === "media_player.volume_up").length === 5, "steps slider: TV 10 → 15 with 5 volume-up presses");
commands.length = 0;
await cmd("slider_tv_volume", "light", "on", { brightness: toBrightness(12, { min: 0, max: 50 }) });
await sleep(500);
ok(devices[TV].volume === 12 && commands.filter((c) => c.cmd_id === "media_player.volume_down").length === 3, "steps slider: 15 → 12 with 3 volume-down presses");

// ---- menu --------------------------------------------------------------------------------------
commands.length = 0;
ok((await cmd("menu_receiver_input", "select", "select_option", { option: "TV" })) === 200, "menu choice accepted");
await sleep(400);
ok(devices[MARANTZ].source === "HDMI1" && (await states()).menu_receiver_input.current_option === "TV", "picking TV switches the receiver to HDMI1 and shows TV");
devices[MARANTZ].source = "SHIELD";
await sleep(2000);
ok((await states()).menu_receiver_input.current_option === "Shield", "input changed elsewhere: menu shows Shield");
devices[MARANTZ].source = "HDMI2";
await sleep(1200);
ok((await states()).menu_receiver_input.current_option === "", "input with no matching choice: menu shows nothing");
await cmd("menu_receiver_input", "select", "select_last");
await sleep(300);
ok((await states()).menu_receiver_input.current_option === "Backlight next", "select_last runs the last choice (a remote control step)");
ok((await cmd("menu_receiver_input", "select", "select_option", { option: "Nope" })) !== 200, "unknown choice refused");

// ---- step through the choices (select next) -------------------------------------------------------
devices[MARANTZ].source = "HDMI2"; // no choice matches
await sleep(1500);
await cmd("menu_receiver_input", "select", "select_next");
await sleep(300);
ok((await states()).menu_receiver_input.current_option === "TV" && devices[MARANTZ].source === "HDMI1", "select next with nothing current: runs choice 1 (TV)");
await sleep(1500);
await cmd("menu_receiver_input", "select", "select_next");
await sleep(300);
ok(devices[MARANTZ].source === "SHIELD", "next press: choice 2 (Shield)");
await sleep(1500);
await cmd("menu_receiver_input", "select", "select_next");
await sleep(300);
ok((await states()).menu_receiver_input.current_option === "Backlight next", "next press: choice 3");
await cmd("menu_receiver_input", "select", "select_next");
await sleep(300);
ok(devices[MARANTZ].source === "HDMI1", "after the last choice it starts over at choice 1 (cycle is on by default)");

// ---- physical button for the menu ----------------------------------------------------------------
const menuWithButton = { ...config.menus[0], button: { activity: "uc.main.act1", button: "RECORD", press: "long_press" } };
h = await http("POST", "/api/extras", { ...config, menus: [menuWithButton] });
ok(h.status === 200 && h.data.status.menu_receiver_input.error && /add the menu to the integration first/.test(h.data.status.menu_receiver_input.error), "button needs the menu added to the integration first: " + h.data.status.menu_receiver_input.error);
selfEntities.menu_receiver_input = "Receiver Input";
h = await http("POST", "/api/extras", { ...config, menus: [{ ...menuWithButton, name: "Receiver Input " }] });
ok(activities["uc.main.act1"].buttons.RECORD.long_press?.entity_id === "self_control.main.menu_receiver_input" && activities["uc.main.act1"].buttons.RECORD.long_press.cmd_id === "select.select_next", "saving maps RECORD (long press) in Watch TV to the menu's select next");
ok(activities["uc.main.act1"].entity_ids.includes("self_control.main.menu_receiver_input"), "the menu was added to the activity's devices");
h = await http("GET", "/api/buttons?activity=uc.main.act1");
ok(h.status === 200 && h.data.buttons.some((b) => b.button === "RECORD" && b.long === "self_control.main.menu_receiver_input"), "builder can list the activity's buttons and what they do");
h = await http("POST", "/api/extras", config);
ok(!activities["uc.main.act1"].buttons.RECORD.long_press, "removing the button from the menu unmaps it again");
h = await http("POST", "/api/extras", { ...config, menus: [{ ...config.menus[0], button: { activity: "uc.main.act1", button: "bad button" } }] });
ok(h.status === 422, "invalid button refused");

// ---- builder test endpoint ---------------------------------------------------------------------
h = await http("POST", "/api/extras/test", { id: "slider_receiver_volume", value: 33 });
ok(h.status === 200 && devices[MARANTZ].volume === 33 && /set to 33/.test(h.data.summary), "builder test: slider set to 33");
h = await http("POST", "/api/extras/test", { id: "menu_receiver_input", option: "Shield" });
ok(h.status === 200 && devices[MARANTZ].source === "SHIELD" && /Receiver Input → Shield/.test(h.data.summary), "builder test: menu choice run: " + h.data.summary);
h = await http("POST", "/api/extras/test", { id: "slider_nope", value: 1 });
ok(h.status === 404, "test of an unsaved slider refused");
h = await http("GET", "/api/extras");
ok(h.data.status.slider_receiver_volume.value === 33 && h.data.status.menu_receiver_input.current === "Shield", "status shows current values");

// ---- removing ----------------------------------------------------------------------------------
h = await http("POST", "/api/extras", { sliders: [], menus: [] });
r = await req("get_available_entities");
ok(h.status === 200 && !r.msg_data.available_entities.some((e) => /^(slider|menu)_/.test(e.entity_id)), "removed sliders and menus disappear from the entity list");

drv.kill();
ws.terminate();
srv.close();
fs.rmSync(path.join(binDir, "driver.json"));
console.log("\n--- driver log (slider/menu lines) ---\n" + drvLog.split("\n").filter((l) => /slider|menu|Receiver Input/i.test(l)).slice(0, 14).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
