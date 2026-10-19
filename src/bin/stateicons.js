// State icons: a button on an activity page that changes its icon (or text) with a device's state.
//
// The button's own icon/text, captured when the state icon is created, is the default look. Each state
// (an attribute value such as "ON" or "HDMI1") can set its own icon and/or text. When no state matches,
// the button goes back to the default look.
//
// Tested on a Remote 3 (2026-10-14): changing a page of the activity on screen redraws the change live
// on a single-page activity, but on an activity with several pages the remote jumps back to page 1.
// So state icons are only allowed on activities with exactly one page.
//
// A state icon can also be a *level graphic*: kind "level" with a range (min..max) and 11 frames
// (0 %, 10 % … 100 %). The frame closest to the device's value is shown, like a volume bar.

import fs from "node:fs";

export const MAX_ICONS = 60;
export const MAX_DEVICES = 25; // different devices the state icons watch (each is read every 2 s)
export const MAX_STATES = 24;
export const LEVEL_FRAMES = 11;
export const MAX_CELLS = 24;

/**
 * The spots a binding controls: one button, or (level graphics over several tiles) a rectangle of
 * buttons, each with its own 11 frames and its own default look.
 */
export function spotsOf(b) {
  if (b.kind === "level" && Array.isArray(b.cells) && b.cells.length) {
    return b.cells.map((c, k) => ({ location: { x: c.x, y: c.y }, frames: c.frames, def: b.cellDefaults?.[k] || null }));
  }
  return [{ location: b.location, frames: b.frames, def: b.default || null }];
}
const spotKey = (activity, loc) => `${activity}|${loc.x},${loc.y}`;
const ICON_RE = /^(custom|uc):[A-Za-z0-9_.\-]{1,120}$/;

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
const norm = (v) => String(v ?? "").trim().toLowerCase();
const sameSpot = (a, b) => (a?.x ?? 0) === (b?.x ?? 0) && (a?.y ?? 0) === (b?.y ?? 0);

/** Frame index (0..10) for a value in a level binding, or null when the value isn't a number. */
export function levelIndex(binding, value) {
  const v = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  if (!Number.isFinite(v)) return null;
  const f = (v - binding.min) / (binding.max - binding.min);
  return Math.round(Math.max(0, Math.min(1, f)) * (LEVEL_FRAMES - 1));
}

/** Look of a button for a value: the matching state (or level frame) over the default. */
export function lookFor(binding, value) {
  const d = binding.default || {};
  if (binding.kind === "level") {
    const i = levelIndex(binding, value);
    if (i === null) return { type: d.type, icon: d.icon, text: d.text, state: null };
    return { type: "icon", icon: binding.frames[i], text: d.text, state: `${i * 10} %` };
  }
  const st = (binding.states || []).find((s) => norm(s.value) === norm(value));
  if (!st) return { type: d.type, icon: d.icon, text: d.text, state: null };
  if (st.icon) return { type: "icon", icon: st.icon, text: st.text ?? d.text, state: st.value };
  if (st.text) return { type: "text", icon: d.icon, text: st.text, state: st.value };
  return { type: d.type, icon: d.icon, text: d.text, state: st.value };
}

/** The page item with a look applied (command, location and size untouched). */
export function applyLook(item, look) {
  const out = { ...item, type: look.type };
  if (look.type === "icon") out.icon = look.icon;
  else delete out.icon;
  if (look.text) out.text = String(look.text).slice(0, 50);
  else delete out.text;
  return out;
}

/** Validates the bindings sent by the builder. Returns { errors, icons }. */
export function validateIcons(input) {
  const errors = [];
  const list = Array.isArray(input?.icons) ? input.icons : null;
  if (!list) return { errors: ['"icons" list missing'], icons: [] };
  if (list.length > MAX_ICONS) errors.push(`at most ${MAX_ICONS} state icons`);
  const seen = new Set();
  const icons = list.map((b, i) => {
    const at = `icons[${i}]`;
    const id = String(b.id || "");
    if (!/^[a-z0-9_]{2,40}$/.test(id)) errors.push(`${at}.id: lower-case letters, digits and _ (2–40)`);
    if (seen.has(id)) errors.push(`${at}.id "${id}" is used twice`);
    seen.add(id);
    if (!b.activity || typeof b.activity !== "string") errors.push(`${at}: pick an activity`);
    const loc = b.location || {};
    if (!Number.isInteger(loc.x) || !Number.isInteger(loc.y) || loc.x < 0 || loc.y < 0) errors.push(`${at}: pick a button on the page`);
    if (!b.entity || typeof b.entity !== "string") errors.push(`${at}: pick a device`);
    const attr = String(b.attr || "state");
    if (!/^[a-z0-9_]{1,40}$/.test(attr)) errors.push(`${at}.attr: invalid attribute name`);
    const level = b.kind === "level";
    let levelOut = {};
    if (level) {
      const min = Number(b.min), max = Number(b.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) errors.push(`${at}: the level's highest value must be above the lowest`);
      const okFrames = (f) => Array.isArray(f) && f.length === LEVEL_FRAMES && f.every((x) => ICON_RE.test(String(x)));
      let cells = null;
      if (Array.isArray(b.cells) && b.cells.length) {
        if (b.cells.length > MAX_CELLS) errors.push(`${at}: at most ${MAX_CELLS} buttons for one level graphic`);
        cells = b.cells.map((c) => ({ x: c?.x, y: c?.y, frames: Array.isArray(c?.frames) ? c.frames.map(String) : [] }));
        if (!cells.every((c) => Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0)) errors.push(`${at}: invalid button positions`);
        if (!cells.every((c) => okFrames(c.frames))) errors.push(`${at}: pick a level design (its images are missing)`);
      }
      const frames = cells ? cells[0].frames : Array.isArray(b.frames) ? b.frames.map(String) : [];
      if (!cells && !okFrames(frames)) errors.push(`${at}: pick a level design (its ${LEVEL_FRAMES} images are missing)`);
      levelOut = { kind: "level", min, max, frames, design: String(b.design || "").slice(0, 30), color: String(b.color || "").slice(0, 20) };
      if (cells) levelOut.cells = cells;
      // colors by value: [{ from: 0–100 %, color: "#rrggbb" }] (baked into the frames by the builder; kept for editing)
      if (Array.isArray(b.colors) && b.colors.length) {
        const cs = b.colors.slice(0, 6).map((c) => ({ from: Number(c?.from), color: String(c?.color || "") }));
        if (!cs.every((c) => Number.isFinite(c.from) && c.from >= 0 && c.from <= 100 && /^#[0-9a-f]{6}$/i.test(c.color))) errors.push(`${at}: color by value needs a % (0–100) and a color for each step`);
        else levelOut.colors = cs.sort((x, y) => x.from - y.from);
      }
      if (b.show === "change") {
        const ms = Number(b.showMs ?? 4000);
        if (!(ms >= 1000 && ms <= 60000)) errors.push(`${at}: show the level for 1–60 seconds`);
        Object.assign(levelOut, { show: "change", showMs: ms });
      }
      if (b.fit === "keep") levelOut.fit = "keep";
      if (b.sig && /^[a-z0-9_]{1,64}$/.test(String(b.sig))) levelOut.sig = String(b.sig); // builder's fingerprint of the drawn frames
      if (b.slider && /^slider_[a-z0-9_]{1,36}$/.test(String(b.slider))) levelOut.slider = String(b.slider); // level graphic of a slider
      if (b.bg && ICON_RE.test(String(b.bg))) levelOut.bg = String(b.bg); // drawn over the button's own picture
      if ([1, 0.8, 0.6].includes(Number(b.scale))) levelOut.scale = Number(b.scale);
    }
    const states = level ? [] : Array.isArray(b.states) ? b.states : [];
    if (!level && !states.length) errors.push(`${at}: add at least one state`);
    if (states.length > MAX_STATES) errors.push(`${at}: at most ${MAX_STATES} states`);
    const values = new Set();
    const cleanStates = states.map((s, k) => {
      const v = String(s.value ?? "").trim();
      if (!v) errors.push(`${at}.states[${k}]: value missing`);
      if (values.has(norm(v))) errors.push(`${at}.states[${k}]: "${v}" is listed twice`);
      values.add(norm(v));
      const icon = s.icon ? String(s.icon) : null;
      if (icon && !ICON_RE.test(icon)) errors.push(`${at}.states[${k}]: icon must be custom:<file> or uc:<name>`);
      const text = s.text ? String(s.text).slice(0, 50) : null;
      if (!icon && !text) errors.push(`${at}.states[${k}] (${v || "?"}): drop an image or type a label`);
      return { value: v, icon, text };
    });
    const first = levelOut.cells ? levelOut.cells[0] : loc;
    return {
      id,
      name: String(b.name || "").slice(0, 60),
      activity: b.activity,
      location: { x: first.x, y: first.y },
      entity: b.entity,
      attr,
      states: cleanStates,
      ...levelOut
    };
  });
  const devices = new Set(icons.map((b) => b.entity).filter(Boolean));
  if (devices.size > MAX_DEVICES) errors.push(`state icons can watch at most ${MAX_DEVICES} different devices (now ${devices.size}); several icons on the same device count once`);
  return { errors, icons };
}

export class StateIcons {
  constructor({ getCore, file, log, warn }) {
    this.getCore = getCore;
    this.file = file;
    this.log = log;
    this.warn = warn;
    this.icons = [];
    this.status = {}; // id -> { value, look, error, at }
    this.busy = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.icons = Array.isArray(data.icons) ? data.icons : [];
    } catch {
      this.icons = [];
    }
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify({ icons: this.icons }, null, 2));
  }
  get enabled() {
    return this.icons.length > 0;
  }

  /** Single-page activities with their page, plus the multi-page ones (listed as unavailable). */
  async activities() {
    const core = this.getCore();
    const list = [];
    for (let page = 1; page <= 20; page++) {
      const part = await core.get(`/activities?limit=100&page=${page}`);
      if (!Array.isArray(part) || !part.length) break;
      list.push(...part);
      if (part.length < 100) break;
    }
    const out = [];
    for (const a of list) {
      if (!a?.entity_id || a.options?.editable === false) continue;
      let pages = [];
      try {
        pages = (await core.get(`/activities/${encodeURI(a.entity_id)}/ui/pages`)) || [];
      } catch {}
      out.push({ id: a.entity_id, name: nameOf(a.name) || a.entity_id, pageCount: pages.length, page: pages.length === 1 ? pages[0] : null });
    }
    return out.sort((x, y) => (y.pageCount === 1) - (x.pageCount === 1) || x.name.localeCompare(y.name));
  }

  /**
   * Replaces all bindings (already validated). New ones capture the button's current look as default;
   * existing ones (same id, activity and spot) keep their stored default. Bindings that were removed
   * get their default look back.
   */
  /** hints: optional Map "activity|x,y" -> default look (from a backup), used when no old binding knows it. */
  async replace(icons, hints = null) {
    const core = this.getCore();
    const old = new Map(this.icons.map((b) => [b.id, b]));
    // default look per spot of the old bindings (a spot another state icon controlled shows that one's look now)
    const oldDefaults = new Map();
    for (const o of old.values()) for (const sp of spotsOf(o)) if (sp.def) oldDefaults.set(spotKey(o.activity, sp.location), sp.def);
    const pageCache = new Map();
    const pageOf = async (activity) => {
      if (!pageCache.has(activity)) {
        const pages = (await core.get(`/activities/${encodeURI(activity)}/ui/pages`)) || [];
        pageCache.set(activity, pages);
      }
      return pageCache.get(activity);
    };
    const errors = [];
    const next = [];
    for (const b of icons) {
      const spots = spotsOf(b);
      const pages = await pageOf(b.activity);
      if (pages.length !== 1) {
        errors.push(`${b.name || b.id}: the activity must have exactly one page (it has ${pages.length})`);
        continue;
      }
      const defs = [];
      let bad = false;
      for (const sp of spots) {
        const kept = oldDefaults.get(spotKey(b.activity, sp.location)) || hints?.get(`${b.activity}|${sp.location.x},${sp.location.y}`);
        if (kept) { defs.push({ ...kept }); continue; }
        const item = (pages[0].items || []).find((it) => sameSpot(it.location, sp.location));
        if (!item || !["icon", "text"].includes(item.type)) { bad = true; break; }
        defs.push({ type: item.type, icon: item.icon || null, text: item.text || null });
      }
      if (bad) {
        errors.push(`${b.name || b.id}: ${spots.length > 1 ? "every spot of the shape needs an icon or text button" : "no icon or text button at that spot on the page"}`);
        continue;
      }
      const out = { ...b, page_id: pages[0].page_id, default: defs[0] };
      if (spots.length > 1) out.cellDefaults = defs;
      else delete out.cellDefaults;
      next.push(out);
    }
    if (errors.length) return { errors };
    // restore spots that no binding controls any more
    const taken = new Set(next.flatMap((b) => spotsOf(b).map((sp) => spotKey(b.activity, sp.location))));
    const byAct = new Map();
    for (const o of old.values()) for (const sp of spotsOf(o)) {
      if (taken.has(spotKey(o.activity, sp.location)) || !sp.def) continue;
      (byAct.get(o.activity) || byAct.set(o.activity, []).get(o.activity)).push({ location: sp.location, look: { ...sp.def } });
    }
    for (const [act, changes] of byAct) {
      try {
        await this.write(core, act, changes);
      } catch (e) {
        this.warn(`state icons: restoring buttons failed:`, e.message);
      }
    }
    this.icons = next;
    this.status = {};
    this.save();
    await this.refresh(true);
    return { errors: [] };
  }

  /** One poll: read the watched devices and update the buttons whose look changed. */
  refresh(force = false) {
    this.busy = this.busy.then(() => this._refresh(force)).catch((e) => this.warn("state icons: update failed:", e.message));
    return this.busy;
  }

  async _refresh(force) {
    const core = this.getCore();
    if (!core || !this.icons.length) return;
    const t0 = Date.now();
    const values = new Map();
    for (const id of new Set(this.icons.map((b) => b.entity))) {
      try {
        const e = await core.get(`/entities/${encodeURI(id)}`);
        values.set(id, e?.attributes || {});
      } catch (e) {
        values.set(id, null);
      }
    }
    const readDone = Date.now();
    const byActivity = new Map();
    const now = Date.now();
    for (const b of this.icons) {
      const attrs = values.get(b.entity);
      const st = (this.status[b.id] = this.status[b.id] || {});
      if (!attrs) {
        st.error = "device not reachable";
        continue;
      }
      const value = attrs[b.attr];
      // "show on change": the level appears when the value changes and hides again after showMs
      let visible = true;
      if (b.kind === "level" && b.show === "change") {
        if (st.seen && JSON.stringify(value) !== JSON.stringify(st.lastValue)) st.showUntil = now + (b.showMs || 4000);
        st.seen = true;
        st.lastValue = value;
        visible = (st.showUntil || 0) > now;
      }
      const spots = spotsOf(b);
      const looks = spots.map((sp) => {
        if (!visible) return { type: sp.def?.type, icon: sp.def?.icon, text: sp.def?.text, state: null };
        if (b.kind === "level") {
          const i = levelIndex(b, value);
          if (i === null) return { type: sp.def?.type, icon: sp.def?.icon, text: sp.def?.text, state: null };
          return { type: "icon", icon: sp.frames[i], text: spots.length > 1 ? null : sp.def?.text, state: `${i * 10} %` };
        }
        return lookFor(b, value);
      });
      const key = JSON.stringify(looks);
      st.value = value === undefined ? null : value;
      if (!force && st.key === key && !st.error) continue;
      (byActivity.get(b.activity) || byActivity.set(b.activity, []).get(b.activity)).push({ b, looks, spots, key });
    }
    for (const [activity, changes] of byActivity) {
      try {
        const missing = await this.write(core, activity, changes.flatMap((c) => c.spots.map((sp, k) => ({ location: sp.location, look: c.looks[k] }))));
        for (const c of changes) {
          const st = this.status[c.b.id];
          if (c.spots.some((sp) => missing.has(`${sp.location.x},${sp.location.y}`))) {
            st.error = c.spots.length > 1 ? "a button of the shape is no longer on the page" : "the button is no longer at its spot on the page";
            st.key = null;
          } else {
            st.key = c.key;
            st.look = c.looks[0].state ? c.looks[0].state : "default";
            st.error = null;
            st.at = new Date().toISOString();
          }
        }
      } catch (e) {
        const isNew = changes.some((c) => this.status[c.b.id].error !== e.message);
        for (const c of changes) {
          this.status[c.b.id].error = e.message;
          this.status[c.b.id].key = null;
        }
        if (isNew) this.warn(`state icons: updating ${activity} failed:`, e.message);
      }
    }
    // how long one check took, shown in the builder so the load on the remote can be seen
    this.lastCheck = { ms: Date.now() - t0, readMs: readDone - t0, devices: values.size, pagesWritten: byActivity.size, at: new Date().toISOString() };
  }

  /** Writes looks to the single page of an activity. Returns the spots that had no button. */
  async write(core, activity, changes) {
    const pages = (await core.get(`/activities/${encodeURI(activity)}/ui/pages`)) || [];
    if (pages.length !== 1) throw new Error(`the activity now has ${pages.length} pages; state icons only work on single-page activities`);
    const page = pages[0];
    const missing = new Set();
    let changed = false;
    const items = (page.items || []).map((it) => {
      const c = changes.find((x) => sameSpot(x.location, it.location));
      if (!c || !["icon", "text"].includes(it.type)) return it;
      const next = applyLook(it, c.look);
      if (JSON.stringify(next) !== JSON.stringify(it)) changed = true;
      return next;
    });
    for (const c of changes) {
      if (!(page.items || []).some((it) => sameSpot(it.location, c.location) && ["icon", "text"].includes(it.type))) missing.add(`${c.location.x},${c.location.y}`);
    }
    if (changed) await core.patch(`/activities/${encodeURI(activity)}/ui/pages/${encodeURIComponent(page.page_id)}`, { items });
    return missing;
  }

  list() {
    return this.icons.map((b) => ({ ...b, status: this.status[b.id] || {} }));
  }
}
