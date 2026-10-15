// Plays the remote's side of the Integration-API against the driver, with a fake Core API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, patches, cfg } from "./mock-core.js";

const CORE_PORT = 18080;
const WS_PORT = 19090;
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-"));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const drv = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10931" },
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
let id = 1;
const req = (msg, msg_data) => new Promise((r) => {
  const rid = id++;
  pending.set(rid, r);
  ws.send(JSON.stringify({ kind: "req", id: rid, msg, msg_data }));
});
const send = (msg, msg_data) => ws.send(JSON.stringify({ kind: "event", msg, msg_data, cat: "DEVICE" }));

// --- before setup
let r = await req("get_driver_version");
ok(r.msg === "driver_version" && r.msg_data.version.driver === "0.6.0", "driver_version 0.6.0");
send("connect");
await sleep(300);
r = await req("get_device_state");
ok(r.msg_data.state === "DISCONNECTED", "device DISCONNECTED before setup (" + r.msg_data.state + ")");

// --- setup with wrong PIN
events.length = 0;
await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
const ask = events.find((e) => e.msg === "driver_setup_change" && e.msg_data.state === "WAIT_USER_ACTION");
const fields = ask?.msg_data?.require_user_action?.input?.settings?.map((x) => x.id + ":" + Object.keys(x.field)[0]).join(",");
ok(fields === "pin:text,address:text", "screen 2 asks for pin + address as text fields (" + fields + ")");
await req("set_driver_user_data", { input_values: { pin: "0000", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
const errEv = events.find((e) => e.msg === "driver_setup_change" && e.msg_data.state === "ERROR");
ok(errEv && errEv.msg_data.error === "AUTHORIZATION_ERROR", "wrong PIN -> AUTHORIZATION_ERROR");

// --- setup with right PIN
events.length = 0;
await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { pin: "1234", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
ok(events.some((e) => e.msg === "driver_setup_change" && e.msg_data.state === "OK"), "setup completes (state OK)");
const saved = JSON.parse(fs.readFileSync(path.join(cfgDir, "self_control.json"), "utf8"));
ok(saved.apiKey === "test-api-key-abc" && !("pin" in saved), "API key saved, PIN not stored");

// --- entities
r = await req("get_available_entities");
const avail = r.msg_data.available_entities;
const ids = avail.map((e) => e.entity_id).sort();
console.log("     entities:", ids.join(", "));
ok(avail.length === 17, "17 entities offered (14 settings + Smart Test Button + result sensor + Previous Activity)");
ok(avail.find((e) => e.entity_id === "previous_activity")?.area === "Remote Navigation" && avail.find((e) => e.entity_id === "previous_activity")?.entity_type === "sensor", "Previous Activity sensor in Remote Navigation");
ok(avail.filter((e) => e.area === "Remote Smart Controls").length === 2, "2 entities in area Remote Smart Controls");
const order = avail.slice(0, 14).map((e) => e.entity_id).join(",");
ok(order === "display_level,display_brightness,display_timeout,display_auto_brightness,backlight_level,backlight_color,backlight,backlight_auto,sound_volume,wake_sensitivity,sleep_timeout,wake_on_wlan,sound_effects,haptic", "entities in requested order");
const areaOf = Object.fromEntries(avail.map((e) => [e.entity_id, e.area]));
ok(areaOf.display_level === "Remote Display" && areaOf.display_auto_brightness === "Remote Display" && areaOf.backlight_auto === "Remote Buttons" && areaOf.backlight === "Remote Buttons" && areaOf.wake_on_wlan === "Remote Settings" && areaOf.haptic === "Remote Settings", "areas: Remote Display / Buttons / Settings");
const nameOf = Object.fromEntries(avail.map((e) => [e.entity_id, e.name.en]));
ok(nameOf.wake_on_wlan === "Wake on LAN" && nameOf.display_level === "Display Brightness Level" && nameOf.backlight === "Button Backlight", "new names");
ok(avail.find((e) => e.entity_id === "display_brightness")?.entity_type === "light" && avail.find((e) => e.entity_id === "display_brightness")?.features.includes("dim") && !ids.includes("debug_last_command"), "Display Brightness light (dim, for the touch slider) present; debug sensor gone");
await req("subscribe_events", { entity_ids: ids });
send("connect");
await sleep(800);
r = await req("get_entity_states");
const st = Object.fromEntries(r.msg_data.map((e) => [e.entity_id, e.attributes]));
ok(st.backlight.state === "ON" && st.backlight.brightness === 255, "backlight ON at 255 (100%)");
ok(st.backlight.hue === 219 && st.backlight.saturation > 120, `backlight color from rgb [127,172,255] -> hue ${st.backlight.hue}, sat ${st.backlight.saturation}`);
ok(st.sleep_timeout.current_option === "2 min", "sleep timeout shows 2 min");
ok(st.wake_sensitivity.current_option === "Medium", "wake sensitivity Medium");
ok(st.sound_volume.current_option === "80 %", "volume 80 %");
ok(st.backlight_color.current_option === "Ice blue" && st.backlight_color.options.includes("Movie red"), "backlight color select shows Ice blue");
ok(st.backlight_level.current_option === "100 %" && st.display_level.current_option === "50 %", "level selects show 100 % / 50 %");
ok(st.wake_on_wlan.state === "ON" && st.haptic.state === "ON", "switches ON");
r = await req("get_device_state");
ok(r.msg_data.state === "CONNECTED", "device CONNECTED after setup");

// --- commands
const cmd = async (entity_id, entity_type, cmd_id, params) => (await req("entity_command", { entity_id, entity_type, cmd_id, params })).code;
patches.length = 0; events.length = 0;
let code = await cmd("backlight", "light", "on", { hue: 0, saturation: 255, brightness: 128 });
ok(code === 200, "backlight on red 50% -> 200");
ok(JSON.stringify(patches.at(-1)) === JSON.stringify({ section: "button", body: { brightness: 50, static_color: { rgb: [255, 0, 0] } } }), "  sends PATCH /cfg/button {brightness:50, rgb:[255,0,0]} : " + JSON.stringify(patches.at(-1)));
await sleep(600);
ok(events.some((e) => e.msg === "entity_change" && e.msg_data.entity_id === "backlight"), "  entity_change sent for backlight");

code = await cmd("backlight", "light", "off");
ok(code === 200 && patches.at(-1).body.brightness === 0, "backlight off -> brightness 0");
code = await cmd("backlight", "light", "toggle");
ok(code === 200 && patches.at(-1).body.brightness === 50, "backlight toggle -> back to last level 50");

code = await cmd("display_level", "select", "select_option", { option: "100 %" });
ok(code === 200 && JSON.stringify(patches.at(-1).body) === JSON.stringify({ brightness: 100, auto_brightness: false }), "display level 100 % sends brightness+auto_brightness:false: " + JSON.stringify(patches.at(-1).body));
code = await cmd("display_auto_brightness", "switch", "on");
ok(code === 200 && patches.at(-1).body.auto_brightness === true && patches.at(-1).body.brightness === 100, "display auto on keeps brightness in body");

// touch slider on the Display Brightness light
code = await cmd("display_brightness", "light", "on", { brightness: 64 });
ok(code === 200 && JSON.stringify(patches.at(-1)) === JSON.stringify({ section: "display", body: { brightness: 25, auto_brightness: false } }), "display light brightness 64/255 -> 25 %, auto off: " + JSON.stringify(patches.at(-1)));
code = await cmd("display_brightness", "light", "off");
ok(code === 200 && patches.at(-1).body.brightness === 1, "display light off -> dimmest (1 %)");
code = await cmd("display_brightness", "light", "on");
ok(code === 200 && patches.at(-1).body.brightness === 25, "display light on -> back to last level 25 %");
code = await cmd("display_brightness", "light", "on", { brightness: 255 });
ok(code === 200 && patches.at(-1).body.brightness === 100, "display light 255 -> 100 %");
code = await cmd("haptic", "switch", "toggle");
ok(code === 200 && JSON.stringify(patches.at(-1)) === JSON.stringify({ section: "haptic", body: { enabled: false } }), "haptic toggle -> off");
code = await cmd("sound_effects", "switch", "off");
ok(code === 200 && patches.at(-1).body.enabled === false && patches.at(-1).body.volume === 80, "sound off (volume kept in body)");
code = await cmd("wake_on_wlan", "switch", "off");
ok(code === 200 && JSON.stringify(patches.at(-1)) === JSON.stringify({ section: "network", body: { wifi: { wake_on_wlan: { enabled: false } } } }), "wake on WLAN off -> network.wifi.wake_on_wlan");
code = await cmd("backlight_auto", "switch", "off");
ok(code === 200 && JSON.stringify(patches.at(-1).body) === JSON.stringify({ auto_brightness: false }), "backlight auto off");

code = await cmd("sleep_timeout", "select", "select_option", { option: "10 min" });
ok(code === 200 && patches.at(-1).body.standby_sec === 600 && patches.at(-1).body.display_off_sec === 15, "sleep timeout 10 min -> standby_sec 600 (others kept)");
code = await cmd("display_timeout", "select", "select_next");
ok(code === 200 && patches.at(-1).body.display_off_sec === 20, "display timeout next -> 20 s");
code = await cmd("wake_sensitivity", "select", "select_first");
ok(code === 200 && patches.at(-1).body.wakeup_sensitivity === 0, "wake sensitivity first -> Off (0)");
code = await cmd("sound_volume", "select", "select_option", { option: "30 %" });
ok(code === 200 && patches.at(-1).body.volume === 30, "volume 30 %");
code = await cmd("sound_volume", "select", "select_option", { option: "banana" });
ok(code === 400, "unknown option -> 400");

// editor-style commands (macro editor: light.dim / light.color in percent)
code = await cmd("backlight", "light", "light.dim", { brightness: "25" });
ok(code === 200 && patches.at(-1).body.brightness === 25, "backlight 'light.dim' \"25\" (string, percent) -> 25 %");
code = await cmd("backlight", "light", "color", { hue: 120, saturation: 100 });
ok(code === 200 && JSON.stringify(patches.at(-1).body.static_color) === JSON.stringify({ rgb: [0, 255, 0] }), "backlight 'color' hue 120 sat 100% -> green: " + JSON.stringify(patches.at(-1).body));
code = await cmd("backlight", "light", "light.on", { brightness: 255 });
ok(code === 200 && patches.at(-1).body.brightness === 100, "backlight 'light.on' 255 -> 100 %");
code = await cmd("haptic", "switch", "switch.on");
ok(code === 200 && patches.at(-1).body.enabled === true, "'switch.on' prefix accepted");
code = await cmd("sound_volume", "select", "select.select_option", { option: "30 %" });
ok(code === 200, "'select.select_option' prefix accepted");
await sleep(300);
r = await req("get_entity_states");

// macro-friendly selects
code = await cmd("backlight_color", "select", "select_option", { option: "Movie red" });
ok(code === 200 && JSON.stringify(patches.at(-1)) === JSON.stringify({ section: "button", body: { static_color: { rgb: [255, 30, 20] } } }), "backlight color 'Movie red' -> rgb [255,30,20]");
code = await cmd("backlight_level", "select", "select_option", { option: "Off" });
ok(code === 200 && JSON.stringify(patches.at(-1).body) === JSON.stringify({ brightness: 0 }), "backlight level Off -> 0");
code = await cmd("backlight_level", "select", "select_option", { option: "60 %" });
ok(code === 200 && patches.at(-1).body.brightness === 60, "backlight level 60 % -> 60");
code = await cmd("display_level", "select", "select_option", { option: "30 %" });
ok(code === 200 && patches.at(-1).body.brightness === 30 && patches.at(-1).body.auto_brightness === false, "display level 30 % -> 30, auto off");
await sleep(600);
r = await req("get_entity_states");
const st3 = Object.fromEntries(r.msg_data.map((e) => [e.entity_id, e.attributes]));
ok(st3.backlight_color.current_option === "Movie red" && st3.backlight_level.current_option === "60 %", "selects follow the changes");

await sleep(700);
r = await req("get_entity_states");
const st2 = Object.fromEntries(r.msg_data.map((e) => [e.entity_id, e.attributes]));
ok(st2.sleep_timeout.current_option === "10 min" && st2.haptic.state === "ON" && st2.sound_volume.current_option === "30 %", "states follow the changes");
ok(cfg.button.static_color.rgb.join() === "255,30,20", "fake remote now has red backlight");

// --- restart: driver reloads its saved key
drv.kill();
await sleep(300);
ws.terminate();
const drv2 = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10931" },
  stdio: ["ignore", "pipe", "pipe"]
});
let log2 = "";
drv2.stdout.on("data", (d) => (log2 += d));
await sleep(1200);
ok(/loaded configuration/.test(log2), "after restart the saved API key is loaded");
drv2.kill();

srv.close();
fs.rmSync(path.join(binDir, "driver.json"));
console.log("\n--- driver log (first run) ---\n" + drvLog.split("\n").slice(0, 40).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
