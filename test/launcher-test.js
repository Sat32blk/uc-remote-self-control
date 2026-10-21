// Smart launchers: activity copies with the app step, kept like their original, rules that re-point the
// launcher's buttons (page buttons, physical buttons, home tiles), clean-up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Launchers, validateLaunchers } from "../src/bin/launcher.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const ROKU = "roku.main.mp", SHIELD = "atv.main.mp", TV = "tv.main.mp";
const WROKU = "uc.main.roku", WSHIELD = "uc.main.shield", HOMEACT = "uc.main.music";
const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 1;
const acts = {
  [WROKU]: { name: { en: "Watch Roku" }, entity_ids: [ROKU, TV], sequences: { on: [{ type: "command", command: { entity_id: TV, cmd_id: "media_player.on" } }, { type: "command", command: { entity_id: ROKU, cmd_id: "media_player.on" } }], off: [] },
    pages: [{ page_id: "r1", name: "Main", grid: { width: 4, height: 6 }, items: [{ type: "text", text: "Home", location: { x: 0, y: 0 }, size: { width: 2, height: 1 }, command: { entity_id: ROKU, cmd_id: "media_player.home" } }] }, { page_id: "r2", name: "Apps", items: [] }],
    buttons: [{ button: "HOME", short_press: { entity_id: ROKU, cmd_id: "media_player.home" } }] },
  [WSHIELD]: { name: { en: "Watch Shield" }, entity_ids: [SHIELD, TV], sequences: { on: [{ type: "command", command: { entity_id: SHIELD, cmd_id: "media_player.on" } }], off: [] }, pages: [{ page_id: "s1", name: "Main", items: [] }], buttons: [] },
  [HOMEACT]: { name: { en: "Music" }, entity_ids: [], sequences: { on: [], off: [] }, pages: [{ page_id: "m1", name: "Main", grid: { width: 4, height: 6 }, items: [] }], buttons: [] }
};
const groups = [{ group_id: "g1", name: { en: "Living room" }, activity_ids: [WROKU, WSHIELD] }];
const profiles = { pr1: [{ page_id: "h1", name: "Home", items: [{ entity_id: WROKU }] }] };
const writes = [];
const notFound = () => Object.assign(new Error("not found"), { status: 404 });
const core = {
  async get(p) {
    if (p.startsWith("/activities?")) return Object.entries(acts).map(([entity_id, a]) => ({ entity_id, name: a.name, options: {} }));
    let m;
    if ((m = /^\/activities\/([^/]+)$/.exec(p))) {
      const a = acts[decodeURI(m[1])]; if (!a) throw notFound();
      return { entity_id: decodeURI(m[1]), name: a.name, options: { included_entities: a.entity_ids.map((entity_id) => ({ entity_id })), sequences: clone(a.sequences) } };
    }
    if ((m = /^\/activities\/([^/]+)\/ui\/pages$/.exec(p))) return clone(acts[decodeURI(m[1])].pages);
    if ((m = /^\/activities\/([^/]+)\/buttons$/.exec(p))) return clone(acts[decodeURI(m[1])].buttons);
    if (p.startsWith("/activity_groups?")) return groups.map((g) => ({ group_id: g.group_id }));
    if ((m = /^\/activity_groups\/(.+)$/.exec(p))) return clone(groups.find((g) => g.group_id === m[1]));
    if (p === "/profiles") return [{ profile_id: "pr1" }];
    if ((m = /^\/profiles\/([^/]+)\/pages$/.exec(p))) return clone(profiles[m[1]]);
    if ((m = /^\/profiles\/([^/]+)\/pages\/([^/]+)$/.exec(p))) return clone(profiles[m[1]].find((x) => x.page_id === m[2]));
    throw new Error("no GET " + p);
  },
  async post(p, b) {
    writes.push({ m: "POST", p, b });
    if (p === "/activities") {
      const src = acts[b.clone_from];
      const id = "uc.main.copy" + seq++;
      acts[id] = { ...clone(src), name: b.name, icon: b.icon, pages: src.pages.map((pg) => ({ ...clone(pg), page_id: pg.page_id + "_c" + seq })) };
      const g = groups[0]; if (!g.activity_ids.includes(id)) g.activity_ids.push(id); // default group, like the core
      return { entity_id: id };
    }
    let m;
    if ((m = /^\/activities\/([^/]+)\/ui\/pages$/.exec(p))) { const pg = { page_id: "np" + seq++, ...b }; acts[decodeURI(m[1])].pages.push(pg); return { page_id: pg.page_id }; }
    if ((m = /^\/activities\/([^/]+)\/buttons$/.exec(p))) { acts[decodeURI(m[1])].buttons = clone(b); return b; }
    throw new Error("no POST " + p);
  },
  async patch(p, b) {
    writes.push({ m: "PATCH", p, b });
    let m;
    if ((m = /^\/activities\/([^/]+)$/.exec(p))) {
      const a = acts[decodeURI(m[1])];
      if (b.options?.entity_ids) a.entity_ids = b.options.entity_ids;
      if (b.options?.sequences) a.sequences = clone(b.options.sequences);
      if (b.name) a.name = b.name;
      return {};
    }
    if ((m = /^\/activities\/([^/]+)\/ui\/pages$/.exec(p))) { const a = acts[decodeURI(m[1])]; a.pages = b.page_order.map((id) => a.pages.find((x) => x.page_id === id)); return {}; }
    if ((m = /^\/activities\/([^/]+)\/ui\/pages\/([^/]+)$/.exec(p))) {
      const a = acts[decodeURI(m[1])];
      for (const it of b.items || []) if (it.command?.entity_id && !a.entity_ids.includes(it.command.entity_id)) throw new Error("entity not included: " + it.command.entity_id);
      Object.assign(a.pages.find((x) => x.page_id === decodeURIComponent(m[2])), b); return {};
    }
    if ((m = /^\/activities\/([^/]+)\/buttons\/([A-Z_]+)$/.exec(p))) {
      const a = acts[decodeURI(m[1])];
      const cmd = b.short_press || b.long_press;
      if (cmd?.entity_id && !a.entity_ids.includes(cmd.entity_id)) throw new Error("entity not included: " + cmd.entity_id);
      let x = a.buttons.find((y) => y.button === m[2]); if (!x) a.buttons.push((x = { button: m[2] }));
      Object.assign(x, b); return {};
    }
    if ((m = /^\/activity_groups\/(.+)$/.exec(p))) { groups.find((g) => g.group_id === m[1]).activity_ids = b.activity_ids; return {}; }
    if ((m = /^\/profiles\/([^/]+)\/pages\/([^/]+)$/.exec(p))) { profiles[m[1]].find((x) => x.page_id === m[2]).items = b.items; return {}; }
    throw new Error("no PATCH " + p);
  },
  async request(method, p) {
    writes.push({ m: method, p });
    let m;
    if (method === "DELETE" && (m = /^\/activities\/([^/]+)$/.exec(p))) { const id = decodeURI(m[1]); if (!acts[id]) throw notFound(); delete acts[id]; for (const g of groups) g.activity_ids = g.activity_ids.filter((x) => x !== id); return {}; }
    if (method === "DELETE" && (m = /^\/activities\/([^/]+)\/ui\/pages\/([^/]+)$/.exec(p))) { const a = acts[decodeURI(m[1])]; a.pages = a.pages.filter((x) => x.page_id !== decodeURIComponent(m[2])); return {}; }
    throw new Error("no " + method + " " + p);
  }
};

// ---- validation ----
const input = { launchers: [{ name: "Netflix", icon: "uc:netflix",
  targets: [{ activity: WROKU, steps: [{ entity_id: ROKU, cmd_id: "media_player.select_source", params: { source: "Netflix" } }], delay: 2000 },
    { activity: WSHIELD, steps: [{ entity_id: SHIELD, cmd_id: "media_player.select_source", params: { source: "Netflix" } }] }],
  rules: [{ if: { entity: SHIELD, is: "ON" }, target: WSHIELD }], otherwise: WROKU }] };
let v = validateLaunchers(input);
ok(!v.errors.length && v.launchers[0].id === "launch_netflix", "valid launcher, id from its name: " + v.errors.join("; "));
ok(validateLaunchers({ launchers: [{ name: "X", targets: [] }] }).errors.some((e) => /at least one activity/.test(e)), "a launcher needs an activity");
ok(validateLaunchers({ launchers: [{ name: "X", targets: [{ activity: WROKU, steps: [] }], rules: [{ if: { entity: "a.b", is: "ON" }, target: WSHIELD }] }] }).errors.some((e) => /one of the launcher's activities/.test(e)), "a branch must pick one of the launcher's activities");
ok(validateLaunchers({ launchers: [{ name: "X", targets: [{ activity: WROKU, steps: [{ entity_id: "" }] }] }] }).errors.some((e) => /device and its command/.test(e)), "an app step needs device and command");

// ---- copies ----
let shieldOn = false, screen = null;
const changed = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ln-"));
const L = new Launchers({ getCore: () => core, onScreen: () => screen, test: async (c) => (c.entity === SHIELD ? shieldOn : false), file: path.join(dir, "launchers.json"),
  hooks: { copyChanged: (id) => changed.push(id) } });
let problems = await L.replace(v.launchers);
ok(!problems.length, "launchers saved without problems: " + problems.join("; "));
const cRoku = L.copies.launch_netflix[WROKU].id, cShield = L.copies.launch_netflix[WSHIELD].id;
ok(cRoku && cShield && cRoku !== cShield, "a copy per activity: " + cRoku + ", " + cShield);
const on = acts[cRoku].sequences.on;
ok(on.length === 4 && on[2].type === "delay" && on[2].delay === 2000 && on[3].command.cmd_id === "media_player.select_source" && on[3].command.params.source === "Netflix",
  "copy's start sequence = the original's + wait + app step");
ok(acts[cRoku].name.en === "Netflix", "copy is named after the launcher");
ok(acts[cRoku].pages.length === 2 && acts[cRoku].buttons[0].button === "HOME", "copy has the original's pages and buttons");
ok(groups[0].activity_ids.includes(cRoku) && groups[0].activity_ids.includes(cShield), "copies are in the original's activity group");
ok(L.originalOf(cRoku) === WROKU && L.copiesOf(WROKU)[0] === cRoku && L.originalOf(WROKU) === WROKU, "copy ↔ original lookups");
ok(changed.includes(cRoku), "copyChanged hook called after the copy's pages were written");

// ---- placing buttons ----
await L.place("launch_netflix", { kind: "page", activity: HOMEACT });
let item = acts[HOMEACT].pages[0].items.find((it) => it.command?.cmd_id === "activity.start");
ok(item && item.command.entity_id === cRoku && item.type === "icon" && item.icon === "uc:netflix", "button placed on a page, starts the Roku copy (Shield is off)");
ok(acts[HOMEACT].entity_ids.includes(cRoku), "the copy was added to the activity's devices first");
await L.place("launch_netflix", { kind: "button", activity: WSHIELD, button: "RED" });
ok(acts[WSHIELD].buttons.find((b) => b.button === "RED")?.short_press?.entity_id === cRoku, "physical button mapped");
profiles.pr1[0].items.push({ entity_id: cRoku }); // the user added a home tile in the web configurator
await L.scan();
ok(L.places.launch_netflix.length === 3 && L.places.launch_netflix.some((p) => p.kind === "home"), "scan finds page, physical and home buttons: " + JSON.stringify(L.places.launch_netflix.map((p) => p.kind)));

// ---- rules re-point ----
shieldOn = true;
await L.check();
item = acts[HOMEACT].pages[0].items.find((it) => it.command?.cmd_id === "activity.start");
ok(item.command.entity_id === cShield, "Shield on: the page button now starts the Shield copy");
ok(acts[WSHIELD].buttons.find((b) => b.button === "RED").short_press.entity_id === cShield, "physical button re-pointed");
ok(profiles.pr1[0].items.some((it) => it.entity_id === cShield) && profiles.pr1[0].items.some((it) => it.entity_id === WROKU), "home tile re-pointed, other tiles kept");
writes.length = 0;
await L.check();
ok(!writes.some((w) => w.m !== "GET"), "nothing changed: nothing written");

// ---- the activity on screen waits ----
screen = HOMEACT;
shieldOn = false;
await L.check();
item = acts[HOMEACT].pages[0].items.find((it) => it.command?.cmd_id === "activity.start");
ok(item.command.entity_id === cShield && acts[WSHIELD].buttons.find((b) => b.button === "RED").short_press.entity_id === cRoku, "page on screen waits (no jump to page 1), physical button changes at once");
screen = WSHIELD;
await L.opened(WSHIELD);
item = acts[HOMEACT].pages[0].items.find((it) => it.command?.cmd_id === "activity.start");
ok(item.command.entity_id === cRoku, "after leaving, the waiting page button follows");
screen = null;

// ---- copies follow their original ----
acts[WROKU].pages[0].items.push({ type: "text", text: "New", location: { x: 0, y: 1 }, size: { width: 1, height: 1 } });
acts[WROKU].sequences.on.push({ type: "command", command: { entity_id: TV, cmd_id: "media_player.select_source", params: { source: "HDMI1" } } });
L.syncedAt = 0;
await L.check();
ok(acts[cRoku].pages[0].items.some((it) => it.text === "New"), "a page change of the original reaches the copy");
ok(acts[cRoku].sequences.on.length === 5 && acts[cRoku].sequences.on[4].command.cmd_id === "media_player.select_source" && acts[cRoku].sequences.on[2].command.params.source === "HDMI1", "a sequence change too, app step stays last");
// a launcher pointer in the original doesn't count as a change (it changes with the rules)
const homePageItems = acts[WROKU].pages[0].items;
homePageItems.push({ type: "icon", icon: "uc:netflix", location: { x: 3, y: 5 }, size: { width: 1, height: 1 }, command: { entity_id: cRoku, cmd_id: "activity.start" } });
acts[WROKU].entity_ids.push(cRoku);
L.syncedAt = 0; await L.check();
writes.length = 0;
homePageItems[homePageItems.length - 1].command.entity_id = cShield;
L.syncedAt = 0; await L.check();
ok(!writes.some((w) => w.m !== "GET" && w.p.includes(cRoku + "/ui")), "re-pointing a launcher button in the original doesn't rewrite the copy's pages");
// copy deleted on the remote: made again
delete acts[cShield];
L.syncedAt = 0; await L.check();
ok(L.copies.launch_netflix[WSHIELD].id !== cShield && acts[L.copies.launch_netflix[WSHIELD].id], "a copy deleted on the remote is made again");

// ---- removing ----
const cShield2 = L.copies.launch_netflix[WSHIELD].id;
problems = await L.replace([{ ...v.launchers[0], targets: [v.launchers[0].targets[0]], rules: [], otherwise: WROKU }]);
ok(!acts[cShield2] && !L.copies.launch_netflix[WSHIELD], "an activity taken out of a launcher: its copy is deleted");
const done = await L.removeAll();
item = acts[HOMEACT].pages[0].items.find((it) => it.command?.cmd_id === "activity.start");
ok(!acts[cRoku] && item.command.entity_id === WROKU && acts[WSHIELD].buttons.find((b) => b.button === "RED").short_press.entity_id === WROKU, "remove everything: buttons start the original activity again, copies deleted: " + done.join("; "));
ok(profiles.pr1[0].items.every((it) => it.entity_id === WROKU), "home tiles back to the original");
ok(!L.enabled, "nothing left");

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
