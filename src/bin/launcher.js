// Smart launchers: one button that opens the activity the conditions pick, optionally with extra steps
// after it starts.
//
// Why copies: the remote only switches to an activity's screen when the press itself is a direct
// activity.start of that activity (tested on a Remote 3, 2026-10-21: a macro, or a command sent by an
// integration, starts it but the screen stays where it is). So the choice has to be made before the press:
//   - each target of a launcher gets an activity copy ("launcher copy"), cloned from the original activity,
//     whose start sequence is the original's plus the launcher's extra steps, if any;
//   - the launcher's buttons (page buttons, physical buttons, home screen tiles) start one of the copies;
//     the rules (if / otherwise) pick which, and the buttons are re-pointed whenever the pick changes,
//     so the press is always a plain activity.start that opens the screen;
//   - the copies are kept like their original (devices, sequences, pages, physical buttons) and are put in
//     the same activity groups, so switching between the original and its copy doesn't turn devices off.
//
// The rest of the integration treats a copy as its original (↩ history, start pages, state icons,
// Controls): see originalOf() / copiesOf().
//
// Config: { launchers: [{ id, name, icon?, targets: [{ activity, steps: [{ entity_id, cmd_id, params? }],
//   delay? }], rules: [{ if: COND, target: activity }], otherwise: activity }] }
import fs from "node:fs";
import { freeSpot } from "./returnbtn.js";

export const LIMITS = { launchers: 20, targets: 6, branches: 8, steps: 4, delayMs: 30000, places: 40 };
const START = ["activity.start", "activity.on"];
const COPY_NOTE = "Self-Control launcher copy of ";

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
const hashOf = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };
const list = (x) => (Array.isArray(x) ? x : []);
const enc = (id) => encodeURI(id);

/** Validates launchers. vCond(cond, path, errs) checks a condition. Returns { errors, launchers }. */
export function validateLaunchers(input, vCond = () => {}) {
  const errors = [];
  const arr = Array.isArray(input?.launchers) ? input.launchers : Array.isArray(input) ? input : null;
  if (!arr) return { errors: ['"launchers" list missing'], launchers: [] };
  if (arr.length > LIMITS.launchers) errors.push(`at most ${LIMITS.launchers} launchers`);
  const ids = new Set();
  const launchers = arr.slice(0, LIMITS.launchers).map((l, i) => {
    const name = String(l?.name || "").trim().slice(0, 40);
    const at = `launcher ${name || i + 1}`;
    if (!name) errors.push(`${at}: give it a name`);
    let id = String(l?.id || "").trim();
    if (!/^launch_[a-z0-9_]{1,40}$/.test(id)) id = "launch_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || String(i + 1)).slice(0, 40);
    if (ids.has(id)) errors.push(`${at}: two launchers have the id ${id}`);
    ids.add(id);
    const seen = new Set();
    const targets = list(l?.targets).slice(0, LIMITS.targets + 1).map((t, k) => {
      const tat = `${at}, activity ${k + 1}`;
      const activity = String(t?.activity || "");
      if (!activity) errors.push(`${tat}: pick the activity`);
      if (seen.has(activity)) errors.push(`${tat}: listed twice`);
      seen.add(activity);
      const steps = list(t?.steps).slice(0, LIMITS.steps + 1).map((s, j) => {
        const entity_id = String(s?.entity_id || "");
        const cmd_id = String(s?.cmd_id || "");
        if (!entity_id || !cmd_id) errors.push(`${tat}, extra step ${j + 1}: pick the device and its command`);
        const out = { entity_id, cmd_id };
        if (s?.params && typeof s.params === "object" && !Array.isArray(s.params) && Object.keys(s.params).length) out.params = s.params;
        return out;
      });
      if (steps.length > LIMITS.steps) errors.push(`${tat}: at most ${LIMITS.steps} extra steps`);
      const delay = Math.round(Number(t?.delay) || 0);
      if (delay < 0 || delay > LIMITS.delayMs) errors.push(`${tat}: the wait before the extra steps must be 0–${LIMITS.delayMs / 1000} s`);
      return { activity, steps, delay: Math.max(0, Math.min(LIMITS.delayMs, delay)) };
    });
    if (!targets.length) errors.push(`${at}: add at least one activity`);
    if (targets.length > LIMITS.targets) errors.push(`${at}: at most ${LIMITS.targets} activities`);
    const acts = new Set(targets.map((t) => t.activity));
    const rules = list(l?.rules).slice(0, LIMITS.branches + 1).map((r, k) => {
      const target = String(r?.target || "");
      if (!acts.has(target)) errors.push(`${at}, branch ${k + 1}: pick one of the launcher's activities`);
      if (r?.if === undefined) errors.push(`${at}, branch ${k + 1}: needs a condition`);
      else vCond(r.if, `${at}, branch ${k + 1}`, errors);
      return { if: r?.if, target };
    });
    if (rules.length > LIMITS.branches) errors.push(`${at}: at most ${LIMITS.branches} branches`);
    let otherwise = String(l?.otherwise || "");
    if (otherwise && !acts.has(otherwise)) errors.push(`${at}: "otherwise" must be one of the launcher's activities`);
    if (!otherwise && targets[0]) otherwise = targets[0].activity;
    const icon = /^(uc|custom):[A-Za-z0-9_.\-]{1,120}$/.test(String(l?.icon || "")) ? String(l.icon) : null;
    return { id, name, icon, targets, rules, otherwise };
  });
  return { errors, launchers };
}

export class Launchers {
  /**
   * @param o.getCore   () => CoreClient
   * @param o.onScreen  () => id of the activity on screen (or null)
   * @param o.test      async (cond) => boolean (the smart engine's condition test)
   * @param o.file      where launchers, their copies and found buttons are kept
   * @param o.hooks     { normItem(activity, item) -> item, managedButtons(activity) -> Set,
   *                      buttonOverride(activity, button) -> short_press|undefined, ownOrder(activity) -> [page_id]|null,
   *                      copyChanged(copyId) }
   */
  constructor({ getCore, onScreen = () => null, test = async () => false, file, log = () => {}, warn = () => {}, hooks = {} }) {
    Object.assign(this, { getCore, onScreen, test, file, log, warn });
    this.hooks = { normItem: (a, it) => it, managedButtons: () => new Set(), buttonOverride: () => undefined, ownOrder: () => null, copyChanged: () => {}, ...hooks };
    this.launchers = [];
    this.copies = {}; // launcher id -> { original activity id -> { id, seq, ui } }
    this.places = {}; // launcher id -> [{ kind: "page", activity, page_id } | { kind: "button", activity, button, press } | { kind: "home", profile, page_id }]
    this.chosen = {}; // launcher id -> original activity the buttons point at
    this.status = {}; // launcher id -> { pick, error, at }
    this.pending = new Set(); // "launcher|activity" places waiting until their activity is left
    this.busy = Promise.resolve();
    this.load();
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(d.launchers)) this.launchers = d.launchers;
      if (d.copies && typeof d.copies === "object") this.copies = d.copies;
      if (d.places && typeof d.places === "object") this.places = d.places;
      if (d.chosen && typeof d.chosen === "object") this.chosen = d.chosen;
    } catch {}
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ launchers: this.launchers, copies: this.copies, places: this.places, chosen: this.chosen }, null, 2));
    } catch (e) {
      this.warn("launcher: couldn't save:", e.message);
    }
  }
  get enabled() {
    return this.launchers.length > 0 || Object.keys(this.copies).length > 0;
  }
  queue(fn) {
    const p = this.busy.then(fn);
    this.busy = p.catch(() => {});
    return p;
  }
  core() {
    const c = this.getCore();
    if (!c) throw new Error("not connected to the remote");
    return c;
  }

  // ---- copies ↔ originals -------------------------------------------------------------------
  /** The original activity of a launcher copy (any other id is returned as it is). */
  originalOf(id) {
    for (const per of Object.values(this.copies)) for (const [orig, c] of Object.entries(per)) if (c?.id === id) return orig;
    return id;
  }
  copiesOf(id) {
    const out = [];
    for (const per of Object.values(this.copies)) if (per[id]?.id) out.push(per[id].id);
    return out;
  }
  isCopy(id) {
    return this.originalOf(id) !== id;
  }
  /** The launcher a copy belongs to (or null). */
  launcherOfCopy(id) {
    for (const [lid, per] of Object.entries(this.copies)) for (const c of Object.values(per)) if (c?.id === id) return lid;
    return null;
  }
  copyIdsOf(lid) {
    return Object.values(this.copies[lid] || {}).map((c) => c.id).filter(Boolean);
  }

  // ---- reading an activity --------------------------------------------------------------------
  async activity(id) {
    return this.core().get(`/activities/${enc(id)}`);
  }
  includedOf(act) {
    return list(act?.options?.included_entities).map((x) => x.entity_id).filter(Boolean);
  }
  seqOf(act) {
    const s = act?.options?.sequences || {};
    return { on: list(s.on), off: list(s.off) };
  }
  /** The original's pages in the user's own order (a page jump may have them rotated). */
  async pagesOf(id) {
    const pages = list(await this.core().get(`/activities/${enc(id)}/ui/pages`));
    const own = this.hooks.ownOrder(id);
    if (!own) return pages;
    const by = new Map(pages.map((p) => [p.page_id, p]));
    const out = own.filter((pid) => by.has(pid)).map((pid) => by.get(pid));
    for (const p of pages) if (!out.includes(p)) out.push(p);
    return out;
  }
  async buttonsOf(id) {
    return list(await this.core().get(`/activities/${enc(id)}/buttons`));
  }
  /** An item with launcher pointers made neutral (their target changes with the rules). */
  normItem(activity, it) {
    let out = this.hooks.normItem(activity, it) || it;
    const e = out?.command?.entity_id;
    if (e && START.includes(out.command.cmd_id)) {
      const lid = this.launcherOfCopy(e);
      if (lid) out = { ...out, command: { launcher: lid } };
    }
    return out;
  }
  uiHash(activity, pages, buttons) {
    const managed = this.hooks.managedButtons(activity);
    const p = pages.map((pg) => ({ name: pg.name, grid: pg.grid, items: list(pg.items).map((it) => this.normItem(activity, it)) }));
    const b = buttons.filter((x) => !managed.has(x.button)).map((x) => {
      const n = { ...x };
      for (const k of ["short_press", "long_press"]) if (n[k]?.entity_id && START.includes(n[k].cmd_id) && this.launcherOfCopy(n[k].entity_id)) n[k] = { launcher: this.launcherOfCopy(n[k].entity_id) };
      return n;
    });
    return hashOf(JSON.stringify({ p, b }));
  }

  // ---- copies -----------------------------------------------------------------------------------
  /** Start sequence of a copy: the original's, then the wait and the extra steps. */
  wantSeq(srcAct, t) {
    const { on, off } = this.seqOf(srcAct);
    const extra = [];
    if (t.delay && t.steps.length) extra.push({ type: "delay", delay: t.delay });
    for (const s of t.steps) extra.push({ type: "command", command: { entity_id: s.entity_id, cmd_id: s.cmd_id, ...(s.params ? { params: s.params } : {}) } });
    const ids = this.includedOf(srcAct);
    for (const s of t.steps) if (!ids.includes(s.entity_id)) ids.push(s.entity_id);
    const opts = {};
    for (const k of ["prevent_sleep", "ready_check", "error_policy", "touch_slider", "voice_assistant"]) if (srcAct?.options?.[k] !== undefined) opts[k] = srcAct.options[k];
    return { entity_ids: ids, sequences: { on: [...on, ...extra], off }, ...opts };
  }

  async createCopy(l, t) {
    const core = this.core();
    const src = await this.activity(t.activity);
    const srcName = nameOf(src?.name) || t.activity;
    const body = { name: { en: l.name }, clone_from: t.activity, description: { en: `${COPY_NOTE}${srcName} (launcher ${l.name}). Edit ${srcName}, not this copy: it follows the original.` } };
    if (l.icon) body.icon = l.icon;
    const made = await core.post("/activities", body);
    const id = made?.entity_id;
    if (!id) throw new Error(`the remote didn't return the new activity for ${srcName}`);
    this.log(`launcher ${l.name}: made the launcher copy of ${srcName}`);
    return id;
  }

  /** Puts the copy in exactly the activity groups the original is in. */
  async syncGroups(orig, copy) {
    const core = this.core();
    let overview;
    try {
      overview = list(await core.get("/activity_groups?limit=100&page=1"));
    } catch {
      return;
    }
    for (const o of overview) {
      const gid = o.group_id ?? o.id;
      if (!gid) continue;
      let g;
      try { g = await core.get(`/activity_groups/${encodeURIComponent(gid)}`); } catch { continue; }
      const members = list(g?.activity_ids || g?.activities).map((a) => (typeof a === "string" ? a : a?.entity_id)).filter(Boolean);
      const want = members.includes(orig), has = members.includes(copy);
      if (want === has) continue;
      const next = want ? [...members, copy] : members.filter((x) => x !== copy);
      await core.patch(`/activity_groups/${encodeURIComponent(gid)}`, { activity_ids: next });
      this.log(`launcher: copy of ${orig} ${want ? "added to" : "taken out of"} activity group ${nameOf(g?.name) || gid}`);
    }
  }

  /**
   * Keeps one copy like its original: devices and sequences (plus the extra steps), then pages and
   * physical buttons when they changed. A copy that is on screen keeps its pages until it's left.
   */
  async syncCopy(l, t, force = false) {
    const core = this.core();
    const per = (this.copies[l.id] = this.copies[l.id] || {});
    let rec = per[t.activity];
    if (rec?.id) {
      try {
        await this.activity(rec.id);
      } catch (e) {
        if (e.status === 404) { this.warn(`launcher ${l.name}: the copy of ${t.activity} was deleted on the remote; making it again`); rec = null; }
        else throw e;
      }
    }
    let fresh = false;
    if (!rec?.id) {
      rec = per[t.activity] = { id: await this.createCopy(l, t) };
      this.save();
      fresh = true;
    }
    const src = await this.activity(t.activity);
    const want = this.wantSeq(src, t);
    const seq = hashOf(JSON.stringify([want, l.name, l.icon]));
    if (force || fresh || rec.seq !== seq) {
      const body = { options: want, name: { en: l.name } };
      if (l.icon) body.icon = l.icon;
      await core.patch(`/activities/${enc(rec.id)}`, body);
      rec.seq = seq;
      await this.syncGroups(t.activity, rec.id).catch((e) => this.warn(`launcher ${l.name}: activity groups:`, e.message));
      this.save();
    }
    if (rec.id === this.onScreen()) return rec; // pages of the screen in use: later
    const pages = await this.pagesOf(t.activity);
    const buttons = await this.buttonsOf(t.activity);
    const ui = this.uiHash(t.activity, pages, buttons);
    if (!force && !fresh && rec.ui === ui) return rec;
    await this.copyPages(t.activity, rec.id, pages);
    await this.copyButtons(t.activity, rec.id, buttons);
    rec.ui = ui;
    this.save();
    this.log(`launcher ${l.name}: copy of ${nameOf(src?.name) || t.activity} updated (pages and buttons)`);
    try { await this.hooks.copyChanged(rec.id, t.activity); } catch {}
    return rec;
  }

  async copyPages(orig, copy, pages) {
    const core = this.core();
    const have = list(await core.get(`/activities/${enc(copy)}/ui/pages`));
    const ids = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const body = { name: p.name, items: list(p.items).map((it) => ({ ...it })) };
      if (p.grid) body.grid = p.grid;
      if (have[i]) {
        await core.patch(`/activities/${enc(copy)}/ui/pages/${encodeURIComponent(have[i].page_id)}`, body);
        ids.push(have[i].page_id);
      } else {
        const made = await core.post(`/activities/${enc(copy)}/ui/pages`, body);
        if (made?.page_id) ids.push(made.page_id);
      }
    }
    for (const extra of have.slice(pages.length)) await core.request("DELETE", `/activities/${enc(copy)}/ui/pages/${encodeURIComponent(extra.page_id)}`);
    const now = list(await core.get(`/activities/${enc(copy)}/ui/pages`)).map((p) => p.page_id);
    if (ids.length > 1 && now.join() !== ids.join() && ids.every((x) => now.includes(x))) await core.patch(`/activities/${enc(copy)}/ui/pages`, { page_order: ids });
  }

  async copyButtons(orig, copy, buttons) {
    const out = buttons.map((b) => {
      const n = { button: b.button };
      for (const k of ["short_press", "long_press"]) {
        const ov = k === "short_press" ? this.hooks.buttonOverride(orig, b.button) : undefined;
        const v = ov !== undefined ? ov : b[k];
        if (v && v.cmd_id) n[k] = { entity_id: v.entity_id, cmd_id: v.cmd_id, ...(v.params && Object.keys(v.params).length ? { params: v.params } : {}) };
      }
      return n;
    }).filter((b) => b.short_press || b.long_press);
    await this.core().post(`/activities/${enc(copy)}/buttons`, out);
  }

  // ---- buttons that start a launcher ---------------------------------------------------------------
  /**
   * Looks for every button that starts one of a launcher's copies: activity page buttons, physical buttons
   * and home screen tiles.
   */
  async scan() {
    const core = this.core();
    const copyIds = new Map(); // copy id -> launcher id
    for (const l of this.launchers) for (const c of this.copyIdsOf(l.id)) copyIds.set(c, l.id);
    const found = Object.fromEntries(this.launchers.map((l) => [l.id, []]));
    const acts = [];
    for (let page = 1; page <= 20; page++) {
      const part = await core.get(`/activities?limit=100&page=${page}`);
      if (!Array.isArray(part) || !part.length) break;
      acts.push(...part);
      if (part.length < 100) break;
    }
    for (const a of acts) {
      if (!a?.entity_id || a.options?.editable === false) continue;
      const id = a.entity_id;
      let pages = [], buttons = [];
      try { pages = list(await core.get(`/activities/${enc(id)}/ui/pages`)); } catch {}
      try { buttons = list(await core.get(`/activities/${enc(id)}/buttons`)); } catch {}
      for (const p of pages) {
        const lids = new Set(list(p.items).map((it) => (START.includes(it?.command?.cmd_id) ? copyIds.get(it.command.entity_id) : null)).filter(Boolean));
        for (const lid of lids) found[lid].push({ kind: "page", activity: id, page_id: p.page_id, name: String(nameOf(p.name) || "") });
      }
      for (const b of buttons) for (const press of ["short_press", "long_press"]) {
        const lid = START.includes(b[press]?.cmd_id) ? copyIds.get(b[press].entity_id) : null;
        if (lid) found[lid].push({ kind: "button", activity: id, button: b.button, press });
      }
    }
    try {
      const profiles = list(await core.get("/profiles"));
      for (const pr of profiles) {
        const pid = pr.profile_id ?? pr.id;
        if (!pid) continue;
        let pages = [];
        try { pages = list(await core.get(`/profiles/${encodeURIComponent(pid)}/pages`)); } catch {}
        for (const p of pages) {
          const lids = new Set(list(p.items).map((it) => copyIds.get(it?.entity_id)).filter(Boolean));
          for (const lid of lids) found[lid].push({ kind: "home", profile: pid, page_id: p.page_id, name: String(nameOf(p.name) || "") });
        }
      }
    } catch {}
    for (const [lid, pl] of Object.entries(found)) this.places[lid] = pl.slice(0, LIMITS.places);
    this.scannedAt = Date.now();
    this.save();
    return found;
  }

  /** The original activity the rules pick right now. */
  async pick(l) {
    for (const r of l.rules) {
      try {
        if (await this.test(r.if)) return r.target;
      } catch (e) {
        this.warn(`launcher ${l.name}: ${e.message}`);
      }
    }
    return l.otherwise || l.targets[0]?.activity || null;
  }

  /** Makes sure the activity has the entity (a copy) among its devices, so a button may start it. */
  async include(core, activity, entity) {
    const act = await this.activity(activity);
    const ids = this.includedOf(act);
    if (!ids.includes(entity)) await core.patch(`/activities/${enc(activity)}`, { options: { entity_ids: [...ids, entity] } });
  }

  /**
   * Points one place at `to` (a copy, or the original when removing). Page buttons of the activity on
   * screen wait until it's left (rewriting a page there makes the remote jump to page 1).
   */
  async point(core, place, from, to, { now = false } = {}) {
    if (place.kind === "page") {
      if (!now && place.activity === this.onScreen()) return "later";
      const pages = list(await core.get(`/activities/${enc(place.activity)}/ui/pages`));
      const p = pages.find((x) => x.page_id === place.page_id);
      if (!p) return "gone";
      let n = 0;
      const items = list(p.items).map((it) => {
        if (!START.includes(it?.command?.cmd_id) || !from.has(it.command.entity_id) || it.command.entity_id === to) return it;
        n++;
        return { ...it, command: { ...it.command, entity_id: to } };
      });
      if (!n) return list(p.items).some((it) => it?.command?.entity_id === to) ? "ok" : "gone";
      await this.include(core, place.activity, to);
      await core.patch(`/activities/${enc(place.activity)}/ui/pages/${encodeURIComponent(p.page_id)}`, { items });
      return "ok";
    }
    if (place.kind === "button") {
      const b = (await this.buttonsOf(place.activity)).find((x) => x.button === place.button)?.[place.press];
      if (!b || !START.includes(b.cmd_id) || !from.has(b.entity_id)) return b?.entity_id === to ? "ok" : "gone";
      await this.include(core, place.activity, to);
      await core.patch(`/activities/${enc(place.activity)}/buttons/${encodeURIComponent(place.button)}`, { [place.press]: { ...b, entity_id: to } });
      return "ok";
    }
    if (place.kind === "home") {
      const p = await core.get(`/profiles/${encodeURIComponent(place.profile)}/pages/${encodeURIComponent(place.page_id)}`);
      const items = list(p?.items).map((it) => (it?.entity_id && from.has(it.entity_id) ? { entity_id: to } : it.group_id ? { group_id: it.group_id } : { entity_id: it.entity_id }));
      if (!list(p?.items).some((it) => from.has(it?.entity_id) && it.entity_id !== to)) return list(p?.items).some((it) => it?.entity_id === to) ? "ok" : "gone";
      await core.patch(`/profiles/${encodeURIComponent(place.profile)}/pages/${encodeURIComponent(place.page_id)}`, { items });
      return "ok";
    }
    return "gone";
  }

  /** Re-points a launcher's buttons when its pick changed (or force). */
  async aim(l, force = false) {
    const core = this.core();
    const pick = await this.pick(l);
    const st = (this.status[l.id] = this.status[l.id] || {});
    st.pick = pick;
    const to = this.copies[l.id]?.[pick]?.id;
    if (!to) { st.error = "its activity copies aren't made yet"; return; }
    const pending = [...this.pending].some((k) => k.startsWith(l.id + "|"));
    if (!force && !pending && this.chosen[l.id] === pick) return;
    const from = new Set(this.copyIdsOf(l.id));
    let later = 0;
    const errs = [];
    for (const place of this.places[l.id] || []) {
      const key = `${l.id}|${place.activity || "home"}`;
      try {
        const r = await this.point(core, place, from, to);
        if (r === "later") { later++; this.pending.add(key); } else this.pending.delete(key);
      } catch (e) {
        this.warn(`launcher ${l.name}: re-pointing a button failed:`, e.message);
        errs.push(`re-pointing a button: ${e.message}`);
      }
    }
    if (this.chosen[l.id] !== pick) this.log(`launcher ${l.name}: now opens ${pick}${later ? ` (${later} button(s) on the screen in use follow when you leave it)` : ""}`);
    this.chosen[l.id] = pick;
    st.at = new Date().toISOString();
    st.error = errs[0] || null;
    this.save();
  }

  // ---- whole-set operations ------------------------------------------------------------------
  /** New launchers (validated): makes / updates the copies, deletes the ones no longer needed, rescans. */
  replace(launchers) {
    return this.queue(async () => {
      const problems = [];
      this.launchers = launchers;
      this.save();
      // copies no longer used: buttons back to the original, then delete
      for (const [lid, per] of Object.entries(this.copies)) {
        const l = launchers.find((x) => x.id === lid);
        for (const [orig, c] of Object.entries(per)) {
          if (l && l.targets.some((t) => t.activity === orig)) continue;
          try { await this.dropCopy(lid, orig, l ? l.otherwise : orig); } catch (e) { problems.push(`removing the copy of ${orig}: ${e.message}`); }
        }
        if (!l && !Object.keys(this.copies[lid] || {}).length) { delete this.copies[lid]; delete this.places[lid]; delete this.chosen[lid]; }
      }
      for (const l of launchers) for (const t of l.targets) {
        try { await this.syncCopy(l, t, true); } catch (e) { problems.push(`${l.name}, copy of ${t.activity}: ${e.message}`); }
      }
      try { await this.scan(); } catch (e) { problems.push(`looking for the launcher buttons: ${e.message}`); }
      for (const l of launchers) await this.aim(l, true).catch((e) => problems.push(`${l.name}: ${e.message}`));
      this.save();
      return problems;
    });
  }

  /** Points a copy's buttons at `toOrig`'s copy (or the original activity) and deletes the copy. */
  async dropCopy(lid, orig, toOrig) {
    const core = this.core();
    const c = this.copies[lid]?.[orig];
    if (!c?.id) { if (this.copies[lid]) delete this.copies[lid][orig]; return; }
    const to = (toOrig && toOrig !== orig && this.copies[lid]?.[toOrig]?.id) || orig;
    for (const place of this.places[lid] || []) {
      try { await this.point(core, place, new Set([c.id]), to, { now: true }); } catch (e) { this.warn(`launcher: re-pointing before removing a copy:`, e.message); }
    }
    if (c.id === this.onScreen()) throw new Error("it's on screen; leave it first");
    try {
      await core.request("DELETE", `/activities/${enc(c.id)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    delete this.copies[lid][orig];
    this.log(`launcher: copy of ${orig} removed (its buttons now start ${to})`);
    this.save();
  }

  /** Background check: rules (every call), copies kept like their originals (every `syncMs`). */
  check({ syncMs = 60000 } = {}) {
    return this.queue(async () => {
      if (!this.launchers.length) return;
      const now = Date.now();
      if (!this.syncedAt || now - this.syncedAt > syncMs) {
        this.syncedAt = now;
        for (const l of this.launchers) for (const t of l.targets) {
          try { await this.syncCopy(l, t); } catch (e) { (this.status[l.id] = this.status[l.id] || {}).error = e.message; this.warn(`launcher ${l.name}: keeping the copy of ${t.activity} up to date:`, e.message); }
        }
        if (!this.scannedAt || now - this.scannedAt > 10 * syncMs) await this.scan().catch((e) => this.warn("launcher: looking for buttons:", e.message));
      }
      for (const l of this.launchers) await this.aim(l).catch((e) => this.warn(`launcher ${l.name}:`, e.message));
    });
  }

  /** An activity was opened: buttons left waiting on the previous screen can be re-pointed now. */
  opened() {
    if (!this.pending.size) return Promise.resolve();
    return this.queue(async () => {
      for (const l of this.launchers) if ([...this.pending].some((k) => k.startsWith(l.id + "|"))) await this.aim(l, true).catch((e) => this.warn(`launcher ${l.name}:`, e.message));
    });
  }

  /** Puts a launcher button on an activity page, a physical button or the home screen. */
  place(lid, where) {
    return this.queue(async () => {
      const core = this.core();
      const l = this.launchers.find((x) => x.id === lid);
      if (!l) throw new Error(`no launcher ${lid}`);
      const pick = this.chosen[lid] || (await this.pick(l));
      const to = this.copies[lid]?.[pick]?.id;
      if (!to) throw new Error("the launcher's activity copies aren't made yet");
      const command = { entity_id: to, cmd_id: "activity.start" };
      let what;
      if (where.kind === "button") {
        if (!/^[A-Z0-9_]{1,20}$/.test(String(where.button || ""))) throw new Error("pick the physical button");
        const press = where.press === "long_press" ? "long_press" : "short_press";
        await this.include(core, where.activity, to);
        await core.patch(`/activities/${enc(where.activity)}/buttons/${encodeURIComponent(where.button)}`, { [press]: command });
        what = `${where.button} (${press === "long_press" ? "long" : "short"} press) of ${where.activity}`;
      } else if (where.kind === "home") {
        const profiles = list(await core.get("/profiles"));
        const pr = profiles.find((x) => (x.profile_id ?? x.id) === where.profile) || profiles[0];
        const pid = pr?.profile_id ?? pr?.id;
        if (!pid) throw new Error("no profile on the remote");
        const pages = list(await core.get(`/profiles/${encodeURIComponent(pid)}/pages`));
        const p = pages.find((x) => x.page_id === where.page) || pages[0];
        if (!p) throw new Error("the profile has no home page");
        const items = list(p.items).map((it) => (it.group_id ? { group_id: it.group_id } : { entity_id: it.entity_id }));
        await core.patch(`/profiles/${encodeURIComponent(pid)}/pages/${encodeURIComponent(p.page_id)}`, { items: [...items, { entity_id: to }] });
        what = `home page ${nameOf(p.name) || p.page_id}`;
      } else {
        if (where.activity === this.onScreen()) throw new Error("that activity is on screen; adding a button would make it jump to page 1. Leave it first.");
        const pages = list(await core.get(`/activities/${enc(where.activity)}/ui/pages`));
        const p = pages.find((x) => x.page_id === where.page) || pages[0];
        if (!p) throw new Error("the activity has no pages");
        const grid = { width: p.grid?.width || 4, height: p.grid?.height || 6 };
        const useIcon = !!l.icon && where.look !== "text";
        let spot = useIcon ? freeSpot(grid, p.items, 1, 1) : freeSpot(grid, p.items, 2, 1);
        if (!spot) throw new Error(`no free spot on "${nameOf(p.name) || "the page"}"`);
        const item = useIcon
          ? { type: "icon", icon: l.icon, location: spot, size: { width: 1, height: 1 }, command }
          : { type: "text", text: l.name, location: spot, size: { width: 2, height: 1 }, command };
        await this.include(core, where.activity, to);
        await core.patch(`/activities/${enc(where.activity)}/ui/pages/${encodeURIComponent(p.page_id)}`, { items: [...list(p.items), item] });
        what = `page ${nameOf(p.name) || p.page_id} of ${where.activity} at ${spot.x},${spot.y}`;
      }
      this.log(`launcher ${l.name}: button added on ${what}`);
      await this.scan();
      return what;
    });
  }

  /** Clean-up: every launcher button back to the original activity, copies deleted, launchers off. */
  removeAll() {
    return this.queue(async () => {
      const done = [];
      for (const [lid, per] of Object.entries(this.copies)) {
        for (const orig of Object.keys(per)) {
          try { await this.dropCopy(lid, orig, null); done.push(`launcher copy of ${orig} removed, its buttons start ${orig} again`); }
          catch (e) { done.push(`problem removing the launcher copy of ${orig}: ${e.message}`); }
        }
        if (!Object.keys(this.copies[lid] || {}).length) delete this.copies[lid];
      }
      this.launchers = [];
      this.places = {};
      this.chosen = {};
      this.save();
      return done;
    });
  }

  view() {
    return this.launchers.map((l) => ({
      ...l,
      copies: Object.fromEntries(Object.entries(this.copies[l.id] || {}).map(([o, c]) => [o, c.id])),
      places: this.places[l.id] || [],
      chosen: this.chosen[l.id] || null,
      status: this.status[l.id] || {}
    }));
  }
}
