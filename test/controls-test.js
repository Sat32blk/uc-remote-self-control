// Controls: switches, per-activity defaults, borrowing the volume rocker, timeout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Controls, validateControls } from "../src/bin/controls.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a fake remote ----
const TV = "tv.main.tv", LIGHT = "hass.main.light.ceiling", ACT = "uc.main.watch", ACT2 = "uc.main.music";
const ents = { [LIGHT]: { attributes: { state: "ON", brightness: 127 } }, [TV]: { attributes: { state: "ON" } } };
const acts = {
  [ACT]: { state: "ON", included: [TV, LIGHT], buttons: { VOLUME_UP: { short_press: { entity_id: TV, cmd_id: "media_player.volume_up" } }, VOLUME_DOWN: { short_press: { entity_id: TV, cmd_id: "media_player.volume_down" } } } },
  [ACT2]: { state: "OFF", included: [], buttons: {} }
};
const sent = [];
const core = {
  async get(p) {
    if (p.startsWith("/activities?")) return Object.entries(acts).map(([id, a]) => ({ entity_id: id, attributes: { state: a.state } }));
    let m = /^\/activities\/([^/]+)\/buttons$/.exec(p);
    if (m) return Object.entries(acts[decodeURI(m[1])].buttons).map(([button, x]) => ({ button, ...x }));
    m = /^\/activities\/([^/]+)$/.exec(p);
    if (m) return { options: { included_entities: acts[decodeURI(m[1])].included.map((entity_id) => ({ entity_id })) } };
    m = /^\/entities\/(.+)$/.exec(p);
    if (m) return ents[decodeURI(m[1])] || null;
    throw new Error("no route " + p);
  },
  async patch(p, b) {
    let m = /^\/activities\/([^/]+)\/buttons\/([A-Z_]+)$/.exec(p);
    if (m) { acts[decodeURI(m[1])].buttons[m[2]] = { ...(acts[decodeURI(m[1])].buttons[m[2]] || {}), ...b }; return {}; }
    m = /^\/activities\/([^/]+)$/.exec(p);
    if (m) { acts[decodeURI(m[1])].included = b.options.entity_ids; return {}; }
    throw new Error("no route " + p);
  },
  async request(method, p, b) {
    if (method === "DELETE") { const m = /^\/activities\/([^/]+)\/buttons\/([A-Z_]+)\/(\w+)$/.exec(p); delete acts[decodeURI(m[1])].buttons[m[2]][m[3]]; return {}; }
    const m = /^\/entities\/(.+)\/command$/.exec(p);
    sent.push({ entity: decodeURI(m[1]), ...b });
    if (b.cmd_id === "light.on") ents[LIGHT].attributes = { state: "ON", brightness: b.params.brightness };
    if (b.cmd_id === "light.off") ents[LIGHT].attributes = { state: "OFF" };
    return {};
  }
};
let cache = { display: { brightness: 70 }, button: { brightness: 40 } };
const patched = [];
const published = {};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-"));
const mk = () => new Controls({
  getCore: () => core, extras: () => null, cache: () => cache,
  patchSection: async (sec, ch) => { patched.push([sec, ch]); cache[sec] = { ...cache[sec], ...ch }; },
  publish: (id, a) => (published[id] = { ...(published[id] || {}), ...a }),
  file: path.join(dir, "controls.json")
});

// ---- validation ----
const good = {
  timeout: 1 * 2,
  activities: [{ activity: ACT, name: "Watch", buttons: { type: "volume", entity: TV, name: "TV" }, slider: { type: "display" }, borrow: true }],
  controls: [
    { name: "Light", target: { type: "light", entity: LIGHT, name: "Ceiling Light" }, start: 50, step: 5 },
    { name: "Bass", target: { type: "volume", entity: "rx.main.bass", name: "Bass" }, start: 40, step: 10 }
  ]
};
let v = validateControls(good);
ok(!v.errors.length && v.config.controls[0].id === "control_light" && v.config.controls[1].id === "control_bass", "valid config; switch ids from the names");
ok(validateControls({ ...good, controls: [{ name: "", target: null }] }).errors.length === 2, "name and target are required");
ok(validateControls({ ...good, timeout: 1 }).errors.length === 1 && !validateControls({ ...good, timeout: 0 }).errors.length, "timeout 2–600 s or 0 (stay on)");
ok(validateControls({ ...good, controls: [{ name: "Level", id: "control_level", target: { type: "display" } }] }).config.controls[0].id !== "control_level", "can't take the Control Level id");

const c = mk();
await c.replace(v.config);
c.publishAll();
ok(published.control_active.value === "None" && published.control_light.state === "OFF", "starts with nothing on: sensor None, switches off");

// ---- defaults with no control on ----
await c.controlCommand("volume_up");
ok(sent.at(-1).entity === TV && sent.at(-1).cmd_id === "media_player.volume_up", "no control on: rocker passes volume up to the TV");
await c.controlCommand("volume", { volume: 30 });
await c.queue.busy;
ok(patched.at(-1)[0] === "display" && patched.at(-1)[1].brightness === 30, "no control on: touch slider sets the screen brightness");

// ---- turning a control on ----
await c.switchCommand("control_light", "on");
ok(c.active === "control_light" && c.value === 50 && published.control_light.state === "ON", "Control: Light on, starts from the light's level (127 → 50 %)");
ok(published.control_active.value === "Light · 50 %" && published.control.volume === 50, "sensor and Control show Light · 50 %");
ok(acts[ACT].buttons.VOLUME_UP.short_press.entity_id === "self_control.main.control" && acts[ACT].included.includes("self_control.main.control"), "volume rocker borrowed: mapped to Control, Control added to the activity");
const saved = JSON.parse(fs.readFileSync(path.join(dir, "controls.json"), "utf8"));
ok(saved.borrowed[ACT]?.VOLUME_UP?.entity_id === TV, "the original rocker mapping is saved first");
await c.controlCommand("volume_up");
await c.queue.busy;
ok(sent.at(-1).cmd_id === "light.on" && sent.at(-1).params.brightness === 140 && c.value === 55, "rocker up: light to 55 %");
await c.controlCommand("volume", { volume: 0 });
await c.queue.busy;
ok(sent.at(-1).cmd_id === "light.off", "slider to 0: light off");

// ---- switching to another control ----
await c.switchCommand("control_bass", "on");
ok(c.active === "control_bass" && c.value === 40 && published.control_light.state === "OFF" && published.control_bass.state === "ON", "Control: Bass on turns Light off; Bass starts at its starting value (40 %)");
ok(acts[ACT].buttons.VOLUME_UP.short_press.entity_id === "self_control.main.control", "rocker stays borrowed while switching");
await c.controlCommand("volume_up");
await c.queue.busy;
ok(sent.at(-1).entity === "rx.main.bass" && sent.at(-1).params.volume === 50, "rocker up: bass 50 % (step 10)");

// ---- timeout ----
await sleep(2300);
await sleep(50);
ok(c.active === null && published.control_bass.state === "OFF" && published.control_active.value === "None", "after 2 s without use: off, sensor None");
ok(acts[ACT].buttons.VOLUME_UP.short_press.entity_id === TV && acts[ACT].buttons.VOLUME_DOWN.short_press.entity_id === TV, "volume rocker given back to the TV");
ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "controls.json"), "utf8")).borrowed).length, "nothing left marked borrowed");

// ---- remembered value ----
await c.switchCommand("control_bass", "toggle");
ok(c.value === 50, "Bass remembers its last value (50 %)");
await c.switchCommand("control_bass", "toggle");
ok(c.active === null, "toggle again: off");

// ---- stay on until changed ----
await c.replace({ ...v.config, timeout: 0 });
await c.switchCommand("control_light", "on");
await sleep(2300);
ok(c.active === "control_light", "timeout 0: stays on");

// ---- restart with a rocker still borrowed ----
const c2 = mk();
ok(Object.keys(c2.borrowed).includes(ACT), "a new start sees the borrowed rocker");
await c2.recover();
ok(acts[ACT].buttons.VOLUME_UP.short_press.entity_id === TV && !Object.keys(c2.borrowed).length, "recover() gives it back after a restart");
await c.deactivate("off");

// ---- activity with Nothing ----
acts[ACT].state = "OFF"; acts[ACT2].state = "ON";
await c.replace({ ...v.config, activities: [...v.config.activities, { activity: ACT2, name: "Music", buttons: null, slider: null, borrow: false }] });
c.actCache.at = 0;
const n = sent.length, pn = patched.length;
await c.controlCommand("volume_up");
await c.controlCommand("volume", { volume: 80 });
ok(sent.length === n && patched.length === pn, "activity with Nothing: rocker and slider do nothing");
await c.switchCommand("control_light", "on");
ok(!acts[ACT2].buttons.VOLUME_UP, "borrow off for that activity: rocker not touched");
await c.deactivate("off");

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
