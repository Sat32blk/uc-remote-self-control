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
// A physical button (short or long press) can be set as well: in every host, or only in hosts whose
// page has no room for the on-screen button. The page's grid is never changed: adding a row would
// resize every button and break pages built from tiled pictures.

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

/** A ↩ item: text starting with ↩, the back-arrow icon, or (with `icons`) one of the custom ↩ pictures. */
export function isReturnItem(it, icons = []) {
  if (!it) return false;
  if (it.type === "text" && String(it.text || "").startsWith(RETURN_MARK)) return true;
  const ours = it.icon === RETURN_ICON || (it.icon && Array.isArray(icons) && icons.includes(it.icon));
  if (it.type === "icon" && ours && (!it.command || it.command.cmd_id === CMD)) return true;
  return false;
}
const SCREENS = ["text", "icon", "custom", "none"];

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

/** The remote's activity groups: [{ id, name, members, offMode }]. */
export async function activityGroups(core) {
  const overview = await pagedGet(core, "/activity_groups");
  // the list is only an overview (no members, no options): read each group
  const list = [];
  for (const o of overview) {
    const id = o.group_id ?? o.id;
    if (!id) continue;
    let d = null;
    try { d = await core.get(`/activity_groups/${encodeURIComponent(id)}`); } catch {}
    list.push({ ...o, ...(d || {}) });
  }
  return list.map((g) => ({
    id: g.group_id ?? g.id,
    name: nameOf(g.name) || g.group_id || g.id,
    members: (g.activity_ids || g.activities || []).map((a) => (typeof a === "string" ? a : a?.entity_id)).filter(Boolean),
    offMode: g.options?.turn_off_unused_entities ?? g.turn_off_unused_entities ?? null
  })).filter((g) => g.id);
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
    // cfg: hosts (ids) + defaults; hostCfg: per-activity overrides { screen, icon, button, press, buttonScope, close };
    // group: activity group used to turn off the activity you leave; groupManaged: ids we put in it.
    this.cfg = { hosts: [], screen: "text", button: "NONE", press: "short_press", buttonScope: "all", hostCfg: {}, group: null, groupManaged: [], ...(saved.cfg || {}) };
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

  /** Settings for one host: its own over the defaults. */
  optsFor(host) {
    const o = { screen: this.cfg.screen, icon: null, button: this.cfg.button, press: this.cfg.press, buttonScope: this.cfg.buttonScope, close: false, ...(this.cfg.hostCfg?.[host] || {}) };
    if (!SCREENS.includes(o.screen) || (o.screen === "custom" && !o.icon)) o.screen = o.screen === "custom" ? "icon" : "text";
    return o;
  }
  /** Every custom ↩ picture in use (so moved/old ones are still recognised). */
  customIcons() {
    const out = new Set();
    for (const h of Object.values(this.cfg.hostCfg || {})) if (h?.icon) out.add(h.icon);
    for (const hs of Object.values(this.hostState || {})) if (hs?.icon) out.add(hs.icon);
    return [...out];
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
      const left = this.current;
      for (const id of started) this.history = [id, ...this.history.filter((x) => x !== id)].slice(0, HISTORY_MAX);
      this.log(`return: current ${this.nameOf(this.current)}, previous ${this.nameOf(this.previous) || "-"}`);
      this.save();
      this.onChange();
      if (left && left !== this.current) await this.closeLeft(core, left, now);
      await this.refresh(false);
    }
    return started;
  }

  /**
   * "Turn off when leaving": a host marked `close` that is still on after another activity started gets a
   * plain activity.off. Meant for single-device control pages, whose on/off sequences don't matter.
   */
  async closeLeft(core, left, now) {
    if (!this.cfg.hosts.includes(left) || !this.optsFor(left).close || !isOn(now[left])) return;
    try {
      await core.request("PUT", `/entities/${encodeURI(left)}/command`, { cmd_id: "activity.off" });
      this.states[left] = "OFF";
      this.log(`return: turned off ${this.nameOf(left)} (left for ${this.nameOf(this.current)})`);
    } catch (e) {
      this.warn(`return: turning off ${this.nameOf(left)} failed:`, e.message);
    }
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
    const o = this.optsFor(host);
    const style = o.screen === "custom" ? "custom:" + o.icon : o.screen;
    const restyle = hs.style !== undefined && hs.style !== style; // the look was changed in the settings
    const known = this.customIcons();

    hs.onScreen = false;
    if (o.screen !== "none") {
      const pages = (await core.get(`/activities/${enc}/ui/pages`)) || [];
      let found = 0;
      for (const p of pages) {
        let changed = false;
        const items = (p.items || []).map((it) => {
          if (!isReturnItem(it, known)) return it;
          found++;
          changed = true;
          const out = { ...it };
          if (command) out.command = command;
          else delete out.command;
          if (restyle && (out.size?.width ?? 1) <= 2) {
            // switch the existing button to the new look, keeping its place
            if (o.screen === "text") { out.type = "text"; out.text = label; delete out.icon; }
            else { out.type = "icon"; out.icon = o.screen === "custom" ? o.icon : RETURN_ICON; delete out.text; }
          } else if (out.type === "text") out.text = label;
          return out;
        });
        if (changed) await core.patch(`/activities/${enc}/ui/pages/${encodeURIComponent(p.page_id)}`, { items });
      }
      if (found) hs.onScreen = true;
      if (!found && !hs.placed && pages.length) {
        const p = pages[0];
        const isIcon = o.screen !== "text";
        const iconId = o.screen === "custom" ? o.icon : RETURN_ICON;
        const grid = { width: p.grid?.width || 4, height: p.grid?.height || 6 };
        // a text button needs 2 cells; fall back to the 1-cell icon when only one is free
        let spot = isIcon ? freeSpot(grid, p.items, 1, 1) : freeSpot(grid, p.items, 2, 1);
        let useIcon = isIcon;
        if (!spot && !isIcon) {
          spot = freeSpot(grid, p.items, 1, 1);
          useIcon = !!spot;
        }
        if (spot) {
          const item = useIcon
            ? { type: "icon", icon: isIcon ? iconId : RETURN_ICON, location: spot, size: { width: 1, height: 1 } }
            : { type: "text", text: label, location: spot, size: { width: 2, height: 1 } };
          if (command) item.command = command;
          await core.patch(`/activities/${enc}/ui/pages/${encodeURIComponent(p.page_id)}`, { items: [...(p.items || []), item] });
          hs.onScreen = true;
          this.log(`return: placed ${useIcon ? "an icon" : "a text"} button on "${p.name || "page 1"}" of ${this.nameOf(host)} at ${spot.x},${spot.y}`);
        } else {
          this.warn(`return: no free spot on "${p.name || "page 1"}" of ${this.nameOf(host)}; the page is left as it is. Use a physical button for this activity, or make room and run the setup again.`);
        }
      }
      hs.placed = true;
    }
    hs.style = style;
    if (o.screen === "custom") hs.icon = o.icon;
    const physical = o.button && o.button !== "NONE" && (o.buttonScope !== "nofit" || !hs.onScreen);
    if (physical && command) {
      await core.patch(`/activities/${enc}/buttons/${encodeURIComponent(o.button)}`, { [o.press === "long_press" ? "long_press" : "short_press"]: command });
    }
  }

  /** New settings from the setup screen; places buttons and points them right away. */
  /**
   * New settings (setup screen or builder); places buttons and points them right away.
   * hostCfg (builder) replaces the per-activity settings; without it they're kept.
   */
  async configure({ hosts, screen, button, press, buttonScope, hostCfg, group }) {
    const keepHost = this.cfg.hostCfg || {};
    this.cfg = {
      ...this.cfg,
      hosts,
      screen: SCREENS.includes(screen) && screen !== "custom" ? screen : this.cfg.screen || "text",
      button: button || "NONE",
      press: press === "long_press" ? "long_press" : "short_press",
      buttonScope: buttonScope === "nofit" ? "nofit" : "all",
      hostCfg: hostCfg ? Object.fromEntries(hosts.filter((h) => hostCfg[h]).map((h) => [h, hostCfg[h]])) : Object.fromEntries(hosts.filter((h) => keepHost[h]).map((h) => [h, keepHost[h]])),
      group: group === undefined ? this.cfg.group : group || null
    };
    for (const h of hosts) this.hostState[h] = { ...(this.hostState[h] || {}), placed: false, target: undefined };
    this.save();
    if (!this.states) await this.poll().catch(() => {});
    const groupError = await this.syncGroup().catch((e) => e.message);
    await this.refresh(true);
    return groupError || null;
  }

  /**
   * "Turn off the activity I leave": the hosts marked `close` go into the chosen activity group, where the
   * remote turns off the activity you switch away from (keeping devices the new one uses). Members that we
   * didn't add are left alone; members we added earlier and that are no longer marked are taken out.
   */
  async syncGroup() {
    const core = this.getCore();
    if (!core) return null;
    // Turning off is now a plain activity.off (closeLeft). Activity groups are no longer used: this only
    // takes back out the members an earlier version put in a group.
    const want = [];
    const managed = this.cfg.groupManaged || [];
    if (!managed.length) return null;
    const groups = await activityGroups(core);
    const out = [];
    for (const g of groups) {
      const isTarget = g.id === this.cfg.group;
      let members = g.members.filter((m) => !managed.includes(m) || (isTarget && want.includes(m)));
      if (isTarget) for (const h of want) if (!members.includes(h)) members.push(h);
      if (members.join() !== g.members.join()) out.push([g, members]);
    }
    for (const [g, members] of out) await core.patch(`/activity_groups/${encodeURIComponent(g.id)}`, { activity_ids: members });
    this.cfg.groupManaged = [];
    this.cfg.group = null;
    this.save();
    if (out.length) this.log(`return: activity group ${groups.find((g) => g.id === this.cfg.group)?.name || "-"} now holds ${want.map((h) => this.nameOf(h)).join(", ") || "none of the ↩ activities"}`);
    return null;
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
