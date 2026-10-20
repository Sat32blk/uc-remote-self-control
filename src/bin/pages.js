// Page jumps. The remote has no "go to page" command, but (tested on a Remote 3, 2026-10-19):
//   - changing the page order of the activity on screen makes the remote jump to its (new) first page,
//     from any page; sending the same order again does nothing;
//   - an activity always opens on its first page (the last page viewed isn't remembered).
// So "go to page P" = rotate the activity's pages so P is first (the circular swipe order is kept), and
// "start page" = the same, done while the activity isn't on screen. The user's own order is remembered
// and put back once they leave the activity (a reorder while it's on screen would jump again).
//
// Start-page rules per activity: [{ if: COND, page }], otherwise: page | null. They're checked while the
// activity is not on screen, so it opens on the right page.
//
// A page is named by its page_id, its name (case-insensitive) or "#n" (its position in the user's order).
import fs from "node:fs";

export const MAX_START_RULES = 30;
const MAX_BRANCHES = 8;

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Validates start-page rules. vCond(cond, path, errs) checks a condition. Returns { errors, starts }. */
export function validateStarts(input, vCond = () => {}) {
  const errors = [];
  const list = Array.isArray(input?.starts) ? input.starts : Array.isArray(input) ? input : null;
  if (!list) return { errors: ['"starts" list missing'], starts: [] };
  if (list.length > MAX_START_RULES) errors.push(`at most ${MAX_START_RULES} activities with a start page`);
  const seen = new Set();
  const starts = list.map((s, i) => {
    const at = `start page ${i + 1}`;
    const activity = String(s?.activity || "");
    if (!activity) errors.push(`${at}: pick the activity`);
    if (seen.has(activity)) errors.push(`${at}: this activity has two start-page rules`);
    seen.add(activity);
    const rules = (Array.isArray(s?.rules) ? s.rules : []).slice(0, MAX_BRANCHES + 1).map((r, k) => {
      const page = String(r?.page || "").slice(0, 80);
      if (!page) errors.push(`${at}, branch ${k + 1}: pick the page`);
      if (r?.if === undefined) errors.push(`${at}, branch ${k + 1}: needs a condition`);
      else vCond(r.if, `${at}, branch ${k + 1}`, errors);
      return { if: r?.if, page };
    });
    if (rules.length > MAX_BRANCHES) errors.push(`${at}: at most ${MAX_BRANCHES} branches`);
    const otherwise = s?.otherwise ? String(s.otherwise).slice(0, 80) : null;
    if (!rules.length && !otherwise) errors.push(`${at}: add a branch or an "otherwise" page`);
    return { activity, name: String(s?.name || "").slice(0, 80), rules, otherwise };
  });
  return { errors, starts };
}

export class PageJumper {
  /**
   * @param o.getCore      () => CoreClient
   * @param o.onScreen     () => id of the activity on screen (or null)
   * @param o.test         async (cond) => boolean (the smart engine's condition test)
   * @param o.file         where the user's own page orders and the start-page rules are kept
   */
  constructor({ getCore, onScreen, test = async () => false, file, log = () => {}, warn = () => {} }) {
    Object.assign(this, { getCore, onScreen, test, file, log, warn });
    this.saved = {}; // activity -> the user's own page order (only while it's rotated)
    this.starts = []; // start-page rules
    this.busy = Promise.resolve();
    this.load();
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (d.saved && typeof d.saved === "object") this.saved = d.saved;
      if (Array.isArray(d.starts)) this.starts = d.starts;
    } catch {}
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ saved: this.saved, starts: this.starts }, null, 2));
    } catch (e) {
      this.warn("pages: couldn't save:", e.message);
    }
  }
  get enabled() {
    return this.starts.length > 0 || Object.keys(this.saved).length > 0;
  }
  /** One page operation at a time (they read and write the same order). */
  queue(fn) {
    const p = this.busy.then(fn);
    this.busy = p.catch(() => {});
    return p;
  }

  async pagesOf(activity) {
    const core = this.getCore();
    if (!core) throw new Error("not connected to the remote");
    const pages = (await core.get(`/activities/${encodeURI(activity)}/ui/pages`)) || [];
    return pages.map((p) => ({ page_id: p.page_id, name: nameOf(p.name) || "" }));
  }
  async write(activity, order) {
    await this.getCore().patch(`/activities/${encodeURI(activity)}/ui/pages`, { page_order: order });
  }

  /** The page an id, name or "#n" points at, in the user's own order. */
  find(own, pages, spec) {
    const s = String(spec || "").trim();
    if (!s) return null;
    if (own.includes(s)) return s;
    const m = /^#(\d{1,2})$/.exec(s);
    if (m) return own[Number(m[1]) - 1] || null;
    const p = pages.find((x) => x.name.toLowerCase() === s.toLowerCase());
    return p ? p.page_id : null;
  }

  /**
   * Shows page `spec` of `activity` (null = the activity on screen): on screen the remote jumps to it;
   * otherwise the activity will open on it. Returns a short description.
   */
  goTo(activity, spec) {
    return this.queue(() => this._goTo(activity, spec, true));
  }
  async _goTo(activity, spec, jump) {
    const act = activity || this.onScreen();
    if (!act) throw new Error("no activity on screen");
    const pages = await this.pagesOf(act);
    const cur = pages.map((p) => p.page_id);
    if (!cur.length) throw new Error("the activity has no pages");
    // the user's own order: remembered while rotated (pages added or removed since are taken into account)
    let own = this.saved[act] ? this.saved[act].filter((id) => cur.includes(id)) : [...cur];
    for (const id of cur) if (!own.includes(id)) own.push(id);
    const target = this.find(own, pages, spec);
    if (!target) throw new Error(`no page "${spec}"`);
    const name = pages.find((p) => p.page_id === target)?.name || spec;
    const i = own.indexOf(target);
    const want = [...own.slice(i), ...own.slice(0, i)];
    const visible = act === this.onScreen();
    if (cur.length > 1) {
      if (same(want, cur)) {
        // already first: on screen, a change is needed to make the remote jump (two writes)
        if (visible && jump) {
          await this.write(act, [...want.slice(1), want[0]]);
          await this.write(act, want);
        }
      } else {
        await this.write(act, want);
      }
    }
    if (same(want, own)) delete this.saved[act];
    else this.saved[act] = own;
    this.save();
    return visible ? `page ${name}` : `${name} is the start page`;
  }

  /** Puts the user's own order back (only when the activity isn't on screen). */
  restore(activity) {
    return this.queue(async () => {
      const own = this.saved[activity];
      if (!own || activity === this.onScreen()) return;
      const pages = await this.pagesOf(activity);
      const cur = pages.map((p) => p.page_id);
      const order = own.filter((id) => cur.includes(id));
      for (const id of cur) if (!order.includes(id)) order.push(id);
      if (!same(order, cur)) await this.write(activity, order);
      delete this.saved[activity];
      this.save();
      this.log(`pages: ${activity} back to your own page order`);
    });
  }

  /** The start page the rules pick for an activity right now (null = its own first page). */
  async startFor(rule) {
    for (const r of rule.rules) {
      try {
        if (await this.test(r.if)) return r.page;
      } catch (e) {
        this.warn(`pages: start page of ${rule.name || rule.activity}: ${e.message}`);
      }
    }
    return rule.otherwise || null;
  }

  /**
   * An activity was left or is not on screen: set its start page from the rules, or put the user's order
   * back. Called after a switch and from the background check (only writes when something changes).
   */
  async settle(activity) {
    if (activity === this.onScreen()) return;
    const rule = this.starts.find((s) => s.activity === activity);
    const page = rule ? await this.startFor(rule) : null;
    if (page) {
      await this.queue(() => this._goTo(activity, page, false)).catch((e) => this.warn(`pages: start page of ${rule.name || activity}: ${e.message}`));
    } else if (this.saved[activity]) {
      await this.restore(activity).catch((e) => this.warn(`pages: restoring ${activity}: ${e.message}`));
    }
  }

  /** Another activity was opened: settle every other activity we changed or have rules for. */
  async opened(id) {
    const ids = new Set([...Object.keys(this.saved), ...this.starts.map((s) => s.activity)]);
    ids.delete(id);
    for (const a of ids) await this.settle(a);
  }

  /** Background check: keeps the start pages of activities that aren't on screen up to date. */
  async refresh() {
    for (const s of this.starts) await this.settle(s.activity);
  }

  /** Clean-up: every rotated activity back to your own order (also the one on screen), start pages off. */
  async restoreAll() {
    const done = [];
    this.starts = [];
    for (const activity of Object.keys(this.saved)) {
      await this.queue(async () => {
        const own = this.saved[activity];
        const cur = (await this.pagesOf(activity)).map((p) => p.page_id);
        const order = own.filter((id) => cur.includes(id));
        for (const id of cur) if (!order.includes(id)) order.push(id);
        if (!same(order, cur)) await this.write(activity, order);
        delete this.saved[activity];
        done.push(`page order of ${activity} restored`);
      }).catch((e) => done.push(`problem restoring the page order of ${activity}: ${e.message}`));
    }
    this.save();
    return done;
  }

  replaceStarts(starts) {
    this.starts = starts;
    this.save();
  }
}
