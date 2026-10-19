// End-to-end test of Smart Controls and the builder web server:
// driver + fake Core API + fake remote WebSocket client + HTTP calls to the builder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, cfg, devices, commands, activities, selfEntities, SHIELD, TV, MARANTZ } from "./mock-core.js";
import { validateRules } from "../src/bin/smart.js";

const CORE_PORT = 18081;
const WS_PORT = 19095;
const WEB_PORT = 10932;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-smart-"));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "PASS " : "FAIL ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure validation checks ----------------------------------------------
const def = JSON.parse(fs.readFileSync("src/bin/default-rules.json", "utf8"));
const mine = JSON.parse(fs.readFileSync("examples/shield-tv-receiver-rules.json", "utf8"));
const remoteOnly = JSON.parse(fs.readFileSync("examples/remote-only-rules.json", "utf8"));
ok(validateRules(def, []).errors.length === 0, "default rules are valid");
ok(validateRules(mine, []).errors.length === 0, "examples/shield-tv-receiver-rules.json is valid");
ok(validateRules(remoteOnly, []).errors.length === 0, "examples/remote-only-rules.json is valid");
ok(def.buttons.length === 1 && def.buttons[0].name === "Smart Test Button", "the default is one Smart Test Button");
ok(!JSON.stringify(def).includes("_driver."), "default rules name no specific devices");
ok(validateRules("{nope", []).errors[0].startsWith("Not valid JSON"), "bad JSON reported");
const bad = validateRules({ aliases: {}, buttons: [{ id: "X", name: "", cases: [{ if: { entity: "ghost", is: 1 }, do: [{ cmd: "volume_up", entity: "ghost" }] }, { else: [] }, { else: [] }] }] }, []);
ok(bad.errors.length >= 5, `bad rule gives clear errors (${bad.errors.length}): ${bad.errors.slice(0, 3).join(" | ")}`);
const shortForm = validateRules({ buttons: [{ id: "t1", name: "T", if: { var: "x", is: "1" }, do: [{ delay: 1 }], else: [{ stop: true }] }] }, []);
ok(shortForm.errors.length === 0 && shortForm.rules.buttons[0].cases.length === 2, "short if/do/else form is accepted");

// ---- driver ------------------------------------------------------------
const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const drv = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: String(WEB_PORT) },
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
const req = (msg, msg_data) => new Promise((r) => { const rid = id++; pending.set(rid, r); ws.send(JSON.stringify({ kind: "req", id: rid, msg, msg_data })); });
const send = (msg) => ws.send(JSON.stringify({ kind: "event", msg, cat: "DEVICE" }));
const lastSetup = () => [...events].reverse().find((e) => e.msg === "driver_setup_change");

// ---- builder before setup -------------------------------------------------
let cookie = "";
const http = async (method, url, body, { raw = false, ctype = "application/json" } = {}) => {
  const res = await fetch(WEB + url, { method, headers: { ...(body !== undefined ? { "Content-Type": ctype } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};
let h = await http("GET", "/");
ok(h.status === 200 && /Remote Self-Control Builder/.test(h.data) && h.headers.get("x-frame-options") === "DENY", "builder page is served on its own port");
h = await http("GET", "/api/session");
ok(h.data.loggedIn === false && h.data.configured === false, "session: logged out, integration not set up yet");
ok(/Smart Controls builder: .*:10932\//.test(drvLog), "driver log shows the builder address");

// setup (PIN)
await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { pin: "1234", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
ok(lastSetup()?.msg_data.state === "OK", "PIN setup OK");

// reconfigure menu shows where the builder is
events.length = 0;
await req("setup_driver", { reconfigure: true, setup_data: {} });
await sleep(400);
const menu = lastSetup()?.msg_data.require_user_action?.input?.settings || [];
ok(menu.some((s) => s.field?.label && /10932/.test(JSON.stringify(s.field.label))), "setup menu shows the builder address");
await req("set_driver_user_data", { input_values: { action: "done" } });
await sleep(900);

let r = await req("get_available_entities");
const avail = r.msg_data.available_entities;
const smartIds = avail.filter((e) => e.area === "Remote Smart Controls").map((e) => e.entity_id);
console.log("     smart entities:", smartIds.join(", "));
ok(smartIds.join() === "smart_test_button,smart_last_result", "Remote Smart Controls starts with Smart Test Button + last-result sensor");
ok(avail.find((e) => e.entity_id === "smart_test_button")?.entity_type === "button" && avail.find((e) => e.entity_id === "smart_test_button")?.name?.en === "Smart Test Button", "Smart Test Button is a button entity");
ok(avail.find((e) => e.entity_id === "smart_last_result")?.name?.en === "Smart Controls: Last Result", "sensor name");
await req("subscribe_events", { entity_ids: avail.map((e) => e.entity_id) });
send("connect");
await sleep(600);

const press = async (eid, wait = 500) => {
  const res = await req("entity_command", { entity_id: eid, entity_type: "button", cmd_id: "push" });
  await sleep(wait);
  return res.code;
};
const lastResult = async () => {
  const s = await req("get_entity_states");
  return s.msg_data.find((e) => e.entity_id === "smart_last_result")?.attributes?.value;
};
const lastCmd = () => commands.at(-1);

// ---- default Smart Test Button ---------------------------------------------
ok((await press("smart_test_button")) === 200, "press returns 200");
ok(cfg.button.static_color.rgb.join() === "0,230,230", "Smart Test Button: backlight Ice blue -> next preset Cyan");
ok(/Smart Test Button/.test(await lastResult()), "last-result sensor: " + (await lastResult()));
await req("entity_command", { entity_id: "backlight_color", entity_type: "select", cmd_id: "select_option", params: { option: "Ice blue" } });

// load the remote-only examples (the former defaults) through the builder API
await http("POST", "/api/login", { pin: "1234" });
h = await http("GET", "/api/rules");
ok(h.data.defaults === true && JSON.parse(h.data.text).buttons.length === 1, "builder: defaults in use (1 control)");
h = await http("POST", "/api/rules", { rules: remoteOnly });
ok(h.status === 200 && h.data.buttons.length === 7, "remote-only example rules saved (7 controls)");
r = await req("get_available_entities");
await req("subscribe_events", { entity_ids: r.msg_data.available_entities.map((e) => e.entity_id) });
await http("POST", "/api/logout", {});
cookie = "";

// ---- remote-only controls -------------------------------------------------
await press("smart_backlight_color_cycle");
ok(cfg.button.static_color.rgb.join() === "0,230,230", "color cycle: Ice blue -> next preset Cyan: " + cfg.button.static_color.rgb);
await press("smart_backlight_color_cycle");
ok(cfg.button.static_color.rgb.join() === "0,200,160", "color cycle again -> Teal");
cfg.button.static_color.rgb = [235, 240, 255];
await sleep(100);
// cache only updates on poll or own changes: set it back via the select instead
await req("entity_command", { entity_id: "backlight_color", entity_type: "select", cmd_id: "select_option", params: { option: "Cool white" } });
await press("smart_backlight_color_cycle");
ok(cfg.button.static_color.rgb.join() === "255,190,120", "color cycle wraps from the last preset to the first (Warm white)");
await req("entity_command", { entity_id: "backlight_color", entity_type: "select", cmd_id: "select_option", params: { option: "Ice blue" } });

const bl0 = cfg.button.brightness;
await press("smart_backlight_brighter");
ok(cfg.button.brightness === 100 && bl0 === 100, "backlight brighter at 100 % stays at 100 % (no wrap)");
await press("smart_backlight_dimmer");
const bl1 = cfg.button.brightness;
ok(bl1 < 100 && bl1 > 0, "backlight dimmer steps down: " + bl1 + " %");
await press("smart_backlight_brighter");
ok(cfg.button.brightness === 100, "backlight brighter steps back up to 100 %");

const d0 = cfg.display.brightness;
await press("smart_display_brighter");
const d1 = cfg.display.brightness;
ok(d1 > d0 && cfg.display.auto_brightness === false, `display brighter: ${d0} -> ${d1} %, auto off`);
await press("smart_display_dimmer");
ok(cfg.display.brightness < d1, `display dimmer: ${d1} -> ${cfg.display.brightness} %`);
// restore display auto for the night mode check
await req("entity_command", { entity_id: "display_auto_brightness", entity_type: "switch", cmd_id: "on" });
await sleep(200);

// Night mode: saves current settings, applies night look, restores on second press
const before = JSON.stringify({ c: cfg.button.static_color.rgb, b: cfg.button.brightness, d: cfg.display, s: cfg.sound.enabled });
await press("smart_night_mode", 900);
ok(cfg.button.static_color.rgb.join() === "255,30,20" && cfg.button.brightness === 10 && cfg.display.brightness === 30 && cfg.sound.enabled === false, "night mode ON: red 10 %, display 30 %, sound off");
ok(JSON.parse(fs.readFileSync(path.join(cfgDir, "smart_vars.json"), "utf8")).night_mode === "on", "variable night_mode=on persisted");
await press("smart_night_mode", 900);
const after = JSON.stringify({ c: cfg.button.static_color.rgb, b: cfg.button.brightness, d: cfg.display, s: cfg.sound.enabled });
ok(after === before, "night mode OFF restores exactly what was there before: " + after);

// Quiet mode
await press("smart_quiet_mode", 700);
ok(cfg.sound.enabled === false && cfg.haptic.enabled === false, "quiet mode ON: sound effects and haptics off");
await press("smart_quiet_mode", 700);
ok(cfg.sound.enabled === true && cfg.haptic.enabled === true, "quiet mode OFF: both back on");
ok(/Quiet Mode/.test(await lastResult()), "last-result sensor: " + (await lastResult()));

// ---- builder API ------------------------------------------------------------
h = await http("GET", "/api/catalog");
ok(h.status === 401, "catalog needs a login (401)");
h = await http("POST", "/api/login", { pin: "0000" });
ok(h.status === 401 && !cookie, "wrong PIN refused, no session");
h = await http("POST", "/api/login", "pin=1234", { raw: true, ctype: "application/x-www-form-urlencoded" });
ok(h.status === 415, "non-JSON login refused (415)");
h = await http("POST", "/api/login", { pin: "1234" });
ok(h.status === 200 && /^scb_sid=[a-f0-9]{48}$/.test(cookie) && /HttpOnly/.test(h.headers.get("set-cookie")) && /SameSite=Strict/.test(h.headers.get("set-cookie")), "right PIN: HttpOnly SameSite=Strict session cookie");
ok(!fs.readFileSync(path.join(cfgDir, "self_control.json"), "utf8").includes("1234"), "PIN not written to disk");
h = await http("GET", "/api/session");
ok(h.data.loggedIn === true && h.data.configured === true, "session: logged in");

h = await http("GET", "/api/catalog");
const cat = h.data;
ok(h.status === 200 && cat.devices.length === 5, "catalog lists the remote's devices (3 players + 2 activities), not this integration's own: " + cat.devices.map((d) => d.name).join(", "));
const sh = cat.devices.find((d) => d.id === SHIELD);
const mz = cat.devices.find((d) => d.id === MARANTZ);
ok(sh && sh.name === "SHIELD" && sh.commands.some((c) => c.id === "media_player.play_pause") && !sh.commands.some((c) => c.id === "media_player.select_sound_mode"), "commands follow each device's features");
const srcParam = mz?.commands.find((c) => c.id === "media_player.select_source")?.params[0];
ok(srcParam?.key === "source" && srcParam.list.join() === "HDMI1,HDMI2,SHIELD", "select_source offers the device's source list");
ok(mz?.values.sound_mode?.join() === "STEREO,MOVIE,MUSIC" && mz.values.state.includes("OFF") && mz.simple.includes("DIMMER"), "attribute values, states and simple commands listed");
ok(cat.activities.map((a) => a.name).join() === "Play Music,Watch TV", "activities listed");
ok(cat.controls.backlight_color?.options.includes("Movie red") && cat.controls.haptic?.switch === true && cat.settings["sound.volume"], "this remote's controls and settings listed");

h = await http("POST", "/api/validate", { rules: { buttons: [{ id: "Bad id", name: "x", do: [] }] } });
ok(h.status === 200 && h.data.errors.length > 0, "validate reports errors: " + h.data.errors[0]);
h = await http("POST", "/api/rules", { rules: { buttons: [{ id: "Bad id", name: "x", do: [] }] } });
ok(h.status === 422 && h.data.errors.length > 0, "invalid rules not saved (422)");
const big = { buttons: [{ id: "x", name: "x", do: [{ set_var: "a", to: "b".repeat(600 * 1024) }] }] };
h = await http("POST", "/api/rules", { rules: big });
ok(h.status === 413, "oversized body refused (413)");

// Save the device-specific example rules through the builder API
h = await http("POST", "/api/rules", { rules: mine });
ok(h.status === 200 && h.data.buttons.length === 6, "examples/shield-tv-receiver-rules.json saved through the builder (6 controls)");
r = await req("get_available_entities");
const ids2 = r.msg_data.available_entities.map((e) => e.entity_id);
ok(ids2.includes("smart_shield_input") && !ids2.includes("smart_quiet_mode") && ids2.includes("display_level"), "entities rebuilt: new controls present, old ones gone, settings kept");
await req("subscribe_events", { entity_ids: ids2 });
h = await http("GET", "/api/rules");
ok(h.data.defaults === false && JSON.parse(h.data.text).buttons.length === 6, "rules now read back from the saved file");

// Device rules (pressed from the remote)
commands.length = 0;
await press("smart_volume_up");
ok(lastCmd()?.entity === TV && lastCmd()?.cmd_id === "media_player.volume_up", "volume up goes to TV while Marantz is off");
devices[MARANTZ].source = "ROKU";
commands.length = 0;
await press("smart_shield_input", 2200);
ok(devices[MARANTZ].state === "ON" && devices[MARANTZ].source === "SHIELD", "shield input: turns Marantz on, waits for it, selects SHIELD: " + commands.map((c) => c.cmd_id).join(","));
commands.length = 0;
await press("smart_volume_down");
ok(lastCmd()?.entity === MARANTZ, "volume down goes to Marantz once it is on");
await press("smart_play_pause", 300);
ok(devices[SHIELD].state === "PAUSED", "play/pause pauses a playing Shield");

// Test button in the builder
h = await http("POST", "/api/test", { id: "smart_play_pause" });
ok(h.status === 200 && /Smart Play\/Pause|Play/.test(h.data.summary) && devices[SHIELD].state === "PLAYING", "builder Test runs the control and returns its result: " + h.data.summary);
h = await http("POST", "/api/test", { id: "nope" });
ok(h.status === 404, "test of an unknown id -> 404");

// Errors reported
devices[MARANTZ].state = "OFF";
const saveTv = devices[TV];
delete devices[TV];
await press("smart_volume_up");
ok(/ERROR/.test(await lastResult()), "errors are reported in the last-result sensor: " + (await lastResult()));
devices[TV] = saveTv;

// ---- reconfigure textarea still works ---------------------------------------
events.length = 0;
await req("setup_driver", { reconfigure: true, setup_data: {} });
await sleep(400);
await req("set_driver_user_data", { input_values: { action: "rules" } });
await sleep(900);
const ta = lastSetup()?.msg_data.require_user_action?.input?.settings?.find((s) => s.id === "rules");
ok(ta && JSON.parse(ta.field.textarea.value).buttons.length === 6, "setup rules page shows the rules saved from the builder");
const newRules = { aliases: { tv: TV }, buttons: [{ id: "tv_toggle", name: "TV Toggle", if: { entity: "tv", is: "OFF" }, do: [{ cmd: "media_player.on", entity: "tv" }], else: [{ cmd: "media_player.off", entity: "tv" }] }] };
await req("set_driver_user_data", { input_values: { rules: JSON.stringify(newRules) } });
await sleep(900);
ok(lastSetup()?.msg_data.state === "OK", "rules saved from the setup textarea");
await req("subscribe_events", { entity_ids: ["tv_toggle"] });
await press("tv_toggle", 300);
ok(devices[TV].state === "OFF", "new rule works (TV toggled off)");

// reset to defaults
await req("setup_driver", { reconfigure: true, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { action: "reset_rules" } });
await sleep(900);
r = await req("get_available_entities");
ok(r.msg_data.available_entities.some((e) => e.entity_id === "smart_test_button") && !r.msg_data.available_entities.some((e) => e.entity_id === "tv_toggle"), "reset brings back the Smart Test Button");
h = await http("GET", "/api/defaults");
ok(JSON.parse(h.data.text).buttons[0].id === "smart_test_button", "defaults endpoint");

// ---- setup: add the Last Result tile to an activity ------------------------
const tileRun = async (inputs) => {
  events.length = 0;
  await req("setup_driver", { reconfigure: true, setup_data: {} });
  await sleep(400);
  const menuItems = lastSetup()?.msg_data.require_user_action?.input?.settings?.find((x) => x.id === "action")?.field.dropdown.items.map((i) => i.id) || [];
  await req("set_driver_user_data", { input_values: { action: "tile" } });
  await sleep(900);
  const page = lastSetup()?.msg_data.require_user_action?.input?.settings || [];
  if (!inputs) return { menuItems, page };
  await req("set_driver_user_data", { input_values: inputs });
  await sleep(1200);
  return { menuItems, page, after: lastSetup() };
};
let t = await tileRun(null);
ok(t.menuItems.includes("tile"), "setup menu offers 'Add the Last Result tile to an activity'");
const actField = t.page.find((x) => x.id === "activity");
ok(actField && actField.field.dropdown.items.map((i) => i.label.en).join() === "Play Music,Watch TV", "tile page lists editable activities only: " + actField?.field.dropdown.items.map((i) => i.label.en));
ok(t.page.some((x) => x.id === "buttons" && x.field.checkbox), "tile page has 'also add the buttons' checkbox");
await req("set_driver_user_data", { input_values: { activity: "uc.main.act1", buttons: "true" } });
await sleep(1200);
ok(lastSetup()?.msg_data.state === "OK", "tile step completes");
const act = activities["uc.main.act1"];
ok(act.entity_ids.includes(TV) && act.entity_ids.includes("self_control.main.smart_last_result") && act.entity_ids.includes("self_control.main.smart_test_button"), "sensor and button added to the activity's devices; existing ones kept");
let sc = act.pages.filter((p) => p.name === "Smart Controls");
ok(sc.length === 1 && act.pages.length === 2, "new 'Smart Controls' page added; existing page kept");
const tileItem = sc[0]?.items[0];
ok(tileItem?.type === "sensor" && tileItem.sensor.sensor_id === "self_control.main.smart_last_result" && tileItem.size.width === 4, "full-width Last Result tile at the top");
const btnItem = sc[0]?.items[1];
ok(btnItem?.command?.entity_id === "self_control.main.smart_test_button" && btnItem.command.cmd_id === "button.push" && btnItem.text === "Smart Test Button", "Smart Test Button placed under it");
t = await tileRun({ activity: "uc.main.act1", buttons: "false" });
sc = act.pages.filter((p) => p.name === "Smart Controls");
ok(t.after?.msg_data.state === "OK" && sc.length === 1 && sc[0].items.length === 1, "running again replaces the page (now without buttons)");
delete selfEntities.smart_last_result;
t = await tileRun({ activity: "uc.main.act1", buttons: "true" });
const errLbl = t.after?.msg_data.require_user_action?.input?.settings?.find((x) => x.id === "errors");
ok(errLbl && /isn't added to the integration/.test(errLbl.field.label.value.en), "sensor not added to the integration -> clear message, nothing changed");
selfEntities.smart_last_result = "Smart Controls: Last Result";

// ---- logout and brute-force limit ------------------------------------------
await http("POST", "/api/logout", {});
cookie = "";
h = await http("GET", "/api/rules");
ok(h.status === 401, "after logout the API needs a login again");
let codes = [];
for (let i = 0; i < 6; i++) codes.push((await http("POST", "/api/login", { pin: "9999" })).status);
ok(codes.at(-1) === 429, "too many wrong PINs -> 429: " + codes.join(","));

drv.kill();
ws.terminate();
srv.close();
fs.rmSync(path.join(binDir, "driver.json"));
console.log("\n--- driver log (smart lines) ---\n" + drvLog.split("\n").filter((l) => /smart|rules|builder/i.test(l)).slice(0, 30).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
