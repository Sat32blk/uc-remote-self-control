// "Return to previous activity".
//
// The remote only switches its screen to an activity when the user directly presses a UI button or
// physical button whose command is `activity.start` (tested on a Remote 3; starts from the API, an
// integration or a macro run in the background). So the integration can't navigate by itself.
// Instead it keeps a ↩ button in each chosen ("host") activity pointed at the activity used before:
//
//   - every POLL_MS it reads GET /activities and notices activities that switch to ON;
//   - the newest one becomes "current"; the history is most-recent-first and doesn't care whether
//     the old activity was turned off;
//   - each host H gets the target = the most recent activity in the history that isn't H.
//     While you're in X, every other host already points at X, so when you open H its ↩ button
//     is correct before the screen appears. Only X's own button changes (to the one before X).
//
// ↩ items on screen: any text item whose text starts with "↩", or an icon item with icon "uc:back"
// and an activity.start (or no) command, on any page of a host. Users can move them around.
// A physical button (short or long press) can be set per host as well.

import fs from "node:fs";

export const RETURN_MARK = "↩";
export const RETURN_ICON = "uc:back";
const HISTORY_MAX = 10;
const CMD = "activity.start";

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
const isOn = (s) => String(s || "").toUpperCase() === "ON";

async function pagedGet(core, base) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const part = await core.get(`${base}${base.includes("?") ? "&" : "?"}limit=100&page=${page}`);
    if (!Array.isArray(part) || part.length === 0) break;
    out.push(...part);
    if (part.length < 100) break;
  }
  return out;
}

export function isReturnItem(it) {
  if (!it) return false;
  if (it.type === "text" && String(it.text || "").startsWith(RETURN_MARK)) return true;
  if (it.type === "icon" && it.icon === RETURN_ICON && (!it.command || it.command.cmd_id === CMD)) return true;
  return false;
}

/** First free spot of w×h on a grid, scanning from the bottom row up (left to right). */
export function freeSpot(grid, items, w, h) {
  const used = new Set();
  for (const it of items || []) {
    const x0 = it.location?.x ?? 0, y0 = it.location?.y ?? 0;
    const iw = it.size?.width ?? 1, ih = it.size?.height ?? 1;
    for (let x = x0; x < x0 + iw; x++) for (let y = y0; y < y0 + ih; y++) used.add(`${x},${y}`);
  }
  for (let y = grid.height - h; y >= 0; y--) {
    for (let x = 0; x <= grid.width - w; x++) {
      let ok = true;
      for (let dx = 0; dx < w && ok; dx++) for (let dy = 0; dy < h && ok; dy++) if (used.has(`${x + dx},${y + dy}`)) ok = false;
      if (ok) return { x, y };
    }
  }
  return null;
}

export class ReturnTracker {
  constructor({ getCore, file, log, warn, onChange }) {
    this.getCore = getCore;
    this.file = file;
    this.log = log;
    this.warn = warn;
    this.onChange = onChange || (() => {});
    this.states = null; // id -> state from the last poll
    this.names = {}; // id -> name
    this.busy = Promise.resolve();
    const saved = this.read();
    this.history = saved.history || [];
    this.cfg = { hosts: [], screen: "text", button: "NONE", press: "short_press", ...(saved.cfg || {}) };
    this.hostState = saved.hostState || {}; // host -> { target, placed }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ history: this.history, cfg: this.cfg, hostState: this.hostState }, null, 2));
    } catch (e) {
      this.warn("return: saving failed:", e.message);
    }
  }

  get enabled() {
    return this.cfg.hosts.length > 0;
  }
  get current() {
    return this.history[0];
  }
  get previous() {
    return this.history[1];
  }
  nameOf(id) {
    return this.names[id] || id || "";
  }
  targetFor(host) {
    return this.history.find((a) => a !== host && (!this.states || a in this.states));
  }

  /** One poll: detect activities that switched on. Returns the ids that did. */
  async poll() {
    const core = this.getCore();
    if (!core) return [];
    const list = await pagedGet(core, "/activities");
    const now = {};
    for (const a of list) {
      if (!a?.entity_id) continue;
      now[a.entity_id] = a.attributes?.state ?? a.state ?? "";
      this.names[a.entity_id] = nameOf(a.name) || a.entity_id;
    }
    const started = [];
    if (this.states) {
      for (const [id, st] of Object.entries(now)) if (isOn(st) && !isOn(this.states[id])) started.push(id);
    } else if (this.history.length === 0) {
      // first run ever: seed with whatever is on now
      for (const [id, st] of Object.entries(now)) if (isOn(st)) this.history.push(id);
    }
    this.states = now;
    if (started.length) {
      for (const id of started) this.history = [id, ...this.history.filter((x) => x !== id)].slice(0, HISTORY_MAX);
      this.log(`return: current ${this.nameOf(this.current)}, previous ${this.nameOf(this.previous) || "-"}`);
      this.save();
      this.onChange();
      await this.refresh(false);
    }
    return started;
  }

  /** Points every host's ↩ button at its target. force = rewrite even if unchanged. */
  refresh(force) {
    this.busy = this.busy.then(() => this._refresh(force)).catch((e) => this.warn("return: update failed:", e.message));
    return this.busy;
  }

  async _refresh(force) {
    const core = this.getCore();
    if (!core || !this.enabled) return;
    for (const host of this.cfg.hosts) {
      const target = this.targetFor(host);
      const hs = (this.hostState[host] = this.hostState[host] || {});
      if (!force && hs.target === target) continue;
      try {
        await this.apply(core, host, target, hs);
        hs.target = target;
      } catch (e) {
        this.warn(`return: updating ${this.nameOf(host)} failed:`, e.message);
      }
    }
    this.save();
  }

  async apply(core, host, target, hs) {
    const enc = encodeURI(host);
    if (target) {
      const act = await core.get(`/activities/${enc}`);
      const included = (act?.options?.included_entities || []).map((x) => x.entity_id).filter(Boolean);
      if (!included.includes(target)) await core.patch(`/activities/${enc}`, { options: { entity_ids: [...included, target] } });
    }
    const command = target ? { entity_id: target, cmd_id: CMD } : undefined;
    const label = `${RETURN_MARK} ${target ? this.nameOf(target) : "Previous"}`.slice(0, 50);

    if (this.cfg.screen !== "none") {
      const pages = (await core.get(`/activities/${enc}/ui/pages`)) || [];
      let found = 0;
      for (const p of pages) {
        let changed = false;
        const items = (p.items || []).map((it) => {
          if (!isReturnItem(it)) return it;
          found++;
          changed = true;
          const out = { ...it };
          if (command) out.command = command;
          else delete out.command;
          if (it.type === "text") out.text = label;
          return out;
        });
        if (changed) await core.patch(`/activities/${enc}/ui/pages/${encodeURIComponent(p.page_id)}`, { items });
      }
      if (!found && !hs.placed && pages.length) {
        const p = pages[0];
        const isIcon = this.cfg.screen === "icon";
        const w = isIcon ? 1 : 2;
        const grid = { width: p.grid?.width || 4, height: p.grid?.height || 6 };
        let spot = freeSpot(grid, p.items, w, 1);
        if (!spot) {
          grid.height += 1;
          spot = { x: 0, y: grid.height - 1 };
        }
        const item = isIcon
          ? { type: "icon", icon: RETURN_ICON, location: spot, size: { width: 1, height: 1 } }
          : { type: "text", text: label, location: spot, size: { width: w, height: 1 } };
        if (command) item.command = command;
        await core.patch(`/activities/${enc}/ui/pages/${encodeURIComponent(p.page_id)}`, { grid, items: [...(p.items || []), item] });
        this.log(`return: placed ${isIcon ? "an icon" : "a text"} button on "${p.name || "page 1"}" of ${this.nameOf(host)} at ${spot.x},${spot.y}`);
      }
      hs.placed = true;
    }
    if (this.cfg.button && this.cfg.button !== "NONE" && command) {
      await core.patch(`/activities/${enc}/buttons/${encodeURIComponent(this.cfg.button)}`, { [this.cfg.press === "long_press" ? "long_press" : "short_press"]: command });
    }
  }

  /** New settings from the setup screen; places buttons and points them right away. */
  async configure({ hosts, screen, button, press }) {
    this.cfg = { hosts, screen, button, press };
    for (const h of hosts) this.hostState[h] = { placed: false };
    this.save();
    if (!this.states) await this.poll().catch(() => {});
    await this.refresh(true);
  }

  async buttonsOf(activityId) {
    const core = this.getCore();
    try {
      const list = await core.get(`/activities/${encodeURI(activityId)}/buttons`);
      const ids = (Array.isArray(list) ? list : []).map((b) => b.button).filter(Boolean);
      if (ids.length) return ids;
    } catch {}
    return ["BACK", "HOME", "MENU", "RECORD", "STOP", "PLAY", "PREV", "NEXT", "MUTE", "CHANNEL_UP", "CHANNEL_DOWN", "VOICE"];
  }
}
