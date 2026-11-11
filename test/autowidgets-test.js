// Auto Widgets: validation, spots on a one-page activity (base kept, pause on outside changes), Smart widgets
// (added to the remote and the activity, placed, mirroring, commands, browsing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoWidgets, validateAutoWidgets, itemFor } from "../src/bin/autowidgets.js";
import { SmartEngine } from "../src/bin/smart.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-"));
const icon = (x, y, t) => ({ type: "text", text: t, location: { x, y }, size: { width: 1, height: 1 } });
const icons = []; for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) icons.push(icon(x, y, `b${x}${y}`));
const ent = {
  "x.atv": { attributes: { state: "PLAYING", source: "Plex" } },
  "x.plex": { attributes: { state: "PLAYING", media_title: "Movie" } },
  "x.roku": { attributes: { state: "ON", media_title: "Home" } },
  "x.rx": { attributes: { state: "ON", source: "TUNER", options: ["TUNER", "GAME"], current_option: "TUNER" } }
};
const acts = {
  one: { options: { included_entities: [] }, pages: [{ page_id: "p1", name: "Main", grid: { width: 4, height: 6 }, items: icons.map((i) => ({ ...i })) }] },
  multi: { options: { included_entities: [] }, pages: [{ page_id: "m1", name: "Main", grid: { width: 4, height: 6 }, items: [icon(0, 0, "Home")] }, { page_id: "m2", name: "Apps", grid: { width: 4, height: 6 }, items: [] }] }
};
const remote = new Set(); const writes = []; const cmds = []; const gets = [];
const core = {
  get: async (p) => {
    gets.push(p);
    let m;
    if ((m = /^\/entities\/([^/?]+)$/.exec(p))) { const id = decodeURI(m[1]); if (ent[id]) return ent[id]; if (remote.has(id)) return { entity_id: id }; const e = new Error("404"); e.status = 404; throw e; }
    if ((m = /^\/activities\/([^/?]+)\/ui\/pages$/.exec(p))) return JSON.parse(JSON.stringify(acts[decodeURI(m[1])].pages));
    if ((m = /^\/activities\/([^/?]+)$/.exec(p))) return { options: { included_entities: acts[decodeURI(m[1])].options.included_entities.map((id) => ({ entity_id: id })) } };
    if (p.startsWith("/intg/instances/")) return [];
    throw new Error("unexpected GET " + p);
  },
  patch: async (p, body) => {
    writes.push([p, body]);
    let m;
    if ((m = /^\/activities\/([^/?]+)\/ui\/pages\/([^/?]+)$/.exec(p))) { const pg = acts[decodeURI(m[1])].pages.find((x) => x.page_id === decodeURIComponent(m[2])); pg.items = JSON.parse(JSON.stringify(body.items)); return; }
    if ((m = /^\/activities\/([^/?]+)$/.exec(p))) { acts[decodeURI(m[1])].options.included_entities = body.options.entity_ids; return; }
  },
  post: async (p, body) => { writes.push([p, body]); for (const id of body) remote.add("self_control.main." + id); },
  request: async (m, p, body) => { cmds.push([p, body]); },
  getPaged: async (p) => { gets.push(p); return { data: { media: { title: "Library", items: [{ media_id: "a" }] } }, count: 1, limit: 10, page: 1 }; }
};
const smart = new SmartEngine({ core: () => core, self: { keys: [], read: () => undefined, control: () => undefined }, varsFile: path.join(dir, "vars.json") });
const sent = {};
const aw = new AutoWidgets({ getCore: () => core, test: (c, cache) => smart.test(c, cache), publish: (id, a) => { sent[id] = a; }, file: path.join(dir, "aw.json") });

// validation
let v = validateAutoWidgets({ widgets: [{ id: "bad", name: "", kind: "spot", activity: "one", page: "p1", cases: [], otherwise: {} }] });
ok(v.errors.some((e) => /name/.test(e)) && v.errors.some((e) => /id must/.test(e)) && v.errors.some((e) => /place it/.test(e)), "validation: name, id and place required");
const spot = {
  id: "aw_player", name: "Player spot", kind: "spot", activity: "one", page: "p1", area: { x: 0, y: 4, w: 4, h: 2 },
  cases: [
    { if: { entity: "x.plex", is: "PLAYING" }, show: "x.plex", type: "media_player" },
    { if: { entity: "x.atv", attr: "source", is: "Plex" }, show: "x.plex", type: "media_player", area: { x: 0, y: 0, w: 4, h: 4 } }
  ],
  otherwise: { show: "" }
};
const spot2 = { id: "aw_rx", name: "Receiver", kind: "spot", activity: "one", page: "p1", area: { x: 0, y: 5, w: 4, h: 1 },
  cases: [{ if: { entity: "x.rx", is: "ON" }, show: "x.rx", type: "select" }], otherwise: { show: "" } };
const smartW = { id: "aw_shield", name: "Shield player", kind: "media", activity: "multi", page: "m2", area: { x: 0, y: 3, w: 4, h: 3 },
  cases: [{ if: { entity: "x.atv", attr: "source", is: "Plex" }, show: "x.plex" }], otherwise: { show: "x.roku" } };
v = validateAutoWidgets({ widgets: [spot, spot2, smartW] });
ok(!v.errors.length, "valid widgets accepted " + v.errors.join("; "));
ok(validateAutoWidgets({ widgets: [{ ...smartW, area: { x: 0, y: 0, w: 1, h: 1 } }] }).errors.length === 0, "a Smart widget's place is checked against the page on save");

// a Smart widget over an icon on a multi-page activity is refused
let r = await aw.replace(validateAutoWidgets({ widgets: [{ ...smartW, page: "m1", area: { x: 0, y: 0, w: 2, h: 2 } }] }).widgets);
ok(r.errors.some((e) => /isn't empty/.test(e)) && writes.length === 0, "multi-page: a place over icons is refused, nothing written");
r = await aw.replace(validateAutoWidgets({ widgets: [{ ...smartW, kind: "spot", cases: [], otherwise: { show: "" } }] }).widgets);
ok(r.errors.some((e) => /one-page/.test(e)), "a spot on a multi-page activity is refused");

let registered = false;
r = await aw.replace(v.widgets, { beforePlace: async () => { registered = true; } });
ok(!r.errors.length, "saved " + r.errors.join("; "));
ok(registered, "entities registered before placing");
ok(remote.has("self_control.main.aw_shield"), "the Smart widget is added to the remote");
ok(acts.multi.options.included_entities.includes("self_control.main.aw_shield"), "…and to its activity");
ok(acts.one.options.included_entities.includes("x.plex") && acts.one.options.included_entities.includes("x.rx"), "spot devices added to the one-page activity");
const m2 = acts.multi.pages[1].items;
ok(m2.length === 1 && m2[0].media_player_id === "self_control.main.aw_shield" && m2[0].size.height === 3, "the Smart widget is placed on its page");
// spot: Plex playing → branch 1 at its place (rows 5-6), the receiver below is blocked
let p1 = acts.one.pages[0].items;
ok(p1.some((it) => it.media_player_id === "x.plex" && it.location.y === 4), "spot shows the Plex widget at its place");
ok(p1.filter((it) => it.type === "text").length === 16, "the 8 covered icons are taken off, 16 stay");
ok(aw.status.aw_rx.state === "blocked" && aw.status.aw_player.state === "showing", "the lower spot is blocked by the higher one");
ok(aw.status.aw_player.branch === 0 && aw.status.aw_player.conds[0][0] === true, "status: branch and condition results");
ok(sent.aw_shield.media_title === "Movie", "Smart widget shows Plex (Shield source is Plex)");

// Plex stops: branch 2 (Shield on Plex) → big widget at the top
ent["x.plex"].attributes.state = "OFF";
await new Promise((ok2) => setTimeout(ok2, 1100));
await aw.refresh();
p1 = acts.one.pages[0].items;
ok(p1.some((it) => it.media_player_id === "x.plex" && it.location.y === 0 && it.size.height === 4), "second branch: Plex widget at another place");
ok(p1.some((it) => it.select?.select_id === "x.rx" && it.location.y === 5), "the receiver spot shows now that nothing covers it");
ok(p1.filter((it) => it.type === "text").length === 4, "icons under both widgets hidden");
// Shield leaves Plex: both widgets go, receiver stays; then receiver off → all icons back
ent["x.atv"].attributes.source = "Netflix";
ent["x.rx"].attributes.state = "OFF";
await new Promise((ok2) => setTimeout(ok2, 1100));
await aw.refresh();
p1 = acts.one.pages[0].items;
ok(p1.length === 24 && p1.every((it) => it.type === "text"), "nothing shows: all 24 icons back");
ok(sent.aw_shield.media_title === "Home", "Smart widget switched to the Roku (otherwise)");
// buttons and browsing go to the shown device
await aw.command("aw_shield", "play_pause");
ok(cmds.at(-1)[0] === "/entities/x.roku/command" && cmds.at(-1)[1].cmd_id === "media_player.play_pause", "a button goes to the shown device");
const br = await aw.browse("aw_shield", { paging: { page: 1, limit: 10 } });
ok(gets.at(-1).startsWith("/entities/x.roku/media/browse?") && br.media.items.length === 1, "browsing asks the shown device");
// someone edits the page (e.g. the Page Editor): the edit is kept, not overwritten
acts.one.pages[0].items[0] = icon(0, 0, "EDITED");
ent["x.rx"].attributes.state = "ON";
await new Promise((ok2) => setTimeout(ok2, 1100));
await aw.refresh();
p1 = acts.one.pages[0].items;
ok(!aw.paused.one && p1.some((it) => it.text === "EDITED") && p1.some((it) => it.select?.select_id === "x.rx"), "an edit made meanwhile is kept and the receiver shows");
// the reported bug: a widget shows, icons are added and one is deleted elsewhere, then the widget goes away
ent["x.plex"].attributes.state = "PLAYING"; ent["x.rx"].attributes.state = "OFF";
await new Promise((ok2) => setTimeout(ok2, 1100));
await aw.refresh();
p1 = acts.one.pages[0].items;
ok(p1.some((it) => it.media_player_id === "x.plex" && it.location.y === 4) && p1.filter((it) => it.type === "text").length === 16, "Plex widget shows over the bottom rows");
const page = acts.one.pages[0];
page.items = page.items.filter((it) => !(it.type === "text" && it.location.x === 3 && it.location.y === 3)); // deleted
page.items.push(icon(3, 3, "NEW"));                                                                       // added in its place
page.items = page.items.filter((it) => !(it.type === "text" && it.location.x === 2 && it.location.y === 3)); // deleted, nothing added
page.items.push({ ...itemFor("media_player", "x.plex", { x: 0, y: 4, w: 4, h: 2 }), extra: true });          // the editor saved our widget with an extra field
page.items = page.items.filter((it) => !(it.media_player_id === "x.plex" && !it.extra));
ent["x.plex"].attributes.state = "OFF";
await new Promise((ok2) => setTimeout(ok2, 1100));
await aw.refresh();
p1 = acts.one.pages[0].items;
ok(p1.some((it) => it.text === "NEW" && it.location.x === 3 && it.location.y === 3), "an icon added while a widget showed is still there when it goes");
ok(!p1.some((it) => it.location?.x === 2 && it.location?.y === 3), "an icon deleted while a widget showed stays deleted");
ok(p1.filter((it) => it.location.y >= 4 && it.type === "text").length === 8 && !p1.some((it) => it.media_player_id), "the covered icons come back, the widget is gone");
ok(p1.some((it) => it.text === "EDITED"), "the earlier edit is still there");
// remove everything: the page gets its icons back, the Smart widget comes off its page
r = await aw.replace([]);
p1 = acts.one.pages[0].items;
ok(p1.length === 23 && p1.some((it) => it.text === "EDITED") && p1.some((it) => it.text === "NEW") && !p1.some((it) => it.type !== "text"), "removing the spots puts the icons back (with your edits)");
ok(acts.multi.pages[1].items.length === 0, "removing the Smart widget takes it off its page");
ok(JSON.stringify(itemFor("sensor", "s.x", { x: 1, y: 2, w: 2, h: 1 })) === JSON.stringify({ type: "sensor", location: { x: 1, y: 2 }, size: { width: 2, height: 1 }, sensor: { sensor_id: "s.x", show_label: false } }), "sensor item format");

// widgets shown for a few seconds
v = validateAutoWidgets({ widgets: [{ ...spot2, cases: [{ ...spot2.cases[0], dur: { mode: "change", secs: 0 } }] }] });
ok(v.errors.some((e) => /seconds/.test(e)) && v.errors.some((e) => /value to watch/.test(e)), "timed: seconds and the watched value are checked");
const pop = { ...spot2, id: "aw_pop", name: "Input pop-up", cases: [{ ...spot2.cases[0], dur: { mode: "change", secs: 1, watch: { entity: "x.rx", attr: "source" } } }] };
const rise = { ...spot2, id: "aw_rise", name: "Roku pop-up", area: { x: 0, y: 0, w: 4, h: 1 }, cases: [{ if: { entity: "x.roku", is: "PLAYING" }, show: "x.roku", type: "media_player", dur: { mode: "rise", secs: 3 } }] };
v = validateAutoWidgets({ widgets: [pop, rise] });
ok(!v.errors.length && v.widgets[0].cases[0].dur.watch.attr === "source", "timed widgets accepted " + v.errors.join("; "));
ent["x.rx"].attributes.state = "ON"; ent["x.roku"].attributes.state = "ON";
r = await aw.replace(v.widgets);
const has = (f) => acts.one.pages[0].items.some(f);
ok(!r.errors.length && !has((it) => it.select) && !has((it) => it.media_player_id), "nothing pops up just because it was saved");
await new Promise((ok2) => setTimeout(ok2, 1100));
ent["x.rx"].attributes.source = "GAME";
await aw.refresh();
ok(has((it) => it.select?.select_id === "x.rx") && aw.status.aw_pop.until > Date.now() && aw.status.aw_pop.secs === 1, "the input changed: the pop-up shows, with when it hides");
await new Promise((ok2) => setTimeout(ok2, 2300));
await aw.busy;
ok(!has((it) => it.select), "…and is gone after its seconds (on its own)");
ent["x.roku"].attributes.state = "PLAYING";
await aw.refresh();
await new Promise((ok2) => setTimeout(ok2, 1200)); await aw.busy;
ok(has((it) => it.media_player_id === "x.roku"), "rise: shows when the Roku starts playing");
await new Promise((ok2) => setTimeout(ok2, 3300)); await aw.busy;
ok(!has((it) => it.media_player_id === "x.roku") && ent["x.roku"].attributes.state === "PLAYING", "…and goes away after its seconds although it's still playing");
await aw.replace([]);

console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
