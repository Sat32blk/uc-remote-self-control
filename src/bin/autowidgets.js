// Auto Widgets: widgets on activity pages that follow rules (If / Else if / Otherwise, the Smart Controls conditions).
//
// Two kinds, because of how the remote redraws pages (tested on a Remote 3, 2026-11-09):
//   - a change to the page of a ONE-PAGE activity is drawn in place, so a "widget spot" places the devices'
//     REAL widgets (media widget, select, sensor) on the page, each at its own place and size, over the
//     user's icons if wanted. The icons are kept (the page as the user made it = the "base") and put back
//     when nothing is placed. Buttons, browsing and search then go straight to the device.
//   - on an activity with SEVERAL pages any page change jumps the remote back to page 1, so the widget on the
//     page must never change: a "Smart widget" is an entity of this integration (Smart Media Widget, Smart
//     Select, Smart Sensor), placed once on an empty spot, that shows whichever device the rules pick: it
//     copies that device's attributes, forwards button presses to it and passes browsing and search on.
//
// Config (autowidgets.json):
// { widgets: [ { id: "aw_…", name, kind: "spot"|"media"|"select"|"sensor", activity, page (page_id),
//                area: {x,y,w,h},
//                cases: [ { if: COND, show: <entity id>|"", type: "media_player"|"select"|"sensor", area?: {x,y,w,h} } ],
//                otherwise: { show, type, area? } } ],
//   bases: { <activity>: { page_id, items, ours, hash, wrote } } }   (one-page activities with spots)
// The first true case wins; otherwise the "otherwise" branch. Spots higher in the list win a spot two would cover.
import fs from "node:fs";
import { vCond } from "./smart.js";
import { takeTouched } from "./core.js";

export const AW_LIMITS = { widgets: 40, cases: 12, grid: 12 };
export const AW_KINDS = ["spot", "media", "select", "sensor"];
export const TYPE_OF = { media: "media_player", select: "select", sensor: "sensor" };
const ITEM_TYPES = ["media_player", "select", "sensor"];
const ID_RE = /^aw_[a-z0-9_]{1,40}$/;
export const AW_MIN_WRITE_MS = Number(process.env.UC_SELF_AW_WRITE_MS ?? 1000);

// attributes a Smart widget copies from the device it shows
export const COPY = {
  media: ["state", "media_title", "media_artist", "media_album", "media_image_url", "media_duration", "media_position",
    "media_position_updated_at", "media_type", "volume", "muted", "source", "source_list", "sound_mode", "sound_mode_list", "repeat", "shuffle"],
  select: ["state", "options", "current_option"],
  sensor: ["state", "value", "unit"]
};
// every feature either kind of player may have (fixed when the entity is made)
export const MEDIA_FEATURES = ["on_off", "toggle", "volume", "volume_up_down", "mute_toggle", "mute", "unmute", "play_pause", "stop",
  "next", "previous", "fast_forward", "rewind", "repeat", "shuffle", "seek", "media_duration", "media_position", "media_title",
  "media_artist", "media_album", "media_image_url", "media_type", "dpad", "home", "menu", "context_menu", "info", "settings",
  "select_source", "select_sound_mode", "channel_switcher", "play_media", "browse_media", "search_media"];

const hashOf = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };
const str = (v, max = 120) => (typeof v === "string" ? v.slice(0, max) : "");
export const overlap = (a, b) => !!a && !!b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
/** The cells a page item covers, as an area. */
export const areaOf = (it) => ({ x: it.location?.x ?? 0, y: it.location?.y ?? 0, w: it.size?.width ?? 1, h: it.size?.height ?? 1 });
/** The entity a widget item shows (media widget, select or sensor), else null. */
export const itemEntity = (it) => it?.media_player_id || it?.select?.select_id || it?.sensor?.sensor_id || null;

/** The page item for a device's widget. */
export function itemFor(type, entity, area) {
  const base = { location: { x: area.x, y: area.y }, size: { width: area.w, height: area.h } };
  if (type === "media_player") return { type, ...base, media_player_id: entity };
  if (type === "select") return { type, ...base, select: { select_id: entity } };
  return { type: "sensor", ...base, sensor: { sensor_id: entity, show_label: false } };
}

function vArea(a, p, errs, optional = false) {
  if (a === undefined || a === null) { if (!optional) errs.push(`${p}: place it on the page`); return null; }
  const n = (v) => (Number.isInteger(v) ? v : Number.NaN);
  const r = { x: n(a.x), y: n(a.y), w: n(a.w), h: n(a.h) };
  if (![r.x, r.y].every((v) => v >= 0 && v < AW_LIMITS.grid) || ![r.w, r.h].every((v) => v >= 1 && v <= AW_LIMITS.grid)) { errs.push(`${p}: a place on the page (column, row, width, height)`); return null; }
  return r;
}
function vShow(o, p, errs, kind) {
  const show = str(o?.show, 200);
  const type = kind === "spot" ? (show ? String(o?.type || "") : "") : TYPE_OF[kind];
  if (kind === "spot" && show && !ITEM_TYPES.includes(type)) errs.push(`${p}: pick a media widget, select or sensor`);
  if (show && !show.includes(".")) errs.push(`${p}: pick a device`);
  const out = { show, type };
  if (kind === "spot" && o?.area) out.area = vArea(o.area, `${p} place`, errs, true);
  return out;
}

/** Validates the widgets sent by the builder. Returns { errors, widgets }. */
export function validateAutoWidgets(body) {
  const errors = [];
  const list = Array.isArray(body?.widgets) ? body.widgets : null;
  if (!list) return { errors: ['"widgets" list missing'], widgets: [] };
  if (list.length > AW_LIMITS.widgets) errors.push(`at most ${AW_LIMITS.widgets} auto widgets`);
  const seen = new Set();
  const widgets = list.slice(0, AW_LIMITS.widgets).map((w, i) => {
    const name = str(w?.name, 60).trim();
    const at = name ? `"${name}"` : `widget ${i + 1}`;
    if (!name) errors.push(`${at}: give it a name`);
    const id = String(w?.id || "");
    if (!ID_RE.test(id)) errors.push(`${at}: id must look like aw_name`);
    if (seen.has(id)) errors.push(`${at}: two widgets have the id ${id}`);
    seen.add(id);
    const kind = AW_KINDS.includes(w?.kind) ? w.kind : (errors.push(`${at}: unknown kind`), "spot");
    const activity = str(w?.activity, 200);
    if (!activity) errors.push(`${at}: pick the activity`);
    const page = str(w?.page, 200);
    if (!page) errors.push(`${at}: pick the page`);
    const area = vArea(w?.area, at, errors);
    const cases = (Array.isArray(w?.cases) ? w.cases : []).slice(0, AW_LIMITS.cases + 1).map((c, k) => {
      const p = `${at}, ${k ? "else if " + k : "if"}`;
      if (c?.if === undefined) errors.push(`${p}: needs a condition`);
      else vCond(c.if, p, errors);
      return { if: c?.if, ...vShow(c, p, errors, kind) };
    });
    if (cases.length > AW_LIMITS.cases) errors.push(`${at}: at most ${AW_LIMITS.cases} branches`);
    const otherwise = vShow(w?.otherwise || {}, `${at}, otherwise`, errors, kind);
    return { id, name, kind, activity, page, area, cases, otherwise };
  });
  return { errors, widgets };
}

export class AutoWidgets {
  /**
   * @param o.getCore   () => CoreClient
   * @param o.test      async (cond, cache) => boolean (the smart engine's test)
   * @param o.publish   (widgetId, attrs) => void   attributes of a Smart widget entity
   * @param o.ownId     (widgetId) => the entity id on the remote ("self_control.main.aw_x")
   * @param o.instance  this integration's instance id on the remote ("self_control.main")
   */
  constructor({ getCore, test, publish = () => {}, ownId = (id) => "self_control.main." + id, instance = "self_control.main", file, now = () => Date.now(), log = () => {}, warn = () => {} }) {
    Object.assign(this, { getCore, test, publish, ownId, instance, file, now, log, warn });
    this.widgets = [];
    this.bases = {};
    this.status = {}; // id -> { branch, show, area, state, conds: [[bool]], error }
    this.paused = {}; // activity -> reason
    this.lastWrite = {};
    this.retry = {};
    this.values = new Map(); // entity -> attributes (events keep them fresh between reads)
    this.lastSent = {}; // widget id -> JSON of the attributes last published
    this.busy = Promise.resolve();
    this.soon = null;
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.widgets = Array.isArray(d.widgets) ? d.widgets : [];
      this.bases = d.bases && typeof d.bases === "object" ? d.bases : {};
    } catch { this.widgets = []; this.bases = {}; }
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify({ widgets: this.widgets, bases: this.bases }, null, 2)); } catch (e) { this.warn("auto widgets: couldn't save:", e.message); }
  }
  get enabled() { return this.widgets.length > 0; }
  smart() { return this.widgets.filter((w) => w.kind !== "spot"); }
  widget(id) { return this.widgets.find((w) => w.id === id); }

  /** Entities whose values the rules read or show (events for these trigger a check). */
  watched() {
    const out = new Set();
    const walk = (c) => { if (!c || typeof c !== "object") return; if (c.entity) out.add(c.entity); if (c.activity_on) out.add(c.activity_on); for (const k of ["all", "any"]) (c[k] || []).forEach(walk); if (c.not) walk(c.not); };
    for (const w of this.widgets) { for (const c of w.cases) { walk(c.if); if (c.show && w.kind !== "spot") out.add(c.show); } if (w.otherwise.show && w.kind !== "spot") out.add(w.otherwise.show); }
    return out;
  }

  /** An entity_change event from the remote. */
  event(id, attrs) {
    if (!this.enabled || !attrs) return;
    if (this.values.has(id)) this.values.set(id, { ...this.values.get(id), ...attrs });
    if (!this.watched().has(id)) return;
    // a shown device's attributes: publish at once; a condition: check soon (events come in bursts)
    for (const w of this.smart()) if (this.status[w.id]?.show === id) this.mirror(w, id);
    if (!this.soon) this.soon = setTimeout(() => { this.soon = null; this.refresh(); }, 120);
  }

  /** One check: evaluate every widget, publish Smart widgets, write the pages of spots that changed. */
  refresh(force = false) {
    this.busy = this.busy.then(() => this._refresh(force)).catch((e) => this.warn("auto widgets:", e.message));
    return this.busy;
  }

  async read(id, cache) {
    if (cache.has(id)) { this.values.set(id, cache.get(id)); return cache.get(id); }
    const e = await this.getCore().get(`/entities/${encodeURI(id)}`);
    const a = e?.attributes || {};
    cache.set(id, a);
    this.values.set(id, a);
    return a;
  }

  /** Which branch a widget uses now, with each condition's result (for the builder). */
  async decide(w, cache) {
    const conds = [];
    let branch = -1;
    for (let i = 0; i < w.cases.length; i++) {
      const c = w.cases[i].if;
      const parts = c && typeof c === "object" && (c.all || c.any) ? c.all || c.any : [c];
      const res = [];
      for (const p of parts) { try { res.push(!!(await this.test(p, cache))); } catch { res.push(false); } }
      conds.push(res);
      const ok = c && typeof c === "object" && c.any ? res.some(Boolean) : res.every(Boolean);
      if (branch < 0 && ok) branch = i;
    }
    const then = branch >= 0 ? w.cases[branch] : w.otherwise;
    return { branch, show: then.show || "", type: then.type || TYPE_OF[w.kind], area: then.area || w.area, conds };
  }

  async _refresh(force) {
    const core = this.getCore();
    if (!core || !this.widgets.length) return;
    const cache = new Map();
    const spotActs = new Map();
    for (const w of this.widgets) {
      let d;
      try { d = await this.decide(w, cache); } catch (e) { this.status[w.id] = { ...(this.status[w.id] || {}), error: e.message }; continue; }
      const st = (this.status[w.id] = { ...(this.status[w.id] || {}), ...d, error: null });
      if (w.kind === "spot") (spotActs.get(w.activity) || spotActs.set(w.activity, []).get(w.activity)).push({ w, d });
      else {
        st.state = d.show ? "showing" : "nothing";
        if (d.show) { try { await this.read(d.show, cache); } catch (e) { st.error = `can't read the device: ${e.message}`; } }
        this.mirror(w, d.show, force);
      }
    }
    for (const [act, list] of spotActs) await this.settleSpots(act, list, force);
  }

  /** Publishes what a Smart widget shows: the shown device's attributes. */
  mirror(w, show, force = false) {
    const src = show ? this.values.get(show) : null;
    const out = {};
    if (src) for (const k of COPY[w.kind]) if (src[k] !== undefined) out[k] = src[k];
    if (!out.state) out.state = show ? "UNKNOWN" : w.kind === "media" ? "OFF" : "UNAVAILABLE";
    if (w.kind === "sensor" && out.value === undefined) out.value = "";
    const sig = JSON.stringify(out);
    if (!force && this.lastSent[w.id] === sig) return;
    this.lastSent[w.id] = sig;
    this.publish(w.id, out);
  }

  /** The items a one-page activity should show now: its base, with the spots that show something on top. */
  layout(act, list) {
    const base = this.bases[act];
    const placed = [];
    for (const { w, d } of list) {
      const st = this.status[w.id];
      if (!d.show) { st.state = "hidden"; continue; }
      const hit = placed.find((p) => overlap(p.area, d.area));
      if (hit) { st.state = "blocked"; st.by = hit.w.name; continue; }
      st.state = "showing"; delete st.by;
      placed.push({ w, area: d.area, item: itemFor(d.type, d.show, d.area) });
    }
    const covered = (it) => placed.some((p) => overlap(p.area, areaOf(it)));
    const keep = (base?.items || []).filter((it) => !covered(it));
    return { items: [...keep, ...placed.map((p) => p.item)], ours: placed.map((p) => JSON.stringify(p.item)) };
  }

  async settleSpots(act, list, force) {
    const core = this.getCore();
    const base = this.bases[act];
    if (!base) { for (const { w } of list) this.status[w.id].error = "save the Auto Widgets again to start"; return; }
    if (this.paused[act]) { for (const { w } of list) this.status[w.id].error = this.paused[act]; return; }
    if (!force && hashOf(JSON.stringify(this.layout(act, list).items)) === base.wrote) return;
    const now = this.now();
    if (!force && now - (this.lastWrite[act] || 0) < AW_MIN_WRITE_MS) {
      if (!this.retry[act]) this.retry[act] = setTimeout(() => { delete this.retry[act]; this.refresh(); }, AW_MIN_WRITE_MS - (now - (this.lastWrite[act] || 0)) + 20);
      return;
    }
    try {
      await this.writePage(core, act, base, list);
      for (const { w } of list) this.status[w.id].at = new Date(now).toISOString();
    } catch (e) {
      for (const { w } of list) this.status[w.id].error = e.message;
      this.warn(`auto widgets: ${act}:`, e.message);
    }
  }

  /**
   * Writes a one-page activity's page. If the page was changed since our last write (Page Editor, web
   * configurator), those changes are taken into the base first, so icons added or moved meanwhile are kept.
   */
  async writePage(core, act, base, list) {
    const pages = (await core.get(`/activities/${encodeURI(act)}/ui/pages`)) || [];
    if (pages.length !== 1) throw new Error(`the activity now has ${pages.length} pages; widget spots only work on one-page activities`);
    const page = pages[0];
    takeTouched(act, page.page_id);
    if (base.hash && base.hash !== hashOf(JSON.stringify(page.items || []))) {
      base.items = this.baseFrom(base, page);
      this.log(`auto widgets: ${act} page was changed since the last update; the changes are kept`);
    }
    const { items, ours } = this.layout(act, list); // with the (maybe updated) base
    this.lastWrite[act] = this.now();
    await core.patch(`/activities/${encodeURI(act)}/ui/pages/${encodeURIComponent(page.page_id)}`, { items });
    let after = items;
    try { after = ((await core.get(`/activities/${encodeURI(act)}/ui/pages`)) || [])[0]?.items || items; takeTouched(act, page.page_id); } catch {}
    base.hash = hashOf(JSON.stringify(after));
    base.wrote = hashOf(JSON.stringify(items));
    base.ours = ours;
    this.save();
    this.log(`auto widgets: ${act} page updated (${ours.length} widget${ours.length === 1 ? "" : "s"} placed)`);
  }

  /**
   * The page as the user made it: the current page without the widgets we placed, plus the icons we had
   * covered (and so took off the page) that nothing took the place of since. Icons the user deleted stay deleted.
   */
  baseFrom(old, page) {
    const cur = page.items || [];
    if (old && old.hash === hashOf(JSON.stringify(cur))) return old.items; // untouched since our last write
    // our widgets, recognised by kind, device and place (an editor may save them with extra fields)
    const sig = (it) => `${it.type}|${itemEntity(it)}|${JSON.stringify(areaOf(it))}`;
    const oursItems = (old?.ours || []).map((j) => { try { return JSON.parse(j); } catch { return null; } }).filter(Boolean);
    const ourSigs = new Set(oursItems.map(sig));
    const kept = cur.filter((it) => !(itemEntity(it) && ourSigs.has(sig(it))));
    // icons our widgets covered: in the base, under one of our widgets (so not on the page now)
    const hidden = (old?.items || []).filter((it) => oursItems.some((o) => overlap(areaOf(o), areaOf(it))));
    const back = hidden.filter((it) => !kept.some((k) => overlap(areaOf(k), areaOf(it))));
    return [...kept, ...back];
  }

  /** Adds entities to an activity's included devices (needed before its pages may show them). */
  async include(core, act, ids) {
    const a = await core.get(`/activities/${encodeURI(act)}`);
    const inc = (a?.options?.included_entities || []).map((x) => x.entity_id).filter(Boolean);
    const add = [...new Set(ids)].filter((id) => id && !inc.includes(id));
    if (add.length) await core.patch(`/activities/${encodeURI(act)}`, { options: { entity_ids: [...inc, ...add] } });
    return add;
  }

  /** Makes sure a Smart widget's entity is added to the remote (it's offered once the entities are registered). */
  async addToRemote(core, id) {
    try { await core.get(`/entities/${encodeURI(id)}`); return false; } catch (e) { if (e.status && e.status !== 404) throw e; }
    try { await core.get(`/intg/instances/${encodeURIComponent(this.instance)}/entities?filter=NEW&reload=true&limit=100`); } catch {}
    await core.post(`/intg/instances/${encodeURIComponent(this.instance)}/entities`, [id.slice(this.instance.length + 1)]);
    return true;
  }

  /**
   * Replaces all widgets (already validated). Spots: the one-page activities' bases are taken (and the page
   * of an activity that has no spots any more is put back). Smart widgets: added to the remote and the
   * activity, and placed on their page (moved if their place changed; removed widgets taken off).
   * Returns { errors, notes }.
   */
  async replace(widgets, { beforePlace = async () => {} } = {}) {
    const core = this.getCore();
    if (!core) return { errors: ["not connected to the remote"], notes: [] };
    const errors = [], notes = [];
    const pagesOf = new Map();
    const getPages = async (act) => { if (!pagesOf.has(act)) pagesOf.set(act, (await core.get(`/activities/${encodeURI(act)}/ui/pages`)) || []); return pagesOf.get(act); };
    // checks first, nothing written yet
    for (const w of widgets) {
      let pages;
      try { pages = await getPages(w.activity); } catch (e) { errors.push(`${w.name}: can't read the activity: ${e.message}`); continue; }
      const page = pages.find((p) => p.page_id === w.page);
      if (!page) { errors.push(`${w.name}: its page isn't in the activity any more`); continue; }
      const g = page.grid || { width: 4, height: 6 };
      for (const a of [w.area, ...w.cases.map((c) => c.area), w.otherwise.area].filter(Boolean)) if (a.x + a.w > g.width || a.y + a.h > g.height) errors.push(`${w.name}: a place goes past the ${g.width} × ${g.height} page`);
      if (w.kind === "spot" && pages.length !== 1) errors.push(`${w.name}: widget spots need a one-page activity (it has ${pages.length} pages); use a Smart widget there`);
      if (w.kind !== "spot" && pages.length > 1) {
        const own = this.ownId(w.id);
        const busy = (page.items || []).filter((it) => itemEntity(it) !== own && overlap(areaOf(it), w.area));
        if (busy.length) errors.push(`${w.name}: its place isn't empty on that page (a page with several pages can only take widgets on empty spots)`);
      }
    }
    for (let i = 0; i < widgets.length; i++) for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i], b = widgets[j];
      if (a.kind !== "spot" && b.kind !== "spot" && a.activity === b.activity && a.page === b.page && overlap(a.area, b.area)) errors.push(`${a.name} and ${b.name} are on the same place`);
    }
    if (errors.length) return { errors, notes };

    const old = this.widgets;
    this.widgets = widgets;
    this.paused = {};
    this.status = {};
    this.lastSent = {};
    await beforePlace(); // the driver registers the Smart widget entities, so the remote can add them

    // spots: bases of the one-page activities
    const spotActs = new Set(widgets.filter((w) => w.kind === "spot").map((w) => w.activity));
    for (const act of spotActs) {
      try {
        const page = (await getPages(act))[0];
        const old = this.bases[act];
        this.bases[act] = { page_id: page.page_id, items: this.baseFrom(old, page), ours: old?.ours || [], hash: hashOf(JSON.stringify(page.items || [])) };
        const shows = widgets.filter((w) => w.kind === "spot" && w.activity === act).flatMap((w) => [...w.cases, w.otherwise].map((c) => c.show)).filter(Boolean);
        const added = await this.include(core, act, shows);
        if (added.length) notes.push(`${added.length} device${added.length > 1 ? "s" : ""} added to the activity, so its page can show ${added.length > 1 ? "them" : "it"}`);
      } catch (e) { errors.push(`spots on ${act}: ${e.message}`); }
    }
    for (const act of Object.keys(this.bases)) {
      if (spotActs.has(act)) continue;
      try {
        const pages = await getPages(act);
        if (pages.length === 1) {
          const items = this.baseFrom(this.bases[act], pages[0]);
          await core.patch(`/activities/${encodeURI(act)}/ui/pages/${encodeURIComponent(pages[0].page_id)}`, { items });
          notes.push("a page without spots now got its own icons back");
        }
      } catch (e) { this.warn(`auto widgets: restoring ${act}:`, e.message); }
      delete this.bases[act];
    }

    // Smart widgets: on the remote, in the activity, on their page
    const smartNow = widgets.filter((w) => w.kind !== "spot");
    const gone = old.filter((o) => o.kind !== "spot" && !smartNow.some((w) => w.id === o.id));
    const touchActs = new Set([...smartNow.map((w) => w.activity), ...gone.map((o) => o.activity)]);
    for (const w of smartNow) {
      const own = this.ownId(w.id);
      try {
        if (await this.addToRemote(core, own)) notes.push(`${w.name} added to the remote`);
        await this.include(core, w.activity, [own]);
      } catch (e) { errors.push(`${w.name}: couldn't add it to the remote (${e.message}). Add it under Integrations → Remote Self-Control, then save again.`); }
    }
    for (const act of touchActs) {
      let pages;
      try { pagesOf.delete(act); pages = await getPages(act); } catch (e) { errors.push(`${act}: ${e.message}`); continue; }
      for (const page of pages) {
        const mineHere = smartNow.filter((w) => w.activity === act && w.page === page.page_id);
        const ownIds = new Set([...smartNow, ...gone].map((w) => this.ownId(w.id)));
        const items = (page.items || []).filter((it) => !ownIds.has(itemEntity(it)));
        for (const w of mineHere) items.push(itemFor(TYPE_OF[w.kind], this.ownId(w.id), w.area));
        if (JSON.stringify(items) === JSON.stringify(page.items || [])) continue;
        try {
          await core.patch(`/activities/${encodeURI(act)}/ui/pages/${encodeURIComponent(page.page_id)}`, { items });
          takeTouched(act, page.page_id);
        } catch (e) { errors.push(`${act}: placing the Smart widgets failed: ${e.message}`); }
      }
    }
    for (const id of Object.keys(this.lastSent)) if (!this.widget(id)) delete this.lastSent[id];
    this.save();
    await this.refresh(true);
    return { errors, notes };
  }

  /** A button pressed on a Smart widget: sent to the device it shows. */
  async command(id, cmdId, params) {
    const w = this.widget(id), core = this.getCore();
    const target = this.status[id]?.show;
    if (!w || !core) return { ok: false, status: 503 };
    if (!target) return { ok: false, status: 409 };
    const prefix = w.kind === "media" ? "media_player." : w.kind === "select" ? "select." : "";
    const cmd = cmdId.includes(".") ? cmdId : prefix + cmdId;
    try {
      await core.request("PUT", `/entities/${encodeURI(target)}/command`, { cmd_id: cmd, ...(params && Object.keys(params).length ? { params } : {}) });
      return { ok: true };
    } catch (e) {
      this.warn(`auto widgets: ${w.name} ${cmdId} → ${target}:`, e.message);
      return { ok: false, status: e.status || 500 };
    }
  }

  /** Media browsing / search on a Smart Media Widget: asked of the device it shows, through the core. */
  async browse(id, opts = {}, what = "browse") {
    const core = this.getCore(), target = this.status[id]?.show;
    if (!core || !target) return 404;
    const q = new URLSearchParams();
    if (what === "search") q.set("query", String(opts.query || ""));
    if (opts.media_id !== undefined && opts.media_id !== null) q.set("media_id", opts.media_id);
    if (opts.media_type !== undefined && opts.media_type !== null) q.set("media_type", opts.media_type);
    if (opts.stable_ids) q.set("stable_ids", "true");
    q.set("page", String(opts.paging?.page || 1));
    q.set("limit", String(opts.paging?.limit || 10));
    try {
      const r = await core.getPaged(`/entities/${encodeURI(target)}/media/${what}?${q}`);
      if (what === "search") {
        const list = Array.isArray(r.data) ? r.data : r.data?.media || [];
        return { media: list, pagination: { page: r.page ?? 1, limit: r.limit ?? list.length, count: r.count ?? list.length } };
      }
      const items = r.data?.media?.items?.length ?? 0;
      return { media: r.data?.media, pagination: { page: r.page ?? Number(q.get("page")), limit: r.limit ?? Number(q.get("limit")), count: r.count ?? items } };
    } catch (e) {
      this.warn(`auto widgets: ${what} on ${target}:`, e.message);
      return e.status || 500;
    }
  }

  view() {
    return { widgets: this.widgets, status: this.status, paused: this.paused };
  }
}
