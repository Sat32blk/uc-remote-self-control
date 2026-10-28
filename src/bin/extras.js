// Virtual sliders and quick menus.
//
// Virtual slider: a light entity of this integration whose brightness (0..255) stands for any number
// on another device, like a receiver's volume. Sliders get the remote's own slider pop-up on a home
// tile and work with the Remote 3 touch slider. A slider either sends the value in one command
// (e.g. media_player.volume { volume: 35 }) or presses up/down commands the right number of times.
// It reads the device's attribute (e.g. "volume") to follow changes made elsewhere; without one it
// remembers the last value it set.
//
// Quick menu: a select entity whose choices each run a list of Smart Control steps. On a home tile
// or a page it opens the remote's own list pop-up. A choice can have a condition that marks it as the
// current one (e.g. the receiver's input is HDMI1); otherwise the last choice picked is shown.
//
// Config file (sliders_menus.json):
// {
//   "sliders": [{ "id": "slider_receiver_volume", "name": "Receiver Volume", "entity": "<id>", "attr": "volume",
//                 "min": 0, "max": 80, "step": 1,
//                 "mode": "command", "cmd": "media_player.volume", "param": "volume" }
//            | { ..., "mode": "steps", "up": "media_player.volume_up", "down": "media_player.volume_down",
//                 "per_press": 1, "delay": 200 }],
//   "menus":   [{ "id": "menu_receiver_input", "name": "Receiver Input",
//                 "options": [{ "label": "TV", "do": [STEP...], "when": COND }] }]
// }

import fs from "node:fs";
import { vActions, vCond } from "./smart.js";

export const LIMITS = { sliders: 30, menus: 30, options: 30, presses: 60, sweep: 150, delayMs: 2000 };
const SLIDER_ID = /^slider_[a-z0-9_]{1,36}$/;
const MENU_ID = /^menu_[a-z0-9_]{1,36}$/;
const ICON_RE = /^(custom|uc):[A-Za-z0-9_.\-]{1,120}$/;
const HOLD_MS = Number(process.env.UC_SELF_SLIDER_HOLD_MS || 3000); // after a change from the remote, don't let a slow device report flip it back
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.+-]/g, "")));

/** Rounds v to min + k*step inside [min, max]. */
export function snap(v, s) {
  const step = s.step > 0 ? s.step : 1;
  const k = Math.round((v - s.min) / step);
  const dec = (String(step).split(".")[1] || "").length;
  const out = Number((s.min + k * step).toFixed(dec));
  return Math.max(s.min, Math.min(s.max, out));
}
/** Slider value -> light brightness 0..255. */
export const toBrightness = (v, s) => Math.round(((Math.max(s.min, Math.min(s.max, v)) - s.min) / (s.max - s.min)) * 255);
/** Light brightness 0..255 -> slider value. */
export const fromBrightness = (b, s) => snap(s.min + (Math.max(0, Math.min(255, Number(b) || 0)) / 255) * (s.max - s.min), s);

/** Validates { sliders, menus }. selfKeys: this integration's control keys; taken: ids already used. */
export function validateExtras(input, selfKeys = [], taken = []) {
  const errors = [];
  const obj = input && typeof input === "object" ? input : {};
  const sliders = Array.isArray(obj.sliders) ? obj.sliders : [];
  const menus = Array.isArray(obj.menus) ? obj.menus : [];
  if (obj.sliders !== undefined && !Array.isArray(obj.sliders)) errors.push("sliders: must be a list");
  if (obj.menus !== undefined && !Array.isArray(obj.menus)) errors.push("menus: must be a list");
  if (sliders.length > LIMITS.sliders) errors.push(`at most ${LIMITS.sliders} sliders`);
  if (menus.length > LIMITS.menus) errors.push(`at most ${LIMITS.menus} quick menus`);
  const ctx = { resolvable: (x) => typeof x === "string" && x.includes("."), selfKnown: (x) => selfKeys.length === 0 || selfKeys.includes(x) };
  const seen = new Set(taken);

  const cleanSliders = sliders.map((s, i) => {
    const at = `sliders[${i}]`;
    s = s && typeof s === "object" ? s : {};
    const name = String(s.name || "").trim();
    const label = name || at;
    if (!SLIDER_ID.test(s.id || "")) errors.push(`${label}: id must start with "slider_" (lower-case letters, digits, _)`);
    else if (seen.has(s.id)) errors.push(`${label}: id "${s.id}" is used twice`);
    seen.add(s.id);
    if (!name) errors.push(`${at}: give the slider a name`);
    if (!ctx.resolvable(s.entity)) errors.push(`${label}: pick a device`);
    const attr = s.attr ? String(s.attr) : "";
    if (attr && !/^[a-z0-9_]{1,40}$/.test(attr)) errors.push(`${label}: invalid attribute "${attr}"`);
    const min = Number(s.min ?? 0), max = Number(s.max ?? 100), step = Number(s.step ?? 1);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) errors.push(`${label}: the highest value must be above the lowest`);
    if (!(step > 0) || step > max - min) errors.push(`${label}: step must be above 0 and fit the range`);
    const out = { id: s.id, name: name.slice(0, 40), entity: s.entity, attr, min, max, step };
    if (s.icon) {
      if (!ICON_RE.test(String(s.icon))) errors.push(`${label}: icon must be custom:<file> or uc:<name>`);
      else out.icon = String(s.icon);
    }
    if (s.mode === "steps") {
      for (const k of ["up", "down"]) if (typeof s[k] !== "string" || !s[k].trim() || s[k].length > 64) errors.push(`${label}: pick the ${k} command`);
      const per = Number(s.per_press ?? step);
      if (!(per > 0)) errors.push(`${label}: each press must change the value by more than 0`);
      const delay = Number(s.delay ?? 200);
      if (!(delay >= 0 && delay <= LIMITS.delayMs)) errors.push(`${label}: pause between presses 0..${LIMITS.delayMs} ms`);
      Object.assign(out, { mode: "steps", up: s.up, down: s.down, per_press: per, delay });
      // a device that doesn't report its value: setting the bottom presses down the whole range (zero again)
      if (s.zeroSync === false) out.zeroSync = false;
    } else if (s.mode === "command" || s.mode === undefined) {
      if (typeof s.cmd !== "string" || !s.cmd.trim() || s.cmd.length > 64) errors.push(`${label}: pick the command that sets the value`);
      if (typeof s.param !== "string" || !/^[a-z0-9_]{1,40}$/.test(s.param)) errors.push(`${label}: pick the command's value parameter`);
      Object.assign(out, { mode: "command", cmd: s.cmd, param: s.param });
    } else {
      errors.push(`${label}: mode must be "command" or "steps"`);
    }
    return out;
  });

  const cleanMenus = menus.map((m, i) => {
    const at = `menus[${i}]`;
    m = m && typeof m === "object" ? m : {};
    const name = String(m.name || "").trim();
    const label = name || at;
    if (!MENU_ID.test(m.id || "")) errors.push(`${label}: id must start with "menu_" (lower-case letters, digits, _)`);
    else if (seen.has(m.id)) errors.push(`${label}: id "${m.id}" is used twice`);
    seen.add(m.id);
    if (!name) errors.push(`${at}: give the menu a name`);
    const opts = Array.isArray(m.options) ? m.options : [];
    if (!opts.length) errors.push(`${label}: add at least one choice`);
    if (opts.length > LIMITS.options) errors.push(`${label}: at most ${LIMITS.options} choices`);
    const labels = new Set();
    const options = opts.map((o, k) => {
      o = o && typeof o === "object" ? o : {};
      const l = String(o.label || "").trim();
      const p = `${label} › ${l || "choice " + (k + 1)}`;
      if (!l) errors.push(`${label}: choice ${k + 1} needs a label`);
      if (labels.has(l.toLowerCase())) errors.push(`${p}: label is used twice`);
      labels.add(l.toLowerCase());
      vActions(o.do ?? [], `${p} steps`, errors, ctx);
      if (Array.isArray(o.do) && !o.do.length) errors.push(`${p}: add at least one step`);
      if (o.when !== undefined && o.when !== null) vCond(o.when, `${p} current-when`, errors, ctx);
      const out = { label: l.slice(0, 40), do: Array.isArray(o.do) ? o.do : [] };
      if (o.when !== undefined && o.when !== null) out.when = o.when;
      return out;
    });
    const out = { id: m.id, name: name.slice(0, 40), options, cycle: m.cycle !== false };
    if (m.button && typeof m.button === "object" && (m.button.activity || m.button.button)) {
      const b = m.button;
      if (typeof b.activity !== "string" || !b.activity) errors.push(`${label}: pick the activity for the physical button`);
      if (!/^[A-Z0-9_]{1,24}$/.test(String(b.button || ""))) errors.push(`${label}: pick the physical button`);
      out.button = { activity: String(b.activity || ""), button: String(b.button || ""), press: b.press === "long_press" ? "long_press" : "short_press" };
    }
    if (m.icon) {
      if (!ICON_RE.test(String(m.icon))) errors.push(`${label}: icon must be custom:<file> or uc:<name>`);
      else out.icon = String(m.icon);
    }
    return out;
  });
  return { errors, extras: { sliders: cleanSliders, menus: cleanMenus } };
}

export class Extras {
  /**
   * @param {object} o
   * @param {() => object} o.getCore     CoreClient or null
   * @param {() => object} o.engine      SmartEngine (runs menu steps, tests conditions)
   * @param {string} o.file              config file
   * @param {(id: string, attrs: object) => void} o.publish  entity attribute update
   */
  constructor({ getCore, engine, file, publish, log, warn }) {
    Object.assign(this, { getCore, engine, file, publish, log, warn });
    this.sliders = [];
    this.menus = [];
    this.values = {}; // slider id -> last known value
    this.lastOn = {}; // slider id -> last value above min (for "on")
    this.picked = {}; // menu id -> last chosen label
    this.hold = {}; // id -> time until device reports are ignored
    this.queue = {}; // slider id -> { busy, next }
    this.errors = {}; // id -> last error text
    this.busy = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.sliders = Array.isArray(d.sliders) ? d.sliders : [];
      this.menus = Array.isArray(d.menus) ? d.menus : [];
      this.values = d.values && typeof d.values === "object" ? d.values : {};
      this.picked = d.picked && typeof d.picked === "object" ? d.picked : {};
    } catch {
      this.sliders = [];
      this.menus = [];
    }
  }
  save() {
    const values = Object.fromEntries(this.sliders.filter((s) => isNum(this.values[s.id])).map((s) => [s.id, this.values[s.id]]));
    const picked = Object.fromEntries(this.menus.filter((m) => this.picked[m.id]).map((m) => [m.id, this.picked[m.id]]));
    fs.writeFileSync(this.file, JSON.stringify({ sliders: this.sliders, menus: this.menus, values, picked }, null, 2));
  }
  /** Replaces the definitions (already validated). */
  replace({ sliders, menus }) {
    this.sliders = sliders;
    this.menus = menus;
    for (const s of sliders) if (isNum(this.values[s.id])) this.values[s.id] = snap(this.values[s.id], s);
    this.save();
  }
  get config() {
    return { sliders: this.sliders, menus: this.menus };
  }
  /** Something to poll: sliders that read a device, menus with "current when" conditions. */
  get enabled() {
    return this.sliders.some((s) => s.attr) || this.menus.some((m) => m.options.some((o) => o.when));
  }
  slider(id) {
    return this.sliders.find((s) => s.id === id);
  }
  menu(id) {
    return this.menus.find((m) => m.id === id);
  }

  // ---- attributes ---------------------------------------------------------
  sliderAttrs(s) {
    const v = this.values[s.id];
    if (!isNum(v)) return { state: "UNKNOWN", brightness: 0 };
    return { state: v > s.min ? "ON" : "OFF", brightness: toBrightness(v, s) };
  }
  menuAttrs(m) {
    return { state: "ON", options: m.options.map((o) => o.label), current_option: this.current?.[m.id] ?? this.picked[m.id] ?? "" };
  }
  initialAttrs(id) {
    const s = this.slider(id);
    if (s) return this.sliderAttrs(s);
    const m = this.menu(id);
    return m ? this.menuAttrs(m) : {};
  }
  publishAll() {
    for (const s of this.sliders) this.publish(s.id, this.sliderAttrs(s));
    for (const m of this.menus) this.publish(m.id, this.menuAttrs(m));
  }
  status() {
    const out = {};
    for (const s of this.sliders) out[s.id] = { value: isNum(this.values[s.id]) ? this.values[s.id] : null, error: this.errors[s.id] || null };
    for (const m of this.menus) out[m.id] = { current: this.current?.[m.id] ?? this.picked[m.id] ?? null, error: this.errors[m.id] || null };
    return out;
  }

  // ---- sliders ------------------------------------------------------------
  /**
   * Light command for a slider. cmd: on | off | toggle; brightness 0..255 (on only).
   * Returns once the value is queued; the device commands run in the background.
   */
  sliderCommand(id, cmd, brightness) {
    const s = this.slider(id);
    if (!s) throw new Error(`no slider ${id}`);
    const cur = this.values[id];
    const back = isNum(this.lastOn[id]) ? this.lastOn[id] : isNum(cur) && cur > s.min ? cur : snap((s.min + s.max) / 2, s);
    let target;
    if (cmd === "off" || (cmd === "toggle" && isNum(cur) && cur > s.min)) target = s.min;
    else if (cmd === "on" && brightness !== undefined) target = fromBrightness(brightness, s);
    else if (cmd === "on" || cmd === "toggle") target = back;
    else throw new Error(`unsupported command ${cmd}`);
    return this.setValue(id, target);
  }

  /** Sets a slider to a value (snapped to the range). Latest value wins while commands are running. */
  setValue(id, value) {
    const s = this.slider(id);
    if (!s) throw new Error(`no slider ${id}`);
    const target = snap(toNum(value), s);
    if (!Number.isFinite(target)) throw new Error("not a number");
    if (isNum(this.values[id]) && this.values[id] > s.min) this.lastOn[id] = this.values[id];
    if (target > s.min) this.lastOn[id] = target;
    this.hold[id] = Date.now() + HOLD_MS;
    const q = (this.queue[id] = this.queue[id] || { busy: null, next: null });
    q.next = target;
    if (!q.busy) {
      q.busy = (async () => {
        while (q.next !== null) {
          const t = q.next;
          q.next = null;
          try {
            await this.apply(s, t);
            this.errors[id] = null;
          } catch (e) {
            this.errors[id] = e.message;
            this.warn(`slider ${s.name}: ${e.message}`);
          }
        }
        q.busy = null;
        this.hold[id] = Date.now() + HOLD_MS;
        this.save();
      })();
    }
    return q.busy;
  }

  async send(entity, cmd_id, params) {
    const core = this.getCore();
    if (!core) throw new Error("not connected to the remote");
    await core.request("PUT", `/entities/${encodeURI(entity)}/command`, { cmd_id, ...(params ? { params } : {}) });
  }

  async apply(s, target) {
    if (s.mode === "steps") {
      let cur = this.values[s.id];
      if (s.attr) {
        try {
          const e = await this.getCore()?.get(`/entities/${encodeURI(s.entity)}`);
          const v = toNum(e?.attributes?.[s.attr]);
          if (Number.isFinite(v)) cur = v;
        } catch {}
      }
      if (!isNum(cur)) cur = s.min; // unknown: assume the bottom
      // no reported value: going to the bottom presses down the whole range (and a little more), so the device
      // really is at its lowest and the guessed value starts from zero again
      if (!s.attr && s.zeroSync !== false && target <= s.min) {
        const presses = Math.min(LIMITS.sweep, Math.ceil((s.max - s.min) / s.per_press) + 2);
        for (let i = 0; i < presses; i++) {
          await this.send(s.entity, s.down);
          if (i < presses - 1 && s.delay) await sleep(s.delay);
        }
        this.values[s.id] = s.min;
        this.log(`slider ${s.name}: back to ${s.min} (${presses} × ${s.down}, the whole range)`);
        this.publish(s.id, this.sliderAttrs(s));
        return;
      }
      const n = Math.round((target - cur) / s.per_press);
      const presses = Math.min(Math.abs(n), LIMITS.presses);
      const cmd = n > 0 ? s.up : s.down;
      for (let i = 0; i < presses; i++) {
        await this.send(s.entity, cmd);
        if (i < presses - 1 && s.delay) await sleep(s.delay);
      }
      const reached = snap(cur + Math.sign(n) * presses * s.per_press, s);
      this.values[s.id] = presses === Math.abs(n) ? target : reached;
      this.log(`slider ${s.name}: ${cur} → ${this.values[s.id]} (${presses} × ${cmd})`);
    } else {
      await this.send(s.entity, s.cmd, { [s.param]: target });
      this.values[s.id] = target;
      this.log(`slider ${s.name}: → ${target}`);
    }
    this.publish(s.id, this.sliderAttrs(s));
  }

  // ---- menus ---------------------------------------------------------------
  /** Select command for a menu. Runs the choice's steps in the background; resolves with the label. */
  menuCommand(id, cmd, params = {}) {
    const m = this.menu(id);
    if (!m) throw new Error(`no menu ${id}`);
    const labels = m.options.map((o) => o.label);
    const curLabel = this.current?.[id] ?? this.picked[id];
    let i = labels.indexOf(curLabel);
    // "Select next/previous" from a button: wraps around unless the menu says otherwise (or the command does)
    const cycle = params.cycle === undefined ? m.cycle !== false : params.cycle === true || params.cycle === "true";
    switch (cmd) {
      case "select_option":
        i = labels.findIndex((l) => l.toLowerCase() === String(params.option ?? "").toLowerCase());
        if (i < 0) throw new Error(`unknown choice ${params.option}`);
        break;
      case "select_first":
        i = 0;
        break;
      case "select_last":
        i = labels.length - 1;
        break;
      case "select_next":
        i = i < 0 ? 0 : cycle ? (i + 1) % labels.length : Math.min(i + 1, labels.length - 1);
        break;
      case "select_previous":
        i = i < 0 ? 0 : cycle ? (i - 1 + labels.length) % labels.length : Math.max(i - 1, 0);
        break;
      default:
        throw new Error(`unsupported command ${cmd}`);
    }
    return this.pick(m, m.options[i]);
  }

  async pick(m, opt) {
    this.picked[m.id] = opt.label;
    this.current = this.current || {};
    this.current[m.id] = opt.label;
    this.hold[m.id] = Date.now() + HOLD_MS * 2; // devices can take a while to switch input
    this.publish(m.id, this.menuAttrs(m));
    this.save();
    const summary = await this.engine().runSteps(`${m.name} → ${opt.label}`, opt.do);
    this.errors[m.id] = /: ERROR /.test(summary) ? summary.split(": ERROR ")[1] : null;
    return summary;
  }

  // ---- polling --------------------------------------------------------------
  refresh() {
    this.busy = this.busy.then(() => this._refresh()).catch((e) => this.warn("sliders/menus: update failed:", e.message));
    return this.busy;
  }

  async _refresh() {
    const core = this.getCore();
    if (!core) return;
    const now = Date.now();
    const attrsCache = new Map();
    const read = async (id) => {
      if (!attrsCache.has(id)) {
        try {
          const e = await core.get(`/entities/${encodeURI(id)}`);
          attrsCache.set(id, e?.attributes || {});
        } catch {
          attrsCache.set(id, null);
        }
      }
      return attrsCache.get(id);
    };
    for (const s of this.sliders) {
      if (!s.attr || this.queue[s.id]?.busy || (this.hold[s.id] || 0) > now) continue;
      const a = await read(s.entity);
      if (!a) continue;
      const v = toNum(a[s.attr]);
      if (!Number.isFinite(v)) continue;
      const val = Math.max(s.min, Math.min(s.max, v));
      if (val !== this.values[s.id]) {
        if (isNum(this.values[s.id]) && this.values[s.id] > s.min) this.lastOn[s.id] = this.values[s.id];
        this.values[s.id] = val;
        this.publish(s.id, this.sliderAttrs(s));
      }
    }
    this.current = this.current || {};
    const engine = this.engine();
    for (const m of this.menus) {
      if (!m.options.some((o) => o.when) || (this.hold[m.id] || 0) > now) continue;
      let hit = null;
      for (const o of m.options) {
        if (!o.when) continue;
        try {
          if (await engine.test(o.when, attrsCache)) {
            hit = o.label;
            break;
          }
        } catch {}
      }
      // No matching condition: show the last choice picked (if that one has no condition), else nothing.
      const fallback = m.options.find((o) => o.label === this.picked[m.id] && !o.when) ? this.picked[m.id] : "";
      const next = hit ?? fallback;
      if (next !== this.current[m.id]) {
        this.current[m.id] = next;
        this.publish(m.id, this.menuAttrs(m));
      }
    }
  }
}
