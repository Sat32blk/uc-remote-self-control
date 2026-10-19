// Device states: what the integrations report for a device (its attributes on the remote), read live
// for the builder, plus every value seen so far, so state icons and smart-control conditions can offer
// values like an audio format that only shows up now and then. Devices can be watched in the background.
import fs from "node:fs";

export const REMOTE_ID = "self:remote";
const MAX_VALUES = 60; // per device and attribute
const MAX_WATCH = 30;
const SKIP = new Set(["media_image_url", "media_position", "media_position_updated_at", "media_duration"]);
const nameOf = (n) => (typeof n === "string" ? n : n?.en || Object.values(n || {})[0] || "");

export class DeviceStates {
  constructor({ getCore, file, remote = null, log = () => {}, warn = () => {} }) {
    Object.assign(this, { getCore, file, remote, log, warn });
    this.seen = {}; // entity -> attr -> [values]  (numbers: { min, max })
    this.watched = [];
    this.dirty = false;
    this.load();
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (d.seen && typeof d.seen === "object") this.seen = d.seen;
      if (Array.isArray(d.watched)) this.watched = d.watched.filter((x) => typeof x === "string").slice(0, MAX_WATCH);
    } catch {}
  }
  save() {
    if (!this.dirty) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ seen: this.seen, watched: this.watched }));
      this.dirty = false;
    } catch (e) {
      this.warn("states: couldn't save:", e.message);
    }
  }

  /** Remembers the values in a set of attributes. */
  record(entity, attrs) {
    const s = (this.seen[entity] = this.seen[entity] || {});
    for (const [k, v] of Object.entries(attrs || {})) {
      if (SKIP.has(k) || Array.isArray(v) || v === null || v === undefined || typeof v === "object") continue;
      if (typeof v === "number") {
        const r = s[k] && !Array.isArray(s[k]) ? s[k] : { min: v, max: v };
        const n = { min: Math.min(r.min, v), max: Math.max(r.max, v) };
        if (!s[k] || n.min !== r.min || n.max !== r.max || Array.isArray(s[k])) { s[k] = n; this.dirty = true; }
        continue;
      }
      const val = String(v).slice(0, 120);
      if (val === "") continue;
      const list = Array.isArray(s[k]) ? s[k] : (s[k] = []);
      if (!list.includes(val)) {
        list.push(val);
        if (list.length > MAX_VALUES) list.shift();
        this.dirty = true;
      }
    }
  }

  /** Reads a device now. */
  async read(entity) {
    if (entity === REMOTE_ID && this.remote) {
      // the remote itself: its settings (screen brightness, …) and this integration's controls (backlight color, …)
      const { attributes, labels } = this.remote();
      this.record(entity, attributes);
      this.save();
      return { id: entity, name: "This remote", type: "remote_self", attributes, labels, lists: {}, seen: this.seen[entity] || {}, watched: this.watched.includes(entity) };
    }
    const core = this.getCore();
    if (!core) throw new Error("The integration isn't connected to the remote.");
    const e = await core.get(`/entities/${encodeURI(entity)}`);
    if (!e) throw new Error("device not found");
    const a = e.attributes || {};
    this.record(entity, a);
    this.save();
    const attributes = {}, lists = {};
    for (const [k, v] of Object.entries(a)) {
      if (k === "media_image_url") continue;
      if (Array.isArray(v)) lists[k] = v.map(String);
      else attributes[k] = v;
    }
    return { id: entity, name: nameOf(e.name) || entity, type: e.entity_type, attributes, lists, seen: this.seen[entity] || {}, watched: this.watched.includes(entity) };
  }

  watch(entity, on) {
    const has = this.watched.includes(entity);
    if (on && !has) {
      if (this.watched.length >= MAX_WATCH) throw new Error(`at most ${MAX_WATCH} devices can be watched`);
      this.watched.push(entity);
    }
    if (!on && has) this.watched = this.watched.filter((x) => x !== entity);
    this.dirty = true;
    this.save();
    return this.watched;
  }

  /** Background: reads the watched devices (called from the driver's refresh loop). */
  async poll() {
    const core = this.getCore();
    if (!core || !this.watched.length) return;
    for (const id of this.watched) {
      if (id === REMOTE_ID) { if (this.remote) this.record(id, this.remote().attributes); continue; }
      try {
        const e = await core.get(`/entities/${encodeURI(id)}`);
        if (e) this.record(id, e.attributes || {});
      } catch {}
    }
    this.save();
  }

  forget(entity) {
    delete this.seen[entity];
    this.dirty = true;
    this.save();
  }
}
