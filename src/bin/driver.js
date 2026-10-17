// Remote Self-Control: an integration driver that runs on the Remote 3 and exposes
// the remote's own settings as entities (lights, switches, selects).
//
// Settings are read with GET /api/cfg and changed with PATCH /api/cfg/<section>
// on the remote itself, authenticated with an API key created during setup.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as uc from "@unfoldedcircle/integration-api";
import { CoreClient, CoreError } from "./core.js";
import { SmartEngine, validateRules } from "./smart.js";
import { startWebServer, builderUrls } from "./web.js";
import { listActivities, addTile, PAGE_NAME } from "./tile.js";
import { ReturnTracker, RETURN_MARK, activityGroups } from "./returnbtn.js";
import { StateIcons, validateIcons } from "./stateicons.js";
import { Extras, validateExtras } from "./extras.js";
import { ControlProxy } from "./control.js";

const BUILDER_PORT = Number(process.env.UC_SELF_BUILDER_PORT || 10123);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 20000;
const RETURN_POLL_MS = Number(process.env.UC_SELF_RETURN_POLL_MS || 2000);

const log = (...a) => console.log("[self-control]", ...a);
const warn = (...a) => console.warn("[self-control]", ...a);

// ---------------------------------------------------------------------------
// Persisted configuration
// ---------------------------------------------------------------------------

const api = new uc.IntegrationAPI();
let cfgFile; // set after init()

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(c) {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
}

let config = null; // { address, apiKey }
let core = null; // CoreClient
let cache = null; // last GET /cfg result
let pollTimer = null;
let returnTimer = null;
let returnTracker = null; // ReturnTracker
let stateIcons = null; // StateIcons
let extras = null; // Extras (virtual sliders and quick menus)
let connected = false;
let standby = false;
let lastBacklight = 50; // last non-zero backlight %, for "on"
let lastDisplay = 50; // last display brightness %, for "on"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pctTo255 = (p) => Math.round((clamp(Number(p) || 0, 0, 100) * 255) / 100);
const toPct = (b) => Math.round((clamp(Number(b) || 0, 0, 255) * 100) / 255);

// hue 0..360, sat 0..255 (UC light model) -> [r,g,b] at full value
function hsToRgb(hue, sat) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clamp(Number(sat), 0, 255) / 255;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

// [r,g,b] -> { hue 0..360, saturation 0..255 }
function rgbToHs(rgb) {
  const [r, g, b] = (rgb || [255, 255, 255]).map((x) => clamp(Number(x) || 0, 0, 255) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { hue: Math.round(h), saturation: Math.round(s * 255) };
}

// ---------------------------------------------------------------------------
// Select option tables: label <-> value
// ---------------------------------------------------------------------------

const COLOR_PRESETS = {
  warm_white: { name: "Warm white", rgb: [255, 190, 120] },
  amber: { name: "Amber", rgb: [255, 140, 0] },
  orange: { name: "Orange", rgb: [255, 90, 10] },
  red: { name: "Movie red", rgb: [255, 30, 20] },
  rose: { name: "Rose", rgb: [255, 70, 140] },
  purple: { name: "Purple", rgb: [150, 60, 255] },
  indigo: { name: "Indigo", rgb: [70, 70, 255] },
  ice_blue: { name: "Ice blue", rgb: [127, 172, 255] },
  cyan: { name: "Cyan", rgb: [0, 230, 230] },
  teal: { name: "Teal", rgb: [0, 200, 160] },
  green: { name: "Green", rgb: [40, 220, 70] },
  cool_white: { name: "Cool white", rgb: [235, 240, 255] }
};

// preset key for an rgb, or "#RRGGBB" when it matches none
function colorKeyOf(rgb) {
  if (!Array.isArray(rgb)) return undefined;
  const hit = Object.entries(COLOR_PRESETS).find(([, p]) => p.rgb.join() === rgb.join());
  if (hit) return hit[0];
  return "#" + rgb.map((x) => Number(x).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const fmtSec = (s) => (s === 0 ? "Never" : s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);

const SELECTS = {
  display_timeout: {
    name: "Display timeout",
    section: "power_saving",
    field: "display_off_sec",
    values: [5, 10, 15, 20, 30, 45, 60],
    label: (v) => `${v} s`
  },
  sleep_timeout: {
    name: "Sleep timeout",
    section: "power_saving",
    field: "standby_sec",
    values: [60, 120, 300, 600, 900, 1800, 3600, 10800, 0],
    label: fmtSec
  },
  wake_sensitivity: {
    name: "Wake sensitivity",
    section: "power_saving",
    field: "wakeup_sensitivity",
    values: [0, 1, 2, 3],
    label: (v) => ["Off", "Low", "Medium", "High"][v] ?? String(v)
  },
  sound_volume: {
    name: "Sound effects volume",
    section: "sound",
    field: "volume",
    values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    label: (v) => `${v} %`
  },
  // Macro-friendly versions of the lights: the remote passes percent values of
  // light.brightness_percent / light.color unconverted, so lights are ambiguous in macros.
  backlight_color: {
    name: "Button backlight color",
    read: (c) => colorKeyOf(c.button?.static_color?.rgb),
    values: Object.keys(COLOR_PRESETS),
    label: (k) => COLOR_PRESETS[k]?.name ?? `Custom ${k}`,
    write: async (k) => {
      if (!COLOR_PRESETS[k]) return; // "Custom #RRGGBB" = current colour, nothing to change
      await patchSection("button", { static_color: { rgb: COLOR_PRESETS[k].rgb } });
    },
    sorted: false
  },
  backlight_level: {
    name: "Button backlight level",
    section: "button",
    field: "brightness",
    values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    label: (v) => (v === 0 ? "Off" : `${v} %`)
  },
  display_level: {
    name: "Display brightness level",
    section: "display",
    field: "brightness",
    values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    label: (v) => `${v} %`,
    extra: { auto_brightness: false } // a manual level only sticks with auto off
  }
};

const readSel = (def, c) => (def.read ? def.read(c) : c?.[def.section]?.[def.field]);
const writeSel = (def, v) =>
  def.write ? def.write(v) : patchSection(def.section, { [def.field]: v, ...(def.extra || {}) });

function selectOptions(def, current) {
  const vals = [...def.values];
  if (current !== undefined && !vals.includes(current)) {
    vals.push(current);
    if (def.sorted !== false) {
      // keep "Never" (0) last for the sleep timeout, otherwise numeric order
      vals.sort((a, b) => (a === 0 && def.field === "standby_sec" ? 1 : b === 0 && def.field === "standby_sec" ? -1 : a - b));
    }
  }
  return vals.map((v) => ({ v, label: def.label(v) }));
}

// ---------------------------------------------------------------------------
// Switch table
// ---------------------------------------------------------------------------

const SWITCHES = {
  backlight_auto: {
    name: "Button backlight auto",
    get: (c) => c.button?.auto_brightness,
    set: (on) => patchSection("button", { auto_brightness: on })
  },
  display_auto_brightness: {
    name: "Display auto brightness",
    get: (c) => c.display?.auto_brightness,
    set: (on) => patchSection("display", { auto_brightness: on })
  },
  haptic: {
    name: "Haptic feedback",
    get: (c) => c.haptic?.enabled,
    set: (on) => patchSection("haptic", { enabled: on })
  },
  sound_effects: {
    name: "Sound effects",
    get: (c) => c.sound?.enabled,
    set: (on) => patchSection("sound", { enabled: on })
  },
  wake_on_wlan: {
    name: "Wake on WLAN",
    get: (c) => c.network?.wifi?.wake_on_wlan?.enabled ?? c.network?.wake_on_wlan?.enabled,
    set: (on) => patchNetworkWol(on)
  }
};

// ---------------------------------------------------------------------------
// Writing settings
// ---------------------------------------------------------------------------

// Sections whose PATCH body is sent complete (the spec marks fields required).
const FULL_SECTIONS = ["display", "haptic", "power_saving", "sound"];

async function patchSection(section, changes) {
  if (!core) throw new CoreError("not configured", 0, "unauthorized");
  let body = changes;
  if (FULL_SECTIONS.includes(section) && cache?.[section]) {
    body = { ...cache[section], ...changes };
  }
  log(`PATCH /cfg/${section}`, JSON.stringify(body));
  await core.patch(`/cfg/${section}`, body);
  if (cache) {
    cache[section] = { ...(cache[section] || {}), ...changes };
    if (changes.static_color) cache[section].static_color = changes.static_color;
    publishStates();
  }
  scheduleRefresh();
}

async function patchNetworkWol(on) {
  if (!core) throw new CoreError("not configured", 0, "unauthorized");
  const body = { wifi: { wake_on_wlan: { enabled: on } } };
  log("PATCH /cfg/network", JSON.stringify(body));
  await core.patch("/cfg/network", body);
  if (cache?.network) {
    cache.network.wifi = { ...(cache.network.wifi || {}), wake_on_wlan: { enabled: on } };
    publishStates();
  }
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const entities = {};

function statusOf(e) {
  if (e instanceof CoreError) {
    if (e.kind === "unauthorized") return uc.StatusCodes.Unauthorized;
    if (e.kind === "unreachable") return uc.StatusCodes.ServiceUnavailable;
    if (e.status === 400 || e.status === 422) return uc.StatusCodes.BadRequest;
  }
  return uc.StatusCodes.ServerError;
}

async function run(label, fn) {
  try {
    await fn();
    return uc.StatusCodes.Ok;
  } catch (e) {
    warn(`${label} failed:`, e.message);
    return statusOf(e);
  }
}

// --- debug: remember the last command exactly as the remote sent it -------
function recordCommand(entityId, cmd, params, code) {
  const text = `${entityId} ${cmd} ${JSON.stringify(params ?? {})} -> ${code}`;
  log("command:", text);
  const e = entities.debug;
  if (!e) return;
  const attrs = { state: uc.SensorStates.On, value: text.slice(0, 250) };
  if (!api.updateEntityAttributes(e.id, attrs)) Object.assign(e.attributes, attrs);
}

function traced(entityId, handler) {
  return async (entity, cmd, params) => {
    let code;
    try {
      code = await handler(entity, cmd, params);
    } catch (e) {
      warn(`${entityId} ${cmd} crashed:`, e.message);
      code = uc.StatusCodes.ServerError;
    }
    recordCommand(entityId, cmd, params, code);
    return code;
  };
}

// The remote sends "on" with brightness/saturation 0..255 (light entity spec), but its
// macro/activity editor offers "Set brightness" / "Set color" (ids light.dim / light.color)
// in percent. Accept every form: strip a "<type>." prefix and treat dim/color as "on".
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

function normalizeLight(cmd, params = {}) {
  const c = String(cmd).replace(/^[a-z_]+\./, "");
  const p = {};
  for (const k of ["brightness", "hue", "saturation"]) {
    const v = num(params[k]);
    if (v !== undefined && !Number.isNaN(v)) p[k] = v;
  }
  if (c === "dim" || c === "color") {
    if (p.brightness !== undefined) p.brightness = pctTo255(p.brightness);
    if (p.saturation !== undefined) p.saturation = pctTo255(p.saturation);
    return { cmd: "on", params: p };
  }
  return { cmd: c, params: p };
}

const plainCmd = (cmd) => String(cmd).replace(/^[a-z_]+\./, "");

async function backlightCmd(entity, rawCmd, rawParams = {}) {
  const { cmd, params } = normalizeLight(rawCmd, rawParams || {});
  return run(`backlight ${rawCmd}`, async () => {
    const cur = cache?.button?.brightness ?? 0;
    const changes = {};
    if (cmd === "off" || (cmd === "toggle" && cur > 0)) {
      changes.brightness = 0;
    } else if (cmd === "on" || cmd === "toggle") {
      changes.brightness = params.brightness !== undefined ? toPct(params.brightness) : cur > 0 ? cur : lastBacklight;
      if (params.hue !== undefined || params.saturation !== undefined) {
        const hs = rgbToHs(cache?.button?.static_color?.rgb);
        const hue = params.hue ?? hs.hue;
        const sat = params.saturation ?? hs.saturation;
        changes.static_color = { rgb: hsToRgb(hue, sat) };
      }
    } else {
      throw new CoreError(`unsupported command ${cmd}`, 400, "http");
    }
    await patchSection("button", changes);
  });
}

async function displayCmd(entity, rawCmd, rawParams = {}) {
  const { cmd, params } = normalizeLight(rawCmd, rawParams || {});
  return run(`display ${rawCmd}`, async () => {
    const cur = cache?.display?.brightness ?? 50;
    let level;
    if (cmd === "off" || (cmd === "toggle" && cur > 1)) {
      level = 1; // the screen can't switch off from here: "off" = dimmest
    } else if (cmd === "on" || cmd === "toggle") {
      level = params.brightness !== undefined ? Math.max(1, toPct(params.brightness)) : cur > 1 ? cur : lastDisplay;
    } else {
      throw new CoreError(`unsupported command ${cmd}`, 400, "http");
    }
    // A manual level only sticks with auto brightness off.
    await patchSection("display", { brightness: level, auto_brightness: false });
  });
}

function switchCmd(key) {
  return async (entity, rawCmd) =>
    run(`${key} ${rawCmd}`, async () => {
      const cmd = plainCmd(rawCmd);
      const def = SWITCHES[key];
      const cur = !!def.get(cache || {});
      const on = cmd === "on" ? true : cmd === "off" ? false : cmd === "toggle" ? !cur : null;
      if (on === null) throw new CoreError(`unsupported command ${cmd}`, 400, "http");
      await def.set(on);
    });
}

function selectCmd(key) {
  return async (entity, rawCmd, params) =>
    run(`${key} ${rawCmd}`, async () => {
      const cmd = plainCmd(rawCmd);
      params = params || {};
      const def = SELECTS[key];
      const current = readSel(def, cache);
      const opts = selectOptions(def, current);
      let idx = opts.findIndex((o) => o.v === current);
      switch (cmd) {
        case "select_option": {
          idx = opts.findIndex((o) => o.label === params.option);
          if (idx < 0) throw new CoreError(`unknown option ${params.option}`, 400, "http");
          break;
        }
        case "select_first":
          idx = 0;
          break;
        case "select_last":
          idx = opts.length - 1;
          break;
        case "select_next":
          idx = idx < 0 ? 0 : params.cycle === true || params.cycle === "true" ? (idx + 1) % opts.length : Math.min(idx + 1, opts.length - 1);
          break;
        case "select_previous":
          idx = idx < 0 ? 0 : params.cycle === true || params.cycle === "true" ? (idx - 1 + opts.length) % opts.length : Math.max(idx - 1, 0);
          break;
        default:
          throw new CoreError(`unsupported command ${cmd}`, 400, "http");
      }
      await writeSel(def, opts[idx].v);
    });
}

// Grouping and order in the web configurator: entity `area` = parent category.
// Entity ids are unchanged from earlier builds so existing pages/macros keep working.
const AREA_DISPLAY = "Remote Display";
const AREA_BUTTONS = "Remote Buttons";
const AREA_SETTINGS = "Remote Settings";

const LAYOUT = [
  [AREA_DISPLAY, "display_level", "Display Brightness Level"],
  [AREA_DISPLAY, "display_brightness", "Display Brightness"],
  [AREA_DISPLAY, "display_timeout", "Display Timeout"],
  [AREA_DISPLAY, "display_auto_brightness", "Display Auto Brightness"],
  [AREA_BUTTONS, "backlight_level", "Button Backlight Level"],
  [AREA_BUTTONS, "backlight_color", "Button Backlight Color"],
  [AREA_BUTTONS, "backlight", "Button Backlight"],
  [AREA_BUTTONS, "backlight_auto", "Button Backlight Auto"],
  [AREA_SETTINGS, "sound_volume", "Sound Effects Volume"],
  [AREA_SETTINGS, "wake_sensitivity", "Wake Sensitivity"],
  [AREA_SETTINGS, "sleep_timeout", "Sleep Timeout"],
  [AREA_SETTINGS, "wake_on_wlan", "Wake on LAN"],
  [AREA_SETTINGS, "sound_effects", "Sound Effects"],
  [AREA_SETTINGS, "haptic", "Haptic Feedback"]
];

function createEntities() {
  const L = uc.LightFeatures;
  for (const [area, id, name] of LAYOUT) {
    if (id === "backlight") {
      entities.backlight = new uc.Light("backlight", { en: name }, {
        area,
        features: [L.OnOff, L.Toggle, L.Dim, L.Color],
        attributes: { state: uc.LightStates.Unknown, brightness: 0, hue: 0, saturation: 0 },
        cmdHandler: traced("backlight", backlightCmd)
      });
    } else if (id === "display_brightness") {
      // Light entity so the Remote 3 touch slider can drive the display brightness.
      // "off" = dimmest (the screen can't be switched off from here).
      entities.display_brightness = new uc.Light("display_brightness", { en: name }, {
        area,
        features: [L.OnOff, L.Toggle, L.Dim],
        attributes: { state: uc.LightStates.Unknown, brightness: 0 },
        cmdHandler: traced("display_brightness", displayCmd)
      });
    } else if (SWITCHES[id]) {
      entities[id] = new uc.Switch(id, { en: name }, {
        area,
        features: [uc.SwitchFeatures.OnOff, uc.SwitchFeatures.Toggle],
        attributes: { state: uc.SwitchStates.Unknown },
        cmdHandler: traced(id, switchCmd(id))
      });
    } else if (SELECTS[id]) {
      const def = SELECTS[id];
      entities[id] = new uc.Select(id, { en: name }, {
        area,
        attributes: {
          state: uc.SelectStates.Unknown,
          options: def.values.map(def.label),
          current_option: ""
        },
        cmdHandler: traced(id, selectCmd(id))
      });
    }
  }
  registerEntities();
}

// ---------------------------------------------------------------------------
// Smart Buttons
// ---------------------------------------------------------------------------

const AREA_SMART = "Remote Smart Controls";
let smart = null; // SmartEngine
let rulesFile; // user rules in the config dir
const smartEntities = {};

// The engine's view of this integration's own controls.
const SNAPSHOT_FIELDS = {
  button: ["brightness", "static_color", "auto_brightness"],
  display: ["brightness", "auto_brightness"],
  sound: ["enabled", "volume"],
  haptic: ["enabled"]
};

const selfApi = {
  keys: [...Object.keys(SELECTS), ...Object.keys(SWITCHES)],
  // Current value of one of this integration's controls, as shown in the remote ("Amber", "60 %", "on").
  control(key) {
    if (SELECTS[key]) {
      const def = SELECTS[key];
      const v = readSel(def, cache);
      return v === undefined ? "" : def.label(v);
    }
    if (SWITCHES[key]) return SWITCHES[key].get(cache || {}) ? "on" : "off";
    return "";
  },
  snapshot() {
    const snap = {};
    for (const [sec, fields] of Object.entries(SNAPSHOT_FIELDS)) {
      if (!cache?.[sec]) continue;
      snap[sec] = {};
      for (const f of fields) if (cache[sec][f] !== undefined) snap[sec][f] = cache[sec][f];
    }
    return snap;
  },
  async restore(snap) {
    for (const [sec, vals] of Object.entries(snap || {})) {
      if (SNAPSHOT_FIELDS[sec] && vals && Object.keys(vals).length) await patchSection(sec, vals);
    }
  },
  read(pathStr) {
    return pathStr.split(".").reduce((o, k) => (o == null ? undefined : o[k]), cache || {});
  },
  async run(key, step) {
    if (SELECTS[key]) {
      const def = SELECTS[key];
      const current = readSel(def, cache);
      // Step through the preset list only (a "Custom …" current value is not a step target).
      const opts = selectOptions(def, undefined);
      const want = String(step.option).toLowerCase();
      let hit;
      if (["next", "previous", "up", "down"].includes(want)) {
        let i = opts.findIndex((o) => o.v === current);
        const n = opts.length;
        if (i < 0) {
          // not on a preset: start from the nearest one for numbers, the first one otherwise
          i = typeof current === "number" ? opts.reduce((b, o, j) => (Math.abs(o.v - current) < Math.abs(opts[b].v - current) ? j : b), 0) : -1;
        }
        if (want === "next") hit = opts[(i + 1 + n) % n];
        else if (want === "previous") hit = opts[(i < 0 ? 0 : i - 1 + n) % n];
        else if (want === "up") hit = opts[Math.min(i + 1, n - 1)];
        else hit = opts[Math.max(i - 1, 0)];
      } else {
        hit = selectOptions(def, current).find((o) => o.label.toLowerCase() === want);
      }
      if (!hit) throw new Error(`"${step.option}" is not an option of ${key}`);
      if (hit.v === current && def.extra === undefined) return;
      await writeSel(def, hit.v);
    } else if (SWITCHES[key]) {
      const def = SWITCHES[key];
      const st = String(step.state).toLowerCase();
      const on = st === "on" ? true : st === "off" ? false : st === "toggle" ? !def.get(cache || {}) : null;
      if (on === null) throw new Error(`state must be on, off or toggle`);
      await def.set(on);
    } else {
      throw new Error(`unknown control ${key}`);
    }
  }
};

function reportSmart(text) {
  const e = smartEntities.__last;
  if (!e) return;
  const attrs = { state: uc.SensorStates.On, value: text.slice(0, 250) };
  if (!api.updateEntityAttributes(e.id, attrs)) Object.assign(e.attributes, attrs);
}

function buildSmartEntities() {
  for (const k of Object.keys(smartEntities)) delete smartEntities[k];
  if (!smart) return;
  for (const b of smart.buttons) {
    smartEntities[b.id] = new uc.Button(b.id, { en: b.name }, {
      area: AREA_SMART,
      cmdHandler: async () => {
        if (!core) return uc.StatusCodes.ServiceUnavailable;
        smart.run(b.id).catch((e) => warn("smart button failed:", e.message)); // runs in the background
        return uc.StatusCodes.Ok;
      }
    });
  }
  smartEntities.__last = new uc.Sensor("smart_last_result", { en: "Smart Controls: Last Result" }, {
    area: AREA_SMART,
    attributes: { state: uc.SensorStates.On, value: "no button pressed yet" }
  });
}

const AREA_NAV = "Remote Navigation";
const previousSensor = new uc.Sensor("previous_activity", { en: "Previous Activity" }, {
  area: AREA_NAV,
  attributes: { state: uc.SensorStates.On, value: "-" }
});

function updatePreviousSensor() {
  if (!returnTracker) return;
  const attrs = { state: uc.SensorStates.On, value: (returnTracker.nameOf(returnTracker.previous) || "-").slice(0, 250) };
  if (!api.updateEntityAttributes(previousSensor.id, attrs)) Object.assign(previousSensor.attributes, attrs);
}

function registerEntities() {
  api.clearAvailableEntities();
  for (const [, id] of LAYOUT) api.addAvailableEntity(entities[id]);
  api.addAvailableEntity(previousSensor);
  for (const e of Object.values(smartEntities)) api.addAvailableEntity(e);
  for (const e of Object.values(extraEntities)) api.addAvailableEntity(e);
  for (const e of Object.values(controlEntities)) api.addAvailableEntity(e);
}

// ---------------------------------------------------------------------------
// "Control" test: a media player the rocker / touch slider / on-screen slider can point at
// ---------------------------------------------------------------------------

const AREA_CONTROL = "Remote Control Test";
const controlEntities = {};
let control = null;

async function fetchAllEntities(c, base) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const part = await c.get(`${base}?limit=100&page=${page}`);
    if (!Array.isArray(part) || !part.length) break;
    out.push(...part);
    if (part.length < 100) break;
  }
  return out;
}

function publishControl(attrs) {
  const e = controlEntities.control;
  if (!e) return;
  const changed = {};
  for (const [k, v] of Object.entries(attrs)) if (JSON.stringify(e.attributes?.[k]) !== JSON.stringify(v)) changed[k] = v;
  if (!Object.keys(changed).length) return;
  if (!api.updateEntityAttributes("control", changed)) Object.assign(e.attributes, changed);
}

function buildControlEntities() {
  const F = uc.MediaPlayerFeatures;
  controlEntities.control = new uc.MediaPlayer("control", { en: "Control" }, {
    area: AREA_CONTROL,
    features: [F.OnOff, F.Volume, F.VolumeUpDown, F.MuteToggle, F.SelectSource, F.MediaTitle, F.MediaArtist, F.MediaAlbum],
    attributes: control.attrs(),
    cmdHandler: traced("control", async (entity, rawCmd, params) => {
      if (!core) return uc.StatusCodes.ServiceUnavailable;
      control.command(plainCmd(rawCmd), params || {}).catch((e) => warn("control:", e.message));
      return uc.StatusCodes.Ok;
    })
  });
  const btn = (id, name, mode) => new uc.Button(id, { en: name }, {
    area: AREA_CONTROL,
    cmdHandler: traced(id, async () => {
      if (!core) return uc.StatusCodes.ServiceUnavailable;
      control.activate(mode).catch((e) => warn("control:", e.message));
      return uc.StatusCodes.Ok;
    })
  });
  controlEntities.control_light = btn("control_light", "Control: Light", "light");
  controlEntities.control_normal = btn("control_normal", "Control: Normal", "display");
}

// ---------------------------------------------------------------------------
// Virtual sliders and quick menus
// ---------------------------------------------------------------------------

const AREA_SLIDERS = "Remote Sliders & Menus";
const extraEntities = {};

function publishExtra(id, attrs) {
  const e = extraEntities[id];
  if (!e) return;
  const changed = {};
  for (const [k, v] of Object.entries(attrs)) if (JSON.stringify(e.attributes?.[k]) !== JSON.stringify(v)) changed[k] = v;
  if (!Object.keys(changed).length) return;
  if (!api.updateEntityAttributes(id, changed)) Object.assign(e.attributes, changed);
}

function sliderHandler(id) {
  return async (entity, rawCmd, rawParams) => {
    const { cmd, params } = normalizeLight(rawCmd, rawParams || {});
    if (!core) return uc.StatusCodes.ServiceUnavailable;
    try {
      // runs in the background so dragging the slider stays smooth; the latest value wins
      extras.sliderCommand(id, cmd, params.brightness).catch((e) => warn(`slider ${id} failed:`, e.message));
      return uc.StatusCodes.Ok;
    } catch (e) {
      warn(`slider ${id} ${rawCmd} failed:`, e.message);
      return uc.StatusCodes.BadRequest;
    }
  };
}

function menuHandler(id) {
  return async (entity, rawCmd, params) => {
    if (!core) return uc.StatusCodes.ServiceUnavailable;
    try {
      extras.menuCommand(id, plainCmd(rawCmd), params || {}).catch((e) => warn(`menu ${id} failed:`, e.message));
      return uc.StatusCodes.Ok;
    } catch (e) {
      warn(`menu ${id} ${rawCmd} failed:`, e.message);
      return uc.StatusCodes.BadRequest;
    }
  };
}

function buildExtraEntities() {
  for (const k of Object.keys(extraEntities)) delete extraEntities[k];
  const L = uc.LightFeatures;
  for (const s of extras.sliders) {
    extraEntities[s.id] = new uc.Light(s.id, { en: s.name }, {
      area: AREA_SLIDERS,
      features: [L.OnOff, L.Toggle, L.Dim],
      attributes: extras.initialAttrs(s.id),
      cmdHandler: traced(s.id, sliderHandler(s.id))
    });
  }
  for (const m of extras.menus) {
    extraEntities[m.id] = new uc.Select(m.id, { en: m.name }, {
      area: AREA_SLIDERS,
      attributes: extras.initialAttrs(m.id),
      cmdHandler: traced(m.id, menuHandler(m.id))
    });
  }
}

// Tile icons: the remote keeps an entity's icon in its own entity list (PATCH /entities/{id}),
// which exists only once the user has added the entity to the integration.
const appliedIcons = new Map(); // entity id -> icon last set
async function applyTileIcons() {
  if (!core || !extras) return;
  for (const x of [...extras.sliders, ...extras.menus]) {
    if (!x.icon || appliedIcons.get(x.id) === x.icon) continue;
    try {
      await core.patch(`/entities/${encodeURIComponent("self_control.main." + x.id)}`, { icon: x.icon });
      appliedIcons.set(x.id, x.icon);
      log(`tile icon of ${x.name} set to ${x.icon}`);
    } catch (e) {
      if (e.status !== 404) warn(`tile icon of ${x.name}: ${e.message}`);
    }
  }
}

// Quick menus can step through their choices on a physical button: the button is mapped to the
// menu's "select next" command (PATCH /activities/{id}/buttons/{BUTTON}). The menu entity must be
// added to the integration first; it's added to the activity's devices here.
const appliedButtons = new Map(); // menu id -> "activity|button|press" mapped by us
async function applyMenuButtons() {
  if (!core || !extras) return;
  const wanted = new Map(extras.menus.filter((m) => m.button?.activity && m.button?.button).map((m) => [m.id, m.button]));
  // unmap buttons we set earlier that are no longer wanted (only if they still point at the menu)
  for (const [id, key] of appliedButtons) {
    const w = wanted.get(id);
    if (w && `${w.activity}|${w.button}|${w.press}` === key) continue;
    const [act, btn, press] = key.split("|");
    try {
      const list = await core.get(`/activities/${encodeURI(act)}/buttons`);
      const cur = (Array.isArray(list) ? list : []).find((b) => b.button === btn)?.[press];
      if (cur?.entity_id === "self_control.main." + id) await core.request("DELETE", `/activities/${encodeURI(act)}/buttons/${encodeURIComponent(btn)}/${press}`);
    } catch (e) {
      warn(`menu button: unmapping ${btn} failed:`, e.message);
    }
    appliedButtons.delete(id);
  }
  for (const [id, b] of wanted) {
    const key = `${b.activity}|${b.button}|${b.press}`;
    if (appliedButtons.get(id) === key) continue;
    const entity = "self_control.main." + id;
    try {
      const act = await core.get(`/activities/${encodeURI(b.activity)}`);
      const included = (act?.options?.included_entities || []).map((x) => x.entity_id).filter(Boolean);
      if (!included.includes(entity)) await core.patch(`/activities/${encodeURI(b.activity)}`, { options: { entity_ids: [...included, entity] } });
      await core.patch(`/activities/${encodeURI(b.activity)}/buttons/${encodeURIComponent(b.button)}`, { [b.press]: { entity_id: entity, cmd_id: "select.select_next" } });
      appliedButtons.set(id, key);
      extras.errors[id] = null;
      log(`menu ${id}: ${b.button} (${b.press === "long_press" ? "long" : "short"} press) steps through its choices`);
    } catch (e) {
      extras.errors[id] = /does not exist|not found|404/i.test(e.message) ? "add the menu to the integration first, then save it again" : `button: ${e.message}`;
      warn(`menu ${id}: mapping ${b.button} failed:`, e.message);
    }
  }
}

const reservedIds = () => [...LAYOUT.map(([, id]) => id), "previous_activity", "debug", "smart_last_result", ...(smart?.buttons || []).map((b) => b.id)];

function loadRulesText() {
  try {
    return fs.readFileSync(rulesFile, "utf8");
  } catch {
    return fs.readFileSync(path.join(HERE, "default-rules.json"), "utf8");
  }
}

function initSmart() {
  rulesFile = path.join(api.getConfigDirPath(), "smart_rules.json");
  smart = new SmartEngine({
    core: () => core,
    self: selfApi,
    varsFile: path.join(api.getConfigDirPath(), "smart_vars.json"),
    report: reportSmart,
    log
  });
  const res = smart.load(loadRulesText());
  if (res.errors.length) {
    warn("smart rules invalid, using defaults:", res.errors.join(" | "));
    smart.load(fs.readFileSync(path.join(HERE, "default-rules.json"), "utf8"));
  }
  log(`smart buttons loaded: ${smart.buttons.map((b) => b.id).join(", ")}`);
  buildSmartEntities();
  registerEntities();
}

// Attribute snapshot for every entity, from the cached /cfg.
function computeStates(c) {
  const out = {};
  const btn = c.button || {};
  const hs = rgbToHs(btn.static_color?.rgb);
  out.backlight = {
    state: (btn.brightness ?? 0) > 0 ? uc.LightStates.On : uc.LightStates.Off,
    brightness: pctTo255(btn.brightness ?? 0),
    hue: hs.hue,
    saturation: hs.saturation
  };
  const disp = c.display || {};
  out.display_brightness = {
    state: (disp.brightness ?? 0) > 1 ? uc.LightStates.On : uc.LightStates.Off,
    brightness: pctTo255(disp.brightness ?? 0)
  };
  for (const [key, def] of Object.entries(SWITCHES)) {
    const v = def.get(c);
    out[key] = { state: v === undefined ? uc.SwitchStates.Unknown : v ? uc.SwitchStates.On : uc.SwitchStates.Off };
  }
  for (const [key, def] of Object.entries(SELECTS)) {
    const v = readSel(def, c);
    const opts = selectOptions(def, v);
    out[key] = {
      state: v === undefined ? uc.SelectStates.Unknown : uc.SelectStates.On,
      options: opts.map((o) => o.label),
      current_option: v === undefined ? "" : def.label(v)
    };
  }
  return out;
}

function setAllUnavailable() {
  for (const e of Object.values(entities)) {
    const attrs = { state: "UNAVAILABLE" };
    if (!api.updateEntityAttributes(e.id, attrs)) Object.assign(e.attributes, attrs);
  }
}

// Push changed attributes. Configured (subscribed) entities emit entity_change;
// the others just get their stored attributes updated for later get_entity_states.
function publishStates() {
  if (!cache) return;
  const states = computeStates(cache);
  if ((cache.button?.brightness ?? 0) > 0) lastBacklight = cache.button.brightness;
  if ((cache.display?.brightness ?? 0) > 1) lastDisplay = cache.display.brightness;
  for (const [id, attrs] of Object.entries(states)) {
    const e = Object.values(entities).find((x) => x.id === id);
    if (!e) continue;
    const changed = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (JSON.stringify(e.attributes?.[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (Object.keys(changed).length === 0) continue;
    if (!api.updateEntityAttributes(id, changed)) Object.assign(e.attributes, changed);
  }
}

// ---------------------------------------------------------------------------
// Polling the remote's settings
// ---------------------------------------------------------------------------

let refreshTimer = null;

async function refresh() {
  if (!core) return false;
  try {
    cache = await core.get("/cfg");
    publishStates();
    if (control && control.mode === "display" && !control.sending) { control.value = cache?.display?.brightness ?? control.value; control.show(); }
    await api.setDeviceState(uc.DeviceStates.Connected);
    return true;
  } catch (e) {
    warn("reading settings failed:", e.message);
    setAllUnavailable();
    await api.setDeviceState(uc.DeviceStates.Error);
    return false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

function startPolling() {
  stopPolling();
  if (!core || !connected || standby) return;
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);
  returnTimer = setInterval(() => {
    if (returnTracker?.enabled) returnTracker.poll().catch((e) => warn("return: reading activities failed:", e.message));
    if (stateIcons?.enabled) stateIcons.refresh(false);
    if (extras?.enabled) extras.refresh();
  }, RETURN_POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (returnTimer) clearInterval(returnTimer);
  pollTimer = null;
  returnTimer = null;
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

const PIN_PAGE = [
  {
    id: "pin",
    label: { en: "Web-configurator PIN" },
    field: { text: { value: "" } }
  },
  {
    id: "address",
    label: { en: "Remote address (leave as 127.0.0.1 unless setup fails)" },
    field: { text: { value: "127.0.0.1" } }
  }
];

// Setup flow state (one setup session at a time).
let setupStage = "pin"; // "menu" | "pin" | "rules" | "tile" | "return"

const menuPage = () => [
  {
    id: "builder",
    label: { en: "Smart Controls builder" },
    field: {
      label: {
        value: {
          en: "Build and test Smart Controls in a browser on your network:\n\n" + builderUrls(BUILDER_PORT).map((u) => "- " + u).join("\n") + "\n\nLog in with the web-configurator PIN."
        }
      }
    }
  },
  {
    id: "action",
    label: { en: "What do you want to change?" },
    field: {
      dropdown: {
        value: "rules",
        items: [
          { id: "rules", label: { en: "Edit Smart Controls (text)" } },
          { id: "return", label: { en: "Return to previous activity: set up the ↩ button" } },
          { id: "tile", label: { en: "Add the Last Result tile to an activity" } },
          { id: "reset_rules", label: { en: "Reset Smart Controls to the defaults" } },
          { id: "pin", label: { en: "Reconnect with the web-configurator PIN" } },
          { id: "done", label: { en: "Nothing, close" } }
        ]
      }
    }
  }
];

async function returnPage(errors) {
  const page = [];
  if (errors && errors.length) page.push({ id: "errors", label: { en: "Not done" }, field: { label: { value: { en: errors.map((e) => "- " + e).join("\n") } } } });
  let acts = [];
  try {
    acts = await listActivities(core);
  } catch (e) {
    page.push({ id: "errors2", label: { en: "Couldn't read the activities" }, field: { label: { value: { en: e.message } } } });
  }
  page.push({
    id: "help",
    label: { en: "Return to previous activity" },
    field: {
      label: {
        value: {
          en:
            "The integration watches which activity you start (whether or not the old one turns off) and keeps a **↩** button in the activities you tick pointed at the activity you used before. Pressing it opens that activity.\n\n" +
            "- **On screen:** a text button \"↩ <previous activity>\" or a back-arrow icon is added to the first free spot of each activity's first page. Move it anywhere you like; any text button starting with ↩ is kept up to date. If a page has no free spot, it's left as it is (no rows are added).\n" +
            "- **Physical button:** replaces what that button does in the ticked activities (short or long press).\n" +
            "- The previous activity is added to each ticked activity's devices automatically.\n\nUntick every activity to turn this off."
        }
      }
    }
  });
  const hosts = new Set(returnTracker.cfg.hosts);
  acts.slice(0, 30).forEach((a, i) => page.push({ id: "host_" + i, label: { en: a.name }, field: { checkbox: { value: hosts.has(a.id) } } }));
  page.push({
    id: "screen",
    label: { en: "On-screen button" },
    field: { dropdown: { value: returnTracker.cfg.screen || "text", items: [
      { id: "text", label: { en: `Text button "↩ <previous activity>"` } },
      { id: "icon", label: { en: "Back-arrow icon button" } },
      { id: "none", label: { en: "None" } }
    ] } }
  });
  const btns = acts.length ? await returnTracker.buttonsOf(acts[0].id) : [];
  page.push({
    id: "button",
    label: { en: "Physical button" },
    field: { dropdown: { value: returnTracker.cfg.button || "NONE", items: [{ id: "NONE", label: { en: "None" } }, ...btns.map((b) => ({ id: b, label: { en: b.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) } }))] } }
  });
  page.push({
    id: "scope",
    label: { en: "Use the physical button" },
    field: { dropdown: { value: returnTracker.cfg.buttonScope || "all", items: [
      { id: "all", label: { en: "In every ticked activity" } },
      { id: "nofit", label: { en: "Only where the on-screen button doesn't fit" } }
    ] } }
  });
  page.push({
    id: "press",
    label: { en: "Physical button press" },
    field: { dropdown: { value: returnTracker.cfg.press || "short_press", items: [
      { id: "short_press", label: { en: "Short press" } },
      { id: "long_press", label: { en: "Long press" } }
    ] } }
  });
  return new uc.RequestUserInput({ en: "Return to previous activity" }, page);
}

async function tilePage(errors) {
  const page = [];
  if (errors && errors.length) {
    page.push({ id: "errors", label: { en: "Not done" }, field: { label: { value: { en: errors.map((e) => "- " + e).join("\n") } } } });
  }
  let acts = [];
  try {
    acts = await listActivities(core);
  } catch (e) {
    page.push({ id: "errors2", label: { en: "Couldn't read the activities" }, field: { label: { value: { en: e.message } } } });
  }
  page.push({
    id: "help",
    label: { en: "Last Result tile" },
    field: {
      label: {
        value: {
          en: `Adds a page called **${PAGE_NAME}** to the activity you pick, with the **Smart Controls: Last Result** tile at the top. The web configurator can't add this tile itself. Running this again for the same activity replaces that page. Only entities already added to this integration can be placed.`
        }
      }
    }
  });
  if (acts.length) {
    page.push({ id: "activity", label: { en: "Activity" }, field: { dropdown: { value: acts[0].id, items: acts.map((a) => ({ id: a.id, label: { en: a.name } })) } } });
  } else {
    page.push({ id: "noact", label: { en: "No activities" }, field: { label: { value: { en: "Create an activity first, then run this again." } } } });
  }
  page.push({ id: "buttons", label: { en: "Also add the Smart Control buttons to the page" }, field: { checkbox: { value: true } } });
  return new uc.RequestUserInput({ en: "Add the Last Result tile" }, page);
}

function rulesPage(text, errors) {
  const page = [];
  if (errors && errors.length) {
    page.push({
      id: "errors",
      label: { en: "Not saved: please fix" },
      field: { label: { value: { en: errors.slice(0, 8).map((e) => "- " + e).join("\n") } } }
    });
  }
  page.push({
    id: "help",
    label: { en: "Smart Controls" },
    field: {
      label: {
        value: {
          en: "The builder page is easier: " + builderUrls(BUILDER_PORT)[0] + " . You can also paste or edit the rules here. Each control becomes an entity in the **Remote Smart Controls** group. After saving, add any new controls to the integration and to the activities that use them."
        }
      }
    }
  });
  page.push({ id: "rules", label: { en: "Rules (JSON)" }, field: { textarea: { value: text } } });
  return page;
}

function prettyRules(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function setupHandler(msg) {
  if (msg instanceof uc.DriverSetupRequest) {
    log("setup started", msg.reconfigure ? "(reconfigure)" : "");
    if (msg.reconfigure && config?.apiKey) {
      setupStage = "menu";
      return new uc.RequestUserInput({ en: "Remote Self-Control" }, menuPage());
    }
    setupStage = "pin";
    return new uc.RequestUserInput({ en: "Connect to this remote" }, PIN_PAGE);
  }
  if (msg instanceof uc.UserDataResponse) {
    const v = msg.inputValues || {};
    if (setupStage === "menu") {
      if (v.action === "pin") {
        setupStage = "pin";
        return new uc.RequestUserInput({ en: "Connect to this remote" }, PIN_PAGE);
      }
      if (v.action === "done") return new uc.SetupComplete();
      if (v.action === "return") {
        setupStage = "return";
        return await returnPage();
      }
      if (v.action === "tile") {
        setupStage = "tile";
        return await tilePage();
      }
      if (v.action === "reset_rules") {
        try {
          fs.rmSync(rulesFile, { force: true });
        } catch {}
        fs.writeFileSync(path.join(api.getConfigDirPath(), "smart_vars.json"), "{}");
        initSmart();
        log("smart buttons reset to defaults");
        return new uc.SetupComplete();
      }
      setupStage = "rules";
      return new uc.RequestUserInput({ en: "Edit Smart Controls" }, rulesPage(prettyRules(loadRulesText())));
    }
    if (setupStage === "return") {
      const acts = await listActivities(core).catch(() => []);
      const hosts = acts.filter((a, i) => String(v["host_" + i]) === "true").map((a) => a.id);
      const screen = ["text", "icon", "none"].includes(v.screen) ? v.screen : "text";
      const button = /^[A-Z0-9_]{1,20}$/.test(String(v.button || "")) ? String(v.button) : "NONE";
      const press = v.press === "long_press" ? "long_press" : "short_press";
      const buttonScope = v.scope === "nofit" ? "nofit" : "all";
      if (!hosts.length) {
        returnTracker.cfg.hosts = [];
        returnTracker.save();
        log("return: turned off (no activities chosen)");
        return new uc.SetupComplete();
      }
      if (screen === "none" && button === "NONE") return await returnPage(["Choose an on-screen button, a physical button, or both."]);
      try {
        await returnTracker.configure({ hosts, screen, button, press, buttonScope });
        log(`return: on for ${hosts.map((h) => returnTracker.nameOf(h)).join(", ")}; screen ${screen}; button ${button} ${press}`);
        startPolling();
        return new uc.SetupComplete();
      } catch (e) {
        warn("return setup failed:", e.message);
        return await returnPage([e.message]);
      }
    }
    if (setupStage === "tile") {
      const activityId = String(v.activity || "");
      const withButtons = String(v.buttons ?? "true") === "true";
      if (!activityId) return await tilePage(["Pick an activity."]);
      try {
        const r = await addTile(core, { activityId, withButtons, driverId: "self_control", sensorKey: "smart_last_result", smartIds: (smart?.buttons || []).map((b) => b.id) });
        log(`tile: ${r.replaced ? "updated" : "added"} page "${PAGE_NAME}" in ${r.activity}` + (r.buttons.length ? ` with ${r.buttons.join(", ")}` : "") + (r.missing.length ? `; not added to the integration yet: ${r.missing.join(", ")}` : ""));
        return new uc.SetupComplete();
      } catch (e) {
        warn("tile failed:", e.message);
        return await tilePage([e.message]);
      }
    }
    if (setupStage === "rules") {
      const text = String(v.rules || "");
      const res = validateRules(text, selfApi.keys);
      if (res.errors.length) {
        warn("smart rules rejected:", res.errors.join(" | "));
        return new uc.RequestUserInput({ en: "Edit Smart Controls" }, rulesPage(text, res.errors));
      }
      fs.writeFileSync(rulesFile, JSON.stringify(JSON.parse(text), null, 2));
      initSmart();
      log("smart buttons saved");
      return new uc.SetupComplete();
    }
    return await pinSetup(v);
  }
  if (msg instanceof uc.AbortDriverSetup) {
    log("setup aborted:", msg.error);
  }
  return new uc.SetupError();
}

async function pinSetup(v) {
  {
    const pin = String(v.pin || "").trim();
    const address = String(v.address || "127.0.0.1").trim() || "127.0.0.1";
    if (!pin) {
      warn("setup: no PIN entered");
      return new uc.SetupError(uc.IntegrationSetupError.AuthorizationError);
    }
    const setupClient = new CoreClient(address, { pin });
    try {
      await setupClient.get("/pub/version");
    } catch (e) {
      warn("setup: remote API not reachable at", address, "-", e.message);
      return new uc.SetupError(uc.IntegrationSetupError.ConnectionRefused);
    }
    let apiKey;
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      apiKey = await setupClient.createApiKey(`Self-Control ${stamp}`);
    } catch (e) {
      warn("setup: creating the API key failed:", e.message);
      return new uc.SetupError(
        e.kind === "unauthorized" ? uc.IntegrationSetupError.AuthorizationError : uc.IntegrationSetupError.Other
      );
    }
    const client = new CoreClient(address, { apiKey });
    try {
      cache = await client.get("/cfg");
    } catch (e) {
      warn("setup: the new API key does not work:", e.message);
      return new uc.SetupError(uc.IntegrationSetupError.AuthorizationError);
    }
    config = { address, apiKey };
    saveConfig(config);
    core = client;
    publishStates();
    control.findLight(fetchAllEntities);
    log("setup complete, API key stored");
    return new uc.SetupComplete();
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

api.on(uc.Events.Connect, async () => {
  connected = true;
  if (!core) {
    await api.setDeviceState(uc.DeviceStates.Disconnected);
    return;
  }
  startPolling();
});

api.on(uc.Events.Disconnect, async () => {
  connected = false;
  stopPolling();
});

api.on(uc.Events.EnterStandby, async () => {
  standby = true;
  stopPolling();
});

api.on(uc.Events.ExitStandby, async () => {
  standby = false;
  startPolling();
});

api.on(uc.Events.SubscribeEntities, async (ids) => {
  log("subscribed:", ids.join(", "));
  // configured entities share objects with the available ones, so states are current;
  // refresh once more so the remote gets fresh values right away.
  if (core) scheduleRefresh();
  applyTileIcons();
  applyMenuButtons();
});

createEntities();
const driverJson = fs.existsSync(path.join(HERE, "driver.json")) ? path.join(HERE, "driver.json") : path.join(HERE, "..", "driver.json");
api.init(driverJson, setupHandler);
cfgFile = path.join(api.getConfigDirPath(), "self_control.json");
stateIcons = new StateIcons({ getCore: () => core, file: path.join(api.getConfigDirPath(), "state_icons.json"), log, warn });
returnTracker = new ReturnTracker({ getCore: () => core, file: path.join(api.getConfigDirPath(), "return.json"), log, warn, onChange: updatePreviousSensor });
updatePreviousSensor();
extras = new Extras({ getCore: () => core, engine: () => smart, file: path.join(api.getConfigDirPath(), "sliders_menus.json"), publish: publishExtra, log, warn });
buildExtraEntities();
control = new ControlProxy({
  getCore: () => core,
  publish: publishControl,
  getDisplay: () => cache?.display?.brightness ?? 50,
  setDisplay: async (v) => { await patchSection("display", { brightness: v, auto_brightness: false }); },
  idleMs: Number(process.env.UC_SELF_CONTROL_IDLE_MS) || 8000,
  log,
  warn
});
buildControlEntities();
initSmart();

const CONTROL_NAMES = Object.fromEntries(LAYOUT.map(([, id, name]) => [id, name]));
startWebServer({
  port: BUILDER_PORT,
  pagePath: path.join(HERE, "web", "builder.html"),
  getCore: () => core,
  makePinClient: (pin) => new CoreClient(config?.address || "127.0.0.1", { pin }),
  smart: () => smart,
  controls: () => {
    const out = {};
    for (const [id, def] of Object.entries(SELECTS)) out[id] = { name: CONTROL_NAMES[id] || def.name, options: selectOptions(def, undefined).map((o) => o.label), current: selfApi.control(id) };
    for (const [id, def] of Object.entries(SWITCHES)) out[id] = { name: CONTROL_NAMES[id] || def.name, switch: true, current: selfApi.control(id) };
    return out;
  },
  settings: {
    "button.brightness": "Button backlight level (0–100)",
    "display.brightness": "Display brightness (0–100)",
    "display.auto_brightness": "Display auto brightness (true/false)",
    "sound.enabled": "Sound effects on (true/false)",
    "sound.volume": "Sound effects volume (0–100)",
    "haptic.enabled": "Haptic feedback on (true/false)",
    "power_saving.standby_sec": "Sleep timeout (seconds, 0 = never)"
  },
  stateIcons: () => stateIcons,
  // ↩ Return to previous activity, also editable in the builder
  returnSettings: async () => ({
    cfg: returnTracker.cfg,
    activities: core ? await listActivities(core).catch(() => []) : [],
    groups: core ? await activityGroups(core).catch(() => []) : [],
    targets: Object.fromEntries(returnTracker.cfg.hosts.map((h) => [h, returnTracker.nameOf(returnTracker.targetFor(h)) || null])),
    noRoom: returnTracker.cfg.hosts.filter((h) => { const hs = returnTracker.hostState[h]; return hs?.placed && !hs.onScreen && returnTracker.optsFor(h).screen !== "none"; }),
    current: returnTracker.nameOf(returnTracker.current) || null,
    previous: returnTracker.nameOf(returnTracker.previous) || null,
    groupError: returnTracker.groupError || null
  }),
  saveReturn: async (body) => {
    const acts = await listActivities(core).catch(() => []);
    const known = new Set(acts.map((a) => a.id));
    const hosts = (Array.isArray(body.hosts) ? body.hosts : []).filter((h) => known.has(h));
    const screen = ["text", "icon", "none"].includes(body.screen) ? body.screen : "text";
    const button = /^[A-Z0-9_]{1,20}$/.test(String(body.button || "")) ? String(body.button) : "NONE";
    const press = body.press === "long_press" ? "long_press" : "short_press";
    const buttonScope = body.buttonScope === "nofit" ? "nofit" : "all";
    // per-activity settings from the builder's Return tab
    let hostCfg;
    if (body.hostCfg && typeof body.hostCfg === "object") {
      hostCfg = {};
      for (const h of hosts) {
        const c = body.hostCfg[h] || {};
        const scr = ["text", "icon", "custom", "none"].includes(c.screen) ? c.screen : "text";
        const icon = /^custom:[A-Za-z0-9_.\-]{1,120}$/.test(String(c.icon || "")) ? String(c.icon) : null;
        if (scr === "custom" && !icon) return [`${returnTracker.nameOf(h) || h}: drop a picture for the custom ↩ button`];
        const btn = /^[A-Z0-9_]{1,20}$/.test(String(c.button || "")) ? String(c.button) : "NONE";
        if (scr === "none" && btn === "NONE") return [`${returnTracker.nameOf(h) || h}: choose an on-screen button, a physical button, or both`];
        hostCfg[h] = { screen: scr, icon, button: btn, press: c.press === "long_press" ? "long_press" : "short_press", buttonScope: c.buttonScope === "nofit" ? "nofit" : "all", close: c.close === true };
      }
    }
    const group = body.group === undefined ? undefined : body.group ? String(body.group) : null;
    if (!hosts.length) {
      returnTracker.cfg = { ...returnTracker.cfg, hosts: [], screen, button, press, buttonScope, hostCfg: {} };
      returnTracker.save();
      returnTracker.groupError = await returnTracker.syncGroup().catch((e) => e.message);
      log("return: turned off (no activities chosen)");
      return [];
    }
    if (!hostCfg && screen === "none" && button === "NONE") return ["Choose an on-screen button, a physical button, or both."];
    returnTracker.groupError = await returnTracker.configure({ hosts, screen, button, press, buttonScope, hostCfg, group });
    if (returnTracker.groupError) warn("return: activity group:", returnTracker.groupError);
    log(`return: on for ${hosts.map((h) => { const o = returnTracker.optsFor(h); return `${returnTracker.nameOf(h)} (${o.screen === "custom" ? "picture" : o.screen}${o.button !== "NONE" ? ", " + o.button + " " + (o.press === "long_press" ? "long" : "short") : ""}${o.close ? ", turns off when left" : ""})`; }).join(", ")} (from the builder)`);
    startPolling();
    return [];
  },
  extras: () => extras,
  validateExtras: (body) => validateExtras(body, selfApi.keys, reservedIds()),
  onExtrasChanged: async () => {
    buildExtraEntities();
    registerEntities();
    extras.publishAll();
    applyTileIcons();
    await applyMenuButtons();
    log(`sliders saved: ${extras.sliders.map((s) => s.name).join(", ") || "none"}; quick menus: ${extras.menus.map((m) => m.name).join(", ") || "none"}`);
    startPolling();
  },
  validateIcons,
  onIconsChanged: () => {
    log(`state icons saved: ${stateIcons.icons.map((b) => b.name || b.id).join(", ") || "none"}`);
    startPolling();
  },
  loadRulesText: () => ({ text: loadRulesText(), defaults: !fs.existsSync(rulesFile) }),
  defaultRulesText: () => fs.readFileSync(path.join(HERE, "default-rules.json"), "utf8"),
  validate: (rules) => validateRules(typeof rules === "string" ? rules : rules ?? null, selfApi.keys).errors,
  saveRules: (rules) => {
    const obj = typeof rules === "string" ? JSON.parse(rules) : rules;
    fs.writeFileSync(rulesFile, JSON.stringify(obj, null, 2));
    initSmart();
    log("smart controls saved from the builder");
  },
  log,
  warn
});

config = loadConfig();
if (config?.apiKey) {
  core = new CoreClient(config.address, { apiKey: config.apiKey });
  log("loaded configuration for", config.address);
  refresh().then(() => control.findLight(fetchAllEntities));
} else {
  log("not configured yet: run the integration setup");
}
