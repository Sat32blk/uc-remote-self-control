// Controls: one "Control" media player that the volume rocker and the touch slider are pointed at.
// Turning on a "Control: <name>" switch makes them change that control's target (a light, a device's
// volume, a slider, the remote's own screen or key brightness). With no control on, they do the
// activity's defaults (or nothing). The rocker can be "borrowed": it stays mapped to the TV and is
// mapped to Control only while a control is on.
import fs from "node:fs";

export const LIMITS = { controls: 30, activities: 40 };
const TARGET_TYPES = ["display", "backlight", "light", "volume", "slider"];
const BUTTONS = ["VOLUME_UP", "VOLUME_DOWN"];
const ENTITY = "self_control.main.control";
const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);

function vTarget(t, at, errors, { allowNull }) {
  if (t === null || t === undefined || t === "") {
    if (!allowNull) errors.push(`${at}: pick what it changes`);
    return null;
  }
  if (typeof t !== "object" || !TARGET_TYPES.includes(t.type)) { errors.push(`${at}: unknown target`); return null; }
  if (["light", "volume"].includes(t.type) && !(typeof t.entity === "string" && t.entity)) { errors.push(`${at}: pick a device`); return null; }
  if (t.type === "slider" && !(typeof t.id === "string" && /^slider_[a-z0-9_]{1,36}$/.test(t.id))) { errors.push(`${at}: pick a slider`); return null; }
  const out = { type: t.type };
  if (t.entity) out.entity = String(t.entity);
  if (t.id) out.id = String(t.id);
  if (t.name) out.name = String(t.name).slice(0, 60);
  return out;
}

/** Checks a Controls configuration from the builder. Returns { errors, config }. */
export function validateControls(input) {
  const errors = [];
  const c = input && typeof input === "object" ? input : {};
  const timeout = Number(c.timeout ?? 8);
  if (!(timeout === 0 || (Number.isInteger(timeout) && timeout >= 2 && timeout <= 600))) errors.push("timeout: 2–600 seconds, or 0 = stay on until changed");
  const acts = Array.isArray(c.activities) ? c.activities : [];
  if (acts.length > LIMITS.activities) errors.push(`at most ${LIMITS.activities} activities`);
  const seenAct = new Set();
  const activities = acts.map((a, i) => {
    const at = `activity ${a?.name || i + 1}`;
    if (!a || typeof a.activity !== "string" || !a.activity) errors.push(`${at}: pick an activity`);
    if (seenAct.has(a?.activity)) errors.push(`${at}: listed twice`);
    seenAct.add(a?.activity);
    return {
      activity: String(a?.activity || ""),
      name: String(a?.name || "").slice(0, 60),
      buttons: vTarget(a?.buttons, `${at} (rocker default)`, errors, { allowNull: true }),
      slider: vTarget(a?.slider, `${at} (touch slider default)`, errors, { allowNull: true }),
      borrow: a?.borrow !== false
    };
  });
  const list = Array.isArray(c.controls) ? c.controls : [];
  if (list.length > LIMITS.controls) errors.push(`at most ${LIMITS.controls} controls`);
  const ids = new Set();
  const controls = list.map((x, i) => {
    const name = String(x?.name || "").trim().slice(0, 40);
    const at = `control ${name || i + 1}`;
    if (!name) errors.push(`${at}: a name is required`);
    let id = String(x?.id || "");
    if (!/^control_[a-z0-9_]{1,30}$/.test(id) || id === "control_level" || id === "control_active") id = "control_" + (slugOf(name) || "x" + (i + 1));
    if (id === "control_level" || id === "control_active") id += "_1";
    while (ids.has(id)) id += "_";
    ids.add(id);
    const start = Number(x?.start ?? 50);
    if (!(start >= 0 && start <= 100)) errors.push(`${at}: starting value 0–100 %`);
    const step = Number(x?.step ?? 5);
    if (!(Number.isInteger(step) && step >= 1 && step <= 25)) errors.push(`${at}: change per press 1–25 %`);
    // startFrom: "last" = the value it was left at; "start" = back to the starting value each time it's turned on
    return { id, name, target: vTarget(x?.target, at, errors, { allowNull: false }), start: pct(start), step, startFrom: x?.startFrom === "start" ? "start" : "last" };
  });
  return { errors, config: { timeout, activities, controls } };
}

export class Controls {
  /**
   * @param {object} o
   * @param {() => any} o.getCore
   * @param {() => any} o.extras        the sliders (Extras)
   * @param {() => any} o.cache         cached /cfg (display, button)
   * @param {(section: string, changes: object) => Promise<void>} o.patchSection
   * @param {(id: string, attrs: object) => void} o.publish
   */
  constructor({ getCore, extras, cache, patchSection, publish, file, log = () => {}, warn = () => {} }) {
    Object.assign(this, { getCore, extras, cache, patchSection, publish, file, log, warn });
    this.config = { timeout: 8, activities: [], controls: [] };
    this.remembered = {}; // control id -> last value (targets that don't report one)
    this.borrowed = {}; // activity id -> { VOLUME_UP: original short_press | null, ... }
    this.alias = { originalOf: (x) => x }; // smart launcher copies use their original's row (set by the driver)
    this.active = null;
    this.value = 50; // what Control shows (0..100)
    this.timer = null;
    this.queue = { busy: null, next: null };
    this.actCache = { at: 0, on: [] };
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const v = validateControls(d.config || {});
      if (!v.errors.length) this.config = v.config;
      this.remembered = d.remembered && typeof d.remembered === "object" ? d.remembered : {};
      this.borrowed = d.borrowed && typeof d.borrowed === "object" ? d.borrowed : {};
    } catch {}
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ config: this.config, remembered: this.remembered, borrowed: this.borrowed }, null, 2));
    } catch (e) {
      this.warn("controls: couldn't save:", e.message);
    }
  }
  async replace(config) {
    const was = this.active;
    if (was && !config.controls.some((c) => c.id === was)) await this.deactivate("removed");
    this.config = config;
    this.save();
    if (this.active) await this.syncBorrow();
    this.publishAll();
  }

  get controls() { return this.config.controls; }
  control(id) { return this.config.controls.find((c) => c.id === id); }

  // ---- reading and writing targets ------------------------------------------------------------
  targetName(t) {
    if (!t) return "nothing";
    if (t.type === "display") return "Screen brightness";
    if (t.type === "backlight") return "Button backlight";
    if (t.type === "slider") return this.extras()?.slider(t.id)?.name || t.name || t.id;
    return t.name || t.entity;
  }

  async read(t) {
    const c = this.cache() || {};
    if (t.type === "display") return isNum(c.display?.brightness) ? c.display.brightness : null;
    if (t.type === "backlight") return isNum(c.button?.brightness) ? c.button.brightness : null;
    if (t.type === "slider") {
      const x = this.extras(); const s = x?.slider(t.id);
      const v = s ? x.values[s.id] : undefined;
      return s && isNum(v) ? pct(((v - s.min) / (s.max - s.min)) * 100) : null;
    }
    const core = this.getCore();
    if (!core) return null;
    try {
      const e = await core.get(`/entities/${encodeURI(t.entity)}`);
      const a = e?.attributes || {};
      if (t.type === "light") return a.state === "OFF" ? 0 : isNum(a.brightness) ? pct((a.brightness / 255) * 100) : null;
      return isNum(a.volume) ? pct(a.volume) : null;
    } catch {
      return null;
    }
  }

  async write(t, v) {
    if (t.type === "display") return this.patchSection("display", { brightness: Math.max(1, v), auto_brightness: false });
    if (t.type === "backlight") return this.patchSection("button", { brightness: v });
    if (t.type === "slider") {
      const x = this.extras(); const s = x?.slider(t.id);
      if (!s) throw new Error("the slider no longer exists");
      return x.setValue(s.id, s.min + (v / 100) * (s.max - s.min));
    }
    const core = this.getCore();
    if (!core) throw new Error("not connected to the remote");
    const body = t.type === "light"
      ? v <= 0 ? { cmd_id: "light.off" } : { cmd_id: "light.on", params: { brightness: Math.round((v / 100) * 255) } }
      : { cmd_id: "media_player.volume", params: { volume: v } };
    await core.request("PUT", `/entities/${encodeURI(t.entity)}/command`, body);
  }

  async send(entity, cmd_id) {
    const core = this.getCore();
    if (!core) throw new Error("not connected to the remote");
    await core.request("PUT", `/entities/${encodeURI(entity)}/command`, { cmd_id });
  }

  /** Sends the latest level to a target; values arriving while one is sent replace each other. */
  set(t, v, onDone) {
    this.queue.next = { t, v, onDone };
    if (this.queue.busy) return this.queue.busy;
    this.queue.busy = (async () => {
      while (this.queue.next) {
        const job = this.queue.next;
        this.queue.next = null;
        try {
          await this.write(job.t, job.v);
          job.onDone && job.onDone();
        } catch (e) {
          this.warn(`control: setting ${this.targetName(job.t)} failed:`, e.message);
        }
      }
      this.queue.busy = null;
    })();
    return this.queue.busy;
  }

  // ---- activities -----------------------------------------------------------------------------
  async activitiesOn() {
    const core = this.getCore();
    if (!core) return [];
    if (Date.now() - this.actCache.at < 3000) return this.actCache.on;
    const on = [];
    try {
      for (let page = 1; page <= 10; page++) {
        const part = await core.get(`/activities?limit=100&page=${page}`);
        if (!Array.isArray(part) || !part.length) break;
        for (const a of part) if ((a.attributes?.state || a.state) === "ON") on.push(a.entity_id);
        if (part.length < 100) break;
      }
    } catch (e) {
      this.warn("control: couldn't read the activities:", e.message);
    }
    this.actCache = { at: Date.now(), on };
    return on;
  }
  /** The defaults of the running activity (the first running one that has a row). */
  async defaults() {
    const on = (await this.activitiesOn()).map((id) => this.alias.originalOf(id));
    return this.config.activities.find((a) => on.includes(a.activity)) || null;
  }

  // ---- borrowing the volume rocker ----------------------------------------------------------
  async borrowActivities() {
    // the running activity itself: a launcher copy borrows with its original's setting
    const on = await this.activitiesOn();
    return on.filter((id) => this.config.activities.some((a) => a.borrow && a.activity === this.alias.originalOf(id)));
  }
  async borrow(activity) {
    const core = this.getCore();
    if (!core || this.borrowed[activity]) return;
    const list = await core.get(`/activities/${encodeURI(activity)}/buttons`);
    const orig = {};
    for (const b of BUTTONS) {
      const cur = (Array.isArray(list) ? list : []).find((x) => x.button === b)?.short_press || null;
      orig[b] = cur && cur.entity_id === ENTITY ? null : cur; // never "restore" to ourselves
    }
    this.borrowed[activity] = orig;
    this.save(); // saved before changing anything, so a restart can put them back
    const act = await core.get(`/activities/${encodeURI(activity)}`);
    const included = (act?.options?.included_entities || []).map((x) => x.entity_id).filter(Boolean);
    if (!included.includes(ENTITY)) await core.patch(`/activities/${encodeURI(activity)}`, { options: { entity_ids: [...included, ENTITY] } });
    await core.patch(`/activities/${encodeURI(activity)}/buttons/VOLUME_UP`, { short_press: { entity_id: ENTITY, cmd_id: "media_player.volume_up" } });
    await core.patch(`/activities/${encodeURI(activity)}/buttons/VOLUME_DOWN`, { short_press: { entity_id: ENTITY, cmd_id: "media_player.volume_down" } });
    this.log(`control: volume rocker of ${activity} now goes to Control`);
  }
  async giveBack(activity) {
    const core = this.getCore();
    const orig = this.borrowed[activity];
    if (!core || !orig) return;
    for (const b of BUTTONS) {
      const o = orig[b];
      const path = `/activities/${encodeURI(activity)}/buttons/${b}`;
      try {
        const list = await core.get(`/activities/${encodeURI(activity)}/buttons`);
        const cur = (Array.isArray(list) ? list : []).find((x) => x.button === b)?.short_press;
        if (cur && cur.entity_id !== ENTITY) continue; // the user changed it meanwhile: keep theirs
        if (o) await core.patch(path, { short_press: { entity_id: o.entity_id, cmd_id: o.cmd_id, ...(o.params && Object.keys(o.params).length ? { params: o.params } : {}) } });
        else await core.request("DELETE", `${path}/short_press`);
      } catch (e) {
        this.warn(`control: restoring ${b} of ${activity} failed:`, e.message);
        return; // keep the record and try again later
      }
    }
    delete this.borrowed[activity];
    this.save();
    this.log(`control: volume rocker of ${activity} is back to normal`);
  }
  async syncBorrow() {
    const want = this.active ? await this.borrowActivities() : [];
    for (const a of Object.keys(this.borrowed)) if (!want.includes(a)) await this.giveBack(a);
    for (const a of want) {
      try { await this.borrow(a); } catch (e) { this.warn(`control: borrowing the rocker of ${a} failed:`, e.message); }
    }
  }
  /** On start: put back any rocker a previous run left borrowed. */
  async recover() {
    if (!Object.keys(this.borrowed).length) return;
    this.log("control: restoring volume rockers left borrowed");
    for (const a of Object.keys(this.borrowed)) await this.giveBack(a);
  }

  // ---- switching ------------------------------------------------------------------------------
  async activate(id) {
    const c = this.control(id);
    if (!c) throw new Error(`no control ${id}`);
    const prev = this.active;
    this.active = id;
    const v = await this.read(c.target);
    this.value = isNum(v) ? v : c.startFrom !== "start" && isNum(this.remembered[id]) ? this.remembered[id] : c.start;
    this.log(`control: ${c.name} on${prev && prev !== id ? ` (was ${this.control(prev)?.name})` : ""}, ${this.targetName(c.target)} at ${this.value} %`);
    this.publishAll();
    this.arm();
    await this.syncBorrow();
  }
  async deactivate(why = "off") {
    if (!this.active) return;
    const c = this.control(this.active);
    this.active = null;
    clearTimeout(this.timer);
    this.log(`control: ${c?.name || "?"} ${why}`);
    const d = await this.defaults();
    if (d?.slider) { const v = await this.read(d.slider); if (isNum(v)) this.value = v; }
    this.publishAll();
    await this.syncBorrow();
  }
  arm() {
    clearTimeout(this.timer);
    if (!this.active || !this.config.timeout) return;
    this.timer = setTimeout(() => this.deactivate(`off after ${this.config.timeout} s without use`).catch((e) => this.warn("control:", e.message)), this.config.timeout * 1000);
  }

  // ---- commands from the remote ---------------------------------------------------------------
  async switchCommand(id, cmd) {
    if (cmd === "on" || (cmd === "toggle" && this.active !== id)) return this.activate(id);
    if (this.active === id) return this.deactivate("off");
  }

  async controlCommand(cmd, params = {}) {
    const c = this.active && this.control(this.active);
    if (cmd === "volume_up" || cmd === "volume_down") {
      const dir = cmd === "volume_up" ? 1 : -1;
      if (c) {
        this.value = pct(this.value + dir * c.step);
        this.remember(c);
        this.publishAll();
        this.arm();
        return this.set(c.target, this.value);
      }
      const d = await this.defaults();
      const t = d?.buttons;
      if (!t) return this.publishAll(); // nothing to do here
      if (t.type === "volume") {
        await this.send(t.entity, cmd === "volume_up" ? "media_player.volume_up" : "media_player.volume_down");
        const v = await this.read(t);
        if (isNum(v)) { this.value = v; this.publishAll(); }
        return;
      }
      const cur = await this.read(t);
      this.value = pct((isNum(cur) ? cur : this.value) + dir * 5);
      this.publishAll();
      return this.set(t, this.value);
    }
    if (cmd === "volume") {
      const v = pct(params.volume);
      if (c) {
        this.value = v;
        this.remember(c);
        this.publishAll();
        this.arm();
        return this.set(c.target, v);
      }
      const d = await this.defaults();
      if (!d?.slider) { this.publishAll(); return; }
      this.value = v;
      this.publishAll();
      return this.set(d.slider, v);
    }
    if (["on", "off", "toggle", "mute_toggle", "mute", "unmute"].includes(cmd)) return this.publishAll();
    throw new Error(`unsupported command ${cmd}`);
  }

  /**
   * For devices that don't report a value: set what the control thinks the value is (default: its starting
   * value) without sending anything to the device. Returns the new value.
   */
  reset(id, value) {
    const c = this.control(id);
    if (!c) throw new Error(`no control ${id}`);
    const v = value === undefined || value === null || value === "" ? c.start : Number(value);
    if (!(v >= 0 && v <= 100)) throw new Error("value 0–100 %");
    this.remembered[id] = Math.round(v);
    if (this.active === id) { this.value = Math.round(v); this.publishAll(); }
    this.save();
    this.log(`control: ${c.name} value reset to ${Math.round(v)} %`);
    return Math.round(v);
  }

  remember(c) {
    if (["light", "display", "backlight"].includes(c.target.type)) return; // these report their level
    this.remembered[c.id] = this.value;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1500);
  }

  // ---- what the remote shows ------------------------------------------------------------------
  activeText() {
    const c = this.active && this.control(this.active);
    return c ? `${c.name} · ${this.value} %` : "None";
  }
  publishAll() {
    this.publish("control", { state: "ON", volume: this.value, muted: false, media_title: this.active ? this.control(this.active)?.name || "" : "", media_artist: this.activeText() });
    this.publish("control_level", { state: this.value > 0 ? "ON" : "OFF", brightness: Math.round((this.value / 100) * 255) });
    this.publish("control_active", { state: "ON", value: this.activeText() });
    for (const c of this.controls) this.publish(c.id, { state: this.active === c.id ? "ON" : "OFF" });
  }
  /** Keeps the slider position in step with the default target when nothing is on (screen brightness changes elsewhere). */
  async refresh() {
    if (this.active || this.queue.busy) return;
    const d = await this.defaults();
    if (!d?.slider) return;
    const v = await this.read(d.slider);
    if (isNum(v) && v !== this.value) { this.value = v; this.publishAll(); }
  }
  status() {
    return { active: this.active, value: this.value, text: this.activeText(), borrowed: Object.keys(this.borrowed), remembered: { ...this.remembered } };
  }
}
