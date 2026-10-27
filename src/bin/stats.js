// Statistics: which activities are used, for how long, and how much battery they take while off the dock.
//
// Collected by the integration on the remote, over time, so the figures firm up the longer it runs:
// - activity uses: start / end, how long the screen was on, time off the dock and battery points used during it;
// - battery readings every few minutes (level, on the dock or not);
// - idle drain: battery used while off the dock with no activity on (and while the remote slept).
// Ticks come from the driver's settings poll (about every 20 s) while the remote is awake; a longer gap
// (the remote slept) is counted as idle, never as activity use.
import fs from "node:fs";

const DAY = 864e5;
const GAP_MS = 90 * 1000; // ticks further apart than this: the remote slept in between
const MIN_USE_MS = 30 * 1000; // shorter uses are left out (switching through; ticks are about 20 s apart)
const MAX_USES = 20000;
export const STATS_DEFAULTS = { on: true, every: 15, keepDays: 90 };
const isOn = (st) => /^(ON|RUNNING|COMPLETED)$/i.test(String(st || ""));
const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");

export class Stats {
  constructor({ file, log = () => {}, warn = () => {}, originalOf = (x) => x }) {
    this.file = file;
    this.log = log;
    this.warn = warn;
    this.originalOf = originalOf;
    const d = this.read();
    this.cfg = { ...STATS_DEFAULTS, ...(d.cfg || {}) };
    this.since = d.since || Date.now();
    this.uses = Array.isArray(d.uses) ? d.uses : []; // { id, name, start, end, screen, off, drain }
    this.open = d.open && typeof d.open === "object" ? d.open : {}; // id -> same, without end
    this.battery = Array.isArray(d.battery) ? d.battery : []; // [t, level, docked 0/1]
    this.idle = d.idle || { off: 0, drain: 0 }; // ms off the dock with nothing on, battery points used
    this.last = null; // { t, level, docked, screen }
    this.dirty = false;
    this.savedAt = 0;
  }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }
  save(force = false) {
    if (!this.dirty && !force) return;
    if (!force && Date.now() - this.savedAt < 5 * 60e3) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ v: 1, cfg: this.cfg, since: this.since, uses: this.uses, open: this.open, battery: this.battery, idle: this.idle }));
      this.dirty = false;
      this.savedAt = Date.now();
    } catch (e) { this.warn("statistics: saving failed:", e.message); }
  }

  /**
   * One tick: activities = [{ entity_id, name, attributes.state }] from GET /activities, screen = "on" | "off" | "unknown",
   * battery = { level, charging, on_charger } or null.
   */
  tick(now, activities, screen, battery) {
    if (!this.cfg.on) return;
    const level = Number.isFinite(battery?.level) ? battery.level : null;
    const docked = !!(battery && (battery.on_charger || battery.charging));
    const prev = this.last;
    const gap = !prev || now - prev.t > GAP_MS;
    const dt = gap ? 0 : now - prev.t;
    // battery points used since the last tick (only off the dock; a rise means charging)
    const drop = prev && level != null && prev.level != null && !docked && !prev.docked ? Math.max(0, prev.level - level) : 0;

    // which activities are on now (launcher copies count as their original)
    const on = new Map();
    for (const a of activities || []) {
      if (!a?.entity_id) continue;
      const st = a.attributes?.state ?? a.state;
      if (isOn(st)) { const id = this.originalOf(a.entity_id); if (!on.has(id)) on.set(id, nameOf(a.name) || id); }
    }
    // time and battery since the last tick go to what was on during it
    const openIds = Object.keys(this.open);
    if (gap && prev) {
      // the remote slept: the drop and the time asleep are idle drain (never activity use)
      if (!docked && !prev.docked) { this.idle.off += now - prev.t; this.idle.drain += drop; }
    } else if (dt) {
      if (openIds.length) {
        for (const id of openIds) {
          const u = this.open[id];
          if (screen === "on") u.screen += dt;
          if (!docked) { u.off += dt; u.drain += drop / openIds.length; }
        }
      } else if (!docked) { this.idle.off += dt; this.idle.drain += drop; }
    }
    // starts and ends
    for (const [id, name] of on) if (!this.open[id]) { this.open[id] = { id, name, start: now, screen: 0, off: 0, drain: 0 }; this.dirty = true; }
    for (const id of openIds) if (!on.has(id)) this.close(id, now);
    for (const [id, name] of on) if (this.open[id]) this.open[id].name = name;
    // battery reading every few minutes
    const lastB = this.battery[this.battery.length - 1];
    if (level != null && (!lastB || now - lastB[0] >= this.cfg.every * 60e3 - 5000)) { this.battery.push([now, level, docked ? 1 : 0]); this.dirty = true; }
    this.last = { t: now, level, docked, screen };
    this.prune(now);
    this.save();
  }
  close(id, now) {
    const u = this.open[id];
    delete this.open[id];
    this.dirty = true;
    if (!u || now - u.start < MIN_USE_MS) return;
    this.uses.push({ ...u, end: now, drain: Math.round(u.drain * 100) / 100 });
    if (this.uses.length > MAX_USES) this.uses.splice(0, this.uses.length - MAX_USES);
  }
  /** The remote went to sleep (or the integration stops): what's open stays open, the clock pauses. */
  pause() { this.last = null; this.save(true); }
  prune(now) {
    const cut = now - this.cfg.keepDays * DAY;
    if (this.uses.length && this.uses[0].end < cut) { this.uses = this.uses.filter((u) => u.end >= cut); this.dirty = true; }
    if (this.battery.length && this.battery[0][0] < cut) { this.battery = this.battery.filter((b) => b[0] >= cut); this.dirty = true; }
    if (this.since < cut) this.since = cut;
  }
  setConfig(c) {
    const every = [5, 15, 30].includes(Number(c.every)) ? Number(c.every) : this.cfg.every;
    const keepDays = [30, 90, 365].includes(Number(c.keepDays)) ? Number(c.keepDays) : this.cfg.keepDays;
    const onNow = typeof c.on === "boolean" ? c.on : this.cfg.on;
    if (!onNow && this.cfg.on) { for (const id of Object.keys(this.open)) this.close(id, Date.now()); this.last = null; }
    this.cfg = { on: onNow, every, keepDays };
    this.prune(Date.now());
    this.save(true);
    return this.cfg;
  }
  clear() {
    this.uses = []; this.open = {}; this.battery = []; this.idle = { off: 0, drain: 0 }; this.since = Date.now(); this.last = null;
    this.save(true);
  }
  /** Everything for the builder (open uses included, ending now). */
  data(now = Date.now()) {
    const open = Object.values(this.open).map((u) => ({ ...u, end: now, open: true }));
    return { cfg: this.cfg, since: this.since, now, uses: [...this.uses, ...open], battery: this.battery, idle: this.idle, size: this.size() };
  }
  size() { try { return fs.statSync(this.file).size; } catch { return 0; } }
  csv() {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const iso = (t) => new Date(t).toISOString();
    const lines = ["kind,activity,start,end,minutes_on,minutes_screen_on,minutes_off_dock,battery_points"];
    for (const u of this.data().uses) lines.push(["use", q(u.name), iso(u.start), iso(u.end), ((u.end - u.start) / 6e4).toFixed(1), (u.screen / 6e4).toFixed(1), (u.off / 6e4).toFixed(1), u.drain.toFixed(2)].join(","));
    for (const [t, l, d] of this.battery) lines.push(["battery", d ? "on the dock" : "", iso(t), "", "", "", "", l].join(","));
    return lines.join("\n") + "\n";
  }
}
