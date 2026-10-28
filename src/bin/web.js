// Small web server inside the driver that serves the Smart Controls builder page and its API.
//
//   GET  /                 builder page
//   GET  /api/session      { loggedIn }
//   POST /api/login        { pin }            -> sets an HttpOnly session cookie
//   POST /api/logout
//   GET  /api/catalog      devices, activities, commands and this integration's controls   (login)
//   GET  /api/rules        { text, defaults }                                               (login)
//   GET  /api/defaults     { text }                                                         (login)
//   POST /api/validate     { rules } -> { errors }                                          (login)
//   POST /api/rules        { rules } -> { ok, errors, buttons }                             (login)
//   POST /api/test         { id }    -> { summary }                                         (login)
//   GET  /api/states?id=   live attributes of a device + values seen                       (login)
//   GET  /api/states/seen  values seen for all devices; POST /api/states/watch {id,on}, /forget {id}
//   GET  /api/controls     { timeout, activities, controls, status }                       (login)
//   POST /api/controls     { timeout, activities, controls } -> { ok, errors }              (login)
//   POST /api/controls/test { id } turns a control on ({} = off)                           (login)
//   GET  /api/backup  download a backup of everything set up here (+ pictures)           (login)
//   POST /api/restore { backup, parts? } restore it                                      (login)
//   POST /api/controls/reset { id, value? } sets a control's value (default: its start)  (login)
//   GET  /api/extras       { sliders, menus, status }                                       (login)
//   POST /api/extras       { sliders, menus } -> { ok, errors }                              (login)
//   POST /api/extras/test  { id, value } (slider) | { id, option } (menu) -> { summary }     (login)
//   GET  /api/icons, POST /api/icons, POST /api/icons/upload, GET /api/icons/image          (login)
//   GET  /api/editor/catalog  every entity with its commands, the remote's model and key layout     (login)
//   Page Editor pass-through and pictures: see editor.js                                          (login)
//
// Login uses the remote's web-configurator PIN, checked against the remote's own API.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_MS = 12 * 60 * 60 * 1000;
import { MAX_ICONS, MAX_DEVICES } from "./stateicons.js";
import { makeBackup, restoreBackup, checkBackup } from "./backup.js";
import { writeStats } from "./core.js";
import { editorRoutes, checkAppLinks, sendBody, servePage } from "./editor.js";
const MAX_RESTORE_BODY = 24 * 1024 * 1024; // a backup carries its pictures
const MAX_BODY = 512 * 1024;

// media_player feature -> commands it enables (Integration API entity docs)
const MP_FEATURES = {
  on_off: ["on", "off"], toggle: ["toggle"], volume: ["volume"], volume_up_down: ["volume_up", "volume_down"],
  mute_toggle: ["mute_toggle"], mute: ["mute"], unmute: ["unmute"], play_pause: ["play_pause"], stop: ["stop"],
  next: ["next"], previous: ["previous"], fast_forward: ["fast_forward"], rewind: ["rewind"], seek: ["seek"],
  repeat: ["repeat"], shuffle: ["shuffle"], channel_switcher: ["channel_up", "channel_down"],
  dpad: ["cursor_up", "cursor_down", "cursor_left", "cursor_right", "cursor_enter"],
  numpad: ["digit_0", "digit_1", "digit_2", "digit_3", "digit_4", "digit_5", "digit_6", "digit_7", "digit_8", "digit_9"],
  home: ["home"], menu: ["menu"], context_menu: ["context_menu"], guide: ["guide"], info: ["info"], back: ["back"],
  color_buttons: ["function_red", "function_green", "function_yellow", "function_blue"],
  select_source: ["select_source"], select_sound_mode: ["select_sound_mode"], settings: ["settings"],
  record: ["record"], my_recordings: ["my_recordings"], live: ["live"], eject: ["eject"], open_close: ["open_close"],
  audio_track: ["audio_track"], subtitle: ["subtitle"]
};
// parameter name -> attribute holding its choices
const PARAM_LISTS = { source: "source_list", mode: "sound_mode_list", option: "options" };
// attribute -> attribute holding its possible values
const ATTR_LISTS = { source: "source_list", sound_mode: "sound_mode_list", current_option: "options" };
const STATES = {
  media_player: ["ON", "OFF", "PLAYING", "PAUSED", "STANDBY", "BUFFERING", "UNAVAILABLE"],
  light: ["ON", "OFF", "UNAVAILABLE"], switch: ["ON", "OFF", "UNAVAILABLE"], remote: ["ON", "OFF", "UNAVAILABLE"],
  climate: ["OFF", "HEAT", "COOL", "HEAT_COOL", "FAN", "AUTO", "UNAVAILABLE"], cover: ["OPEN", "OPENING", "CLOSED", "CLOSING", "UNAVAILABLE"],
  activity: ["ON", "OFF", "RUNNING", "ERROR"], macro: ["RUNNING", "COMPLETED", "ERROR"], select: ["ON", "UNAVAILABLE"], sensor: ["ON", "UNAVAILABLE"]
};

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

export function builderUrls(port) {
  const urls = [];
  const host = os.hostname().split(".")[0];
  if (host && host !== "localhost") urls.push(`http://${host}.local:${port}/`);
  for (const ip of lanAddresses()) urls.push(`http://${ip}:${port}/`);
  return urls;
}

/** Turns the remote's entity list + command metadata into what the builder needs. */
export function buildCatalog(entities, commandDefs, ownIntegrationPrefix) {
  const byType = {};
  for (const c of commandDefs || []) {
    const [type] = String(c.id || "").split(".");
    (byType[type] = byType[type] || []).push(c);
  }
  const devices = [];
  const activities = [];
  const own = []; // this integration's own entities (sliders, quick menus, smart controls…), listed apart
  for (const e of entities || []) {
    if (!e || !e.entity_id) continue;
    const isOwn = !!ownIntegrationPrefix && String(e.integration_id || "").startsWith(ownIntegrationPrefix);
    const type = e.entity_type;
    const name = nameOf(e.name) || e.entity_id;
    if (type === "activity") activities.push({ id: e.entity_id, name });
    const attrs = e.attributes || {};
    const features = e.features || [];
    let defs = byType[type] || [];
    if (type === "media_player") {
      const allowed = new Set(features.flatMap((f) => MP_FEATURES[f] || []));
      defs = defs.filter((d) => allowed.has(d.cmd_id));
    }
    const commands = defs.map((d) => ({
      id: d.id,
      label: nameOf(d.name) || d.cmd_id,
      params: (d.params || []).map((p) => {
        const key = p.param;
        const listAttr = PARAM_LISTS[key];
        return {
          key,
          label: nameOf(p.name) || key,
          type: p.type,
          min: p.min, max: p.max, step: p.step, unit: p.unit,
          list: listAttr && Array.isArray(attrs[listAttr]) ? attrs[listAttr] : Array.isArray(p.items) ? p.items.map((i) => i.id ?? i) : undefined
        };
      })
    }));
    const simple = (e.options && Array.isArray(e.options.simple_commands)) ? e.options.simple_commands : [];
    const values = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (Array.isArray(v) || k === "media_image_url") continue;
      const listAttr = ATTR_LISTS[k];
      values[k] = k === "state" ? STATES[type] || [] : listAttr && Array.isArray(attrs[listAttr]) ? attrs[listAttr] : typeof v === "boolean" ? ["true", "false"] : [];
    }
    (isOwn ? own : devices).push({ id: e.entity_id, name, type, integration: e.integration_id || "", features, icon: e.icon || null, current: Object.fromEntries(Object.entries(attrs).filter(([k, v]) => !Array.isArray(v) && k !== "media_image_url")), values, commands, simple, ...(isOwn ? { own: true } : {}) });
  }
  devices.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  own.sort((a, b) => a.name.localeCompare(b.name));
  activities.sort((a, b) => a.name.localeCompare(b.name));
  return { devices, activities, own };
}

export function startWebServer({ port, pagePath, getCore, makePinClient, smart, controls, settings, loadRulesText, defaultRulesText, saveRules, validate, stateIcons, validateIcons, onIconsChanged, extras, controlsApi, deviceStates, validateExtras, onExtrasChanged, returnSettings, saveReturn, pagesApi = null, launchersApi = null, statsApi = null, cleanup = null, version = "", editorPath = null, dataDir = null, onScreen = () => null, log, warn }) {
  /** Everything set up here as one backup; withPictures = include the custom pictures (base64). */
  async function buildBackup(withPictures) {
    const core = getCore();
    if (!core) throw new Error("The integration isn't connected to the remote.");
    const ret = await returnSettings();
    const ctl = controlsApi.get();
    return makeBackup({
      version,
      rulesText: loadRulesText().text,
      extras: extras().config,
      icons: stateIcons().icons,
      controls: { timeout: ctl.timeout, activities: ctl.activities, controls: ctl.controls },
      returnCfg: ret.cfg,
      starts: pagesApi ? pagesApi.starts() : null,
      launchers: launchersApi ? launchersApi.config() : null,
      appLinks: (() => { try { return dataDir ? JSON.parse(fs.readFileSync(path.join(dataDir, "app_links.json"), "utf8")) : null; } catch { return null; } })(),
      downloadIcon: async (id) => (await core.download(`/resources/Icon/${encodeURIComponent(id)}`)).body,
      withPictures
    });
  }
  /** Restores a backup (checked with checkBackup first). which: parts, or null for all. */
  async function doRestore(b, which = null) {
    const core = getCore();
    if (!core) return { errors: ["The integration isn't connected to the remote."], done: [], warnings: [] };
    const r = await restoreBackup(b, {
      uploadIcon: (name, png) => core.uploadIcon(name, png),
      validateRules: (rules) => validate(rules),
      saveRules: (rules) => saveRules(rules),
      validateExtras: (x) => validateExtras(x),
      applyExtras: async (x) => { extras().replace(x); onExtrasChanged && (await onExtrasChanged()); },
      validateIcons: (x) => validateIcons(x),
      applyIcons: async (icons, defaults) => { const r = await stateIcons().replace(icons, defaults); if (!r.errors.length) onIconsChanged && onIconsChanged(); return r; },
      validateControls: (x) => controlsApi.validate(x),
      applyControls: (cfg) => controlsApi.save(cfg),
      applyReturn: (cfg) => saveReturn(cfg),
      validateStarts: (x) => pagesApi.validate({ starts: x }),
      applyStarts: (x) => pagesApi.save(x),
      validateLaunchers: launchersApi ? (x) => launchersApi.validate({ launchers: x }) : null,
      applyLaunchers: (x) => launchersApi.save(x),
      validateAppLinks: dataDir ? (x) => checkAppLinks(x) : null,
      applyAppLinks: (x) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, "app_links.json"), JSON.stringify(x, null, 1)); }
    }, which);
    log(`backup restored: ${r.done.join(", ") || "nothing"}${r.errors.length ? "; problems: " + r.errors.join(" | ") : ""}`);
    return r;
  }
  const sessions = new Map(); // token -> expiry
  const failures = new Map(); // ip -> [timestamps]

  const loggedIn = (req) => {
    const m = /(?:^|;\s*)scb_sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
    if (!m) return false;
    const exp = sessions.get(m[1]);
    if (!exp || exp < Date.now()) {
      sessions.delete(m[1]);
      return false;
    }
    return true;
  };

  const send = (res, code, obj, headers = {}) => sendBody(res.req, res, code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }, JSON.stringify(obj));

  const readJson = (req, maxBody = MAX_BODY) =>
    new Promise((resolve, reject) => {
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("JSON body expected"), { code: 415 }));
      let size = 0;
      const chunks = [];
      // Oversized bodies are drained and dropped (not kept in memory), then refused with 413.
      req.on("data", (c) => {
        size += c.length;
        if (size <= maxBody) chunks.push(c);
        else chunks.length = 0;
      });
      req.on("end", () => {
        if (size > maxBody) return reject(Object.assign(new Error("request too large"), { code: 413 }));
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(Object.assign(new Error("invalid JSON"), { code: 400 }));
        }
      });
      req.on("error", reject);
    });

  async function fetchAll(core, pathBase) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const part = await core.get(`${pathBase}${pathBase.includes("?") ? "&" : "?"}limit=100&page=${page}`);
      if (!Array.isArray(part) || part.length === 0) break;
      out.push(...part);
      if (part.length < 100) break;
    }
    return out;
  }

  const routes = {
    "GET /": async (req, res) => servePage(req, res, pagePath, { "X-Frame-Options": "DENY" }),
    "GET /api/session": async (req, res) => send(res, 200, { loggedIn: loggedIn(req), configured: !!getCore() }),
    "POST /api/login": async (req, res) => {
      const ip = req.socket.remoteAddress || "?";
      const recent = (failures.get(ip) || []).filter((t) => t > Date.now() - 5 * 60 * 1000);
      if (recent.length >= 5) return send(res, 429, { error: "Too many wrong PINs. Wait 5 minutes and try again." });
      const body = await readJson(req);
      const pin = String(body.pin || "").trim();
      let ok = false;
      if (pin) {
        try {
          await makePinClient(pin).get("/cfg/device");
          ok = true;
        } catch (e) {
          if (e.kind !== "unauthorized") return send(res, 502, { error: "Couldn't check the PIN with the remote: " + e.message });
        }
      }
      if (!ok) {
        recent.push(Date.now());
        failures.set(ip, recent);
        return send(res, 401, { error: "Wrong PIN. Use the web-configurator PIN shown on the remote." });
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, Date.now() + SESSION_MS);
      send(res, 200, { ok: true }, { "Set-Cookie": `scb_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
    },
    "POST /api/logout": async (req, res) => {
      const m = /(?:^|;\s*)scb_sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
      if (m) sessions.delete(m[1]);
      send(res, 200, { ok: true }, { "Set-Cookie": "scb_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    },
    "GET /api/catalog": async (req, res) => {
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't set up yet. Run its setup in the web configurator first." });
      const [entities, commands, instances] = await Promise.all([fetchAll(core, "/entities"), core.get("/cfg/entity/commands"), fetchAll(core, "/intg/instances").catch(() => [])]);
      const cat = buildCatalog(entities, commands, "self_control");
      const integrations = {};
      for (const i of instances || []) if (i?.integration_id) integrations[i.integration_id] = (typeof i.name === "string" ? i.name : i.name?.en || Object.values(i.name || {})[0]) || i.integration_id;
      send(res, 200, { ...cat, controls: controls(), settings, integrations, copies: launchersApi ? launchersApi.copies() : {} });
    },
    // ---- page editor: everything on the remote, its own integration's entities included ----
    "GET /api/editor/catalog": async (req, res) => {
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't set up yet. Run its setup in the web configurator first." });
      const [entities, commands, system, layout, screen] = await Promise.all([fetchAll(core, "/entities"), core.get("/cfg/entity/commands"),
        core.get("/system").catch(() => null), core.get("/cfg/device/button_layout").catch(() => null), core.get("/cfg/device/screen_layout").catch(() => null)]);
      const cat = buildCatalog(entities, commands, null);
      send(res, 200, { devices: cat.devices, model: String(system?.model_number || ""), buttonLayout: layout, screenLayout: screen, own: "self_control", version, copies: launchersApi ? launchersApi.copies() : {} });
    },
    "GET /api/rules": async (req, res) => {
      const r = loadRulesText();
      send(res, 200, r);
    },
    "GET /api/defaults": async (req, res) => send(res, 200, { text: defaultRulesText() }),
    "POST /api/validate": async (req, res) => {
      const body = await readJson(req);
      send(res, 200, { errors: validate(body.rules) });
    },
    "POST /api/rules": async (req, res) => {
      const body = await readJson(req);
      const errors = validate(body.rules);
      if (errors.length) return send(res, 422, { ok: false, errors });
      saveRules(body.rules);
      send(res, 200, { ok: true, errors: [], buttons: smart().buttons.map((b) => ({ id: b.id, name: b.name })) });
    },
    "GET /api/icons": async (req, res) => {
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      send(res, 200, { icons: stateIcons().list(), activities: await stateIcons().activities(), check: stateIcons().lastCheck || null, limits: { icons: MAX_ICONS, devices: MAX_DEVICES }, writes: writeStats() });
    },
    "POST /api/icons": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const v = validateIcons(body);
      if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors });
      const r = await stateIcons().replace(v.icons);
      if (r.errors.length) return send(res, 422, { ok: false, errors: r.errors });
      onIconsChanged && onIconsChanged();
      send(res, 200, { ok: true, icons: stateIcons().list() });
    },
    "POST /api/icons/upload": async (req, res) => {
      const body = await readJson(req);
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const name = String(body.name || "");
      if (!/^[A-Za-z0-9_.\-]{1,80}\.png$/.test(name)) return send(res, 400, { error: "invalid file name" });
      const png = Buffer.from(String(body.data || ""), "base64");
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return send(res, 400, { error: "not a PNG image" });
      if (png.length > 32 * 1024) return send(res, 413, { error: "icon is larger than 32 KB" });
      const id = await core.uploadIcon(name, png);
      send(res, 200, { icon: "custom:" + id });
    },
    "GET /api/icons/image": async (req, res) => {
      const id = new URL(req.url, "http://x").searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_.\-]{1,120}$/.test(id)) return send(res, 400, { error: "invalid id" });
      const core = getCore();
      if (!core) return send(res, 503, { error: "not connected" });
      const img = await core.download(`/resources/Icon/${encodeURIComponent(id)}`);
      res.writeHead(200, { "Content-Type": img.type, "Cache-Control": "private, max-age=3600" });
      res.end(img.body);
    },
    // Physical buttons of an activity, for mapping a quick menu to one
    "GET /api/buttons": async (req, res) => {
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const id = new URL(req.url, "http://x").searchParams.get("activity") || "";
      let list = [];
      try { list = await core.get(`/activities/${encodeURI(id)}/buttons`); } catch {}
      const buttons = (Array.isArray(list) ? list : []).map((b) => ({ button: b.button, short: b.short_press?.entity_id || null, long: b.long_press?.entity_id || null }));
      send(res, 200, { buttons });
    },
    // statistics: activity use and battery, collected by the integration
    "GET /api/stats": async (req, res) => {
      if (!statsApi) return send(res, 404, { error: "Statistics aren't available." });
      send(res, 200, statsApi.data());
    },
    "POST /api/stats/settings": async (req, res) => {
      if (!statsApi) return send(res, 404, { error: "Statistics aren't available." });
      const body = await readJson(req);
      send(res, 200, { ok: true, cfg: statsApi.setConfig(body || {}) });
    },
    "POST /api/stats/clear": async (req, res) => {
      if (!statsApi) return send(res, 404, { error: "Statistics aren't available." });
      statsApi.clear();
      log("statistics: cleared from the builder");
      send(res, 200, { ok: true });
    },
    "GET /api/stats/csv": async (req, res) => {
      if (!statsApi) return send(res, 404, { error: "Statistics aren't available." });
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="remote-statistics.csv"', "Cache-Control": "no-store" });
      res.end(statsApi.csv());
    },
    "GET /api/return": async (req, res) => {
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      send(res, 200, await returnSettings());
    },
    "POST /api/return": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      try {
        const errors = await saveReturn(body);
        if (errors.length) return send(res, 422, { ok: false, errors });
        send(res, 200, { ok: true, ...(await returnSettings()) });
      } catch (e) {
        send(res, 502, { ok: false, error: e.message });
      }
    },
    "GET /api/states": async (req, res) => {
      const id = new URL(req.url, "http://x").searchParams.get("id") || "";
      if (!id || id.length > 200) return send(res, 400, { error: "pick a device" });
      try {
        send(res, 200, await deviceStates().read(id));
      } catch (e) {
        send(res, e.status === 404 ? 404 : 502, { error: e.message });
      }
    },
    "GET /api/states/seen": async (req, res) => send(res, 200, { seen: deviceStates().seen, watched: deviceStates().watched }),
    "POST /api/states/watch": async (req, res) => {
      const body = await readJson(req);
      try {
        send(res, 200, { watched: deviceStates().watch(String(body.id || ""), !!body.on) });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    },
    "POST /api/states/forget": async (req, res) => {
      const body = await readJson(req);
      deviceStates().forget(String(body.id || ""));
      send(res, 200, { ok: true });
    },
    "GET /api/controls": async (req, res) => send(res, 200, controlsApi.get()),
    "POST /api/controls": async (req, res) => {
      const body = await readJson(req);
      const v = controlsApi.validate(body);
      if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors });
      await controlsApi.save(v.config);
      send(res, 200, { ok: true, errors: [], ...controlsApi.get() });
    },
    "POST /api/controls/test": async (req, res) => {
      const body = await readJson(req);
      try {
        await controlsApi.test(body.id || null);
        send(res, 200, { ok: true, ...controlsApi.get() });
      } catch (e) {
        send(res, 400, { ok: false, error: e.message });
      }
    },
    "POST /api/controls/reset": async (req, res) => {
      const body = await readJson(req);
      try {
        const value = controlsApi.reset(String(body.id || ""), body.value);
        send(res, 200, { ok: true, value, ...controlsApi.get() });
      } catch (e) {
        send(res, 400, { ok: false, error: e.message });
      }
    },
    "GET /api/pages": async (req, res) => {
      const activity = new URL(req.url, "http://x").searchParams.get("activity") || "";
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      if (!activity) return send(res, 400, { error: "activity missing" });
      try {
        send(res, 200, { pages: await pagesApi.list(activity) });
      } catch (e) {
        send(res, 502, { error: e.message });
      }
    },
    "GET /api/starts": async (req, res) => send(res, 200, { starts: pagesApi.starts() }),
    "POST /api/starts": async (req, res) => {
      const body = await readJson(req);
      const v = pagesApi.validate(body);
      if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors });
      await pagesApi.save(v.starts);
      send(res, 200, { ok: true, starts: pagesApi.starts() });
    },
    // ---- smart launchers ----
    "GET /api/launchers": async (req, res) => {
      if (!launchersApi) return send(res, 404, { error: "not available" });
      send(res, 200, launchersApi.get());
    },
    "POST /api/launchers": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const v = launchersApi.validate(body);
      if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors });
      const problems = await launchersApi.save(v.launchers);
      send(res, problems.length ? 207 : 200, { ok: !problems.length, problems, ...launchersApi.get() });
    },
    "POST /api/launchers/place": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      try {
        const where = { kind: ["page", "button", "home"].includes(body.kind) ? body.kind : "page", activity: String(body.activity || ""), page: body.page ? String(body.page) : null,
          button: String(body.button || ""), press: body.press === "long_press" ? "long_press" : "short_press", look: body.look === "text" ? "text" : "icon" };
        if (where.kind !== "home" && !where.activity) throw new Error("pick the activity");
        const what = await launchersApi.place(String(body.launcher || ""), where);
        send(res, 200, { ok: true, result: what, ...launchersApi.get() });
      } catch (e) {
        send(res, 400, { ok: false, error: e.message });
      }
    },
    "POST /api/launchers/scan": async (req, res) => {
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      try {
        await launchersApi.scan();
        send(res, 200, { ok: true, ...launchersApi.get() });
      } catch (e) {
        send(res, 502, { ok: false, error: e.message });
      }
    },
    "POST /api/pages/go": async (req, res) => {
      const body = await readJson(req);
      try {
        send(res, 200, { ok: true, result: await pagesApi.go(body.activity || null, String(body.page || "")) });
      } catch (e) {
        send(res, 400, { ok: false, error: e.message });
      }
    },
    "POST /api/cleanup": async (req, res) => {
      const body = await readJson(req);
      if (body.confirm !== "remove") return send(res, 400, { ok: false, error: "confirmation missing" });
      try {
        const r = await cleanup({ pictures: body.pictures === true, revoke: body.revoke === true });
        send(res, 200, { ok: !r.problems.length, ...r });
      } catch (e) {
        send(res, 502, { ok: false, error: e.message });
      }
    },
    "GET /api/write-stats": async (req, res) => send(res, 200, writeStats()),
    // the pictures this integration's settings still use (level-picture frames, state icons, ↩ pictures):
    // the Page Editor won't delete those
    "GET /api/editor/keptpictures": async (req, res) => {
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const b = await buildBackup(false);
      send(res, 200, { used: b.picturesOnRemote || [] });
    },
    "GET /api/backup": async (req, res) => {
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const b = await buildBackup(true);
      const day = b.created.slice(0, 10);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="self-control-backup-${day}.json"` });
      res.end(JSON.stringify(b, null, 1));
      log(`backup made: ${Object.keys(b.pictures).length} pictures${b.missingIcons.length ? `, ${b.missingIcons.length} missing` : ""}`);
    },
    "POST /api/restore": async (req, res) => {
      const body = await readJson(req, MAX_RESTORE_BODY);
      const core = getCore();
      if (!core) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const b = body.backup;
      const bad = checkBackup(b);
      if (bad) return send(res, 422, { ok: false, errors: [bad] });
      const which = Array.isArray(body.parts) ? body.parts.map(String) : null;
      const r = await doRestore(b, which);
      send(res, r.errors.length && !r.done.length ? 422 : 200, { ok: !r.errors.length, ...r });
    },
    "GET /api/extras": async (req, res) => send(res, 200, { ...extras().config, status: extras().status() }),
    "POST /api/extras": async (req, res) => {
      const body = await readJson(req);
      const v = validateExtras(body);
      if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors });
      extras().replace(v.extras);
      onExtrasChanged && (await onExtrasChanged());
      send(res, 200, { ok: true, errors: [], ...extras().config, status: extras().status() });
    },
    "POST /api/extras/test": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      const id = String(body.id || "");
      const x = extras();
      try {
        if (x.slider(id)) {
          await x.setValue(id, body.value);
          const st = x.status()[id];
          return send(res, 200, { summary: st.error ? `${x.slider(id).name}: ERROR ${st.error}` : `${x.slider(id).name} set to ${st.value}` });
        }
        if (x.menu(id)) return send(res, 200, { summary: await x.menuCommand(id, "select_option", { option: body.option }) });
        send(res, 404, { error: `"${id}" isn't saved yet. Save first.` });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    },
    "POST /api/test": async (req, res) => {
      const body = await readJson(req);
      if (!getCore()) return send(res, 503, { error: "The integration isn't connected to the remote." });
      try {
        const summary = await smart().run(String(body.id || ""));
        send(res, 200, { summary });
      } catch (e) {
        send(res, 404, { error: e.message });
      }
    }
  };
  if (editorPath) Object.assign(routes, editorRoutes({ getCore, onScreen, dataDir, editorPath, send, readJson, log, warn }));
  const PUBLIC = new Set(["GET /", "GET /api/session", "POST /api/login", "POST /api/logout"]);

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const key = `${req.method} ${url === "/index.html" ? "/" : url}`;
    const handler = routes[key];
    try {
      if (!handler) return send(res, 404, { error: "not found" });
      if (!PUBLIC.has(key) && !loggedIn(req)) return send(res, 401, { error: "Log in with the web-configurator PIN." });
      await handler(req, res);
    } catch (e) {
      warn("builder request failed:", key, e.message);
      if (!res.headersSent) send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  });
  server.on("error", (e) => warn(`builder web server could not start on port ${port}:`, e.message));
  server.listen(port, "0.0.0.0", () => log(`Smart Controls builder: ${builderUrls(port).join("  ")}`));
  // for the integration's own setup screens (Integration Manager's backup step)
  server.selfBackup = { make: buildBackup, restore: doRestore };
  return server;
}
