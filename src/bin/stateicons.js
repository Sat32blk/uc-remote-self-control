// State icons: a button on an activity page that changes its icon (or text) with a device's state.
//
// The button's own icon/text, captured when the state icon is created, is the default look. Each state
// (an attribute value such as "ON" or "HDMI1") can set its own icon and/or text. When no state matches,
// the button goes back to the default look.
//
// Tested on a Remote 3 (2026-10-14): changing a page of the activity on screen redraws the change live
// on a single-page activity, but on an activity with several pages the remote jumps back to page 1.
// So state icons are only allowed on activities with exactly one page.

import fs from "node:fs";

export const MAX_ICONS = 40;
export const MAX_STATES = 12;
const ICON_RE = /^(custom|uc):[A-Za-z0-9_.\-]{1,120}$/;

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
const norm = (v) => String(v ?? "").trim().toLowerCase();
const sameSpot = (a, b) => (a?.x ?? 0) === (b?.x ?? 0) && (a?.y ?? 0) === (b?.y ?? 0);

/** Look of a button for a value: the matching state over the default. */
export function lookFor(binding, value) {
  const d = binding.default || {};
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
    const states = Array.isArray(b.states) ? b.states : [];
    if (!states.length) errors.push(`${at}: add at least one state`);
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
    return {
      id,
      name: String(b.name || "").slice(0, 60),
      activity: b.activity,
      location: { x: loc.x, y: loc.y },
      entity: b.entity,
      attr,
      states: cleanStates
    };
  });
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
  async replace(icons) {
    const core = this.getCore();
    const old = new Map(this.icons.map((b) => [b.id, b]));
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
      const prev = old.get(b.id);
      if (prev && prev.activity === b.activity && sameSpot(prev.location, b.location) && prev.default) {
        next.push({ ...b, default: prev.default });
        continue;
      }
      const pages = await pageOf(b.activity);
      if (pages.length !== 1) {
        errors.push(`${b.name || b.id}: the activity must have exactly one page (it has ${pages.length})`);
        continue;
      }
      const item = (pages[0].items || []).find((it) => sameSpot(it.location, b.location));
      if (!item || !["icon", "text"].includes(item.type)) {
        errors.push(`${b.name || b.id}: no icon or text button at that spot on the page`);
        continue;
      }
      next.push({ ...b, page_id: pages[0].page_id, default: { type: item.type, icon: item.icon || null, text: item.text || null } });
    }
    if (errors.length) return { errors };
    // restore removed / moved ones
    const keep = new Set(next.map((b) => `${b.id}|${b.activity}|${b.location.x},${b.location.y}`));
    const restore = [...old.values()].filter((b) => !keep.has(`${b.id}|${b.activity}|${b.location.x},${b.location.y}`));
    for (const b of restore) {
      try {
        await this.write(core, b.activity, [{ location: b.location, look: { ...b.default } }]);
      } catch (e) {
        this.warn(`state icons: restoring ${b.name || b.id} failed:`, e.message);
      }
    }
    this.icons = next.map((b) => ({ ...b, page_id: b.page_id || old.get(b.id)?.page_id }));
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
    const values = new Map();
    for (const id of new Set(this.icons.map((b) => b.entity))) {
      try {
        const e = await core.get(`/entities/${encodeURI(id)}`);
        values.set(id, e?.attributes || {});
      } catch (e) {
        values.set(id, null);
      }
    }
    const byActivity = new Map();
    for (const b of this.icons) {
      const attrs = values.get(b.entity);
      const st = (this.status[b.id] = this.status[b.id] || {});
      if (!attrs) {
        st.error = "device not reachable";
        continue;
      }
      const value = attrs[b.attr];
      const look = lookFor(b, value);
      const key = JSON.stringify(look);
      st.value = value === undefined ? null : value;
      if (!force && st.key === key && !st.error) continue;
      (byActivity.get(b.activity) || byActivity.set(b.activity, []).get(b.activity)).push({ b, look, key });
    }
    for (const [activity, changes] of byActivity) {
      try {
        const missing = await this.write(core, activity, changes.map((c) => ({ location: c.b.location, look: c.look })));
        for (const c of changes) {
          const st = this.status[c.b.id];
          if (missing.has(`${c.b.location.x},${c.b.location.y}`)) {
            st.error = "the button is no longer at its spot on the page";
            st.key = null;
          } else {
            st.key = c.key;
            st.look = c.look.state ? c.look.state : "default";
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
