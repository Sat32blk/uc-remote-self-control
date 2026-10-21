// Page jumps: rotate the page order (the remote jumps to its new first page), restore it after leaving,
// start-page rules for activities that aren't on screen, and the smart "page" step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PageJumper, validateStarts } from "../src/bin/pages.js";
import { validateRules, vCond, SmartEngine } from "../src/bin/smart.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const TV = "uc.main.tv", MUSIC = "uc.main.music";
const pages = {
  [TV]: [{ page_id: "p_live", name: "Live TV" }, { page_id: "p_apps", name: "Apps" }, { page_id: "p_rec", name: "Recordings" }, { page_id: "p_set", name: "Settings" }],
  [MUSIC]: [{ page_id: "m1", name: { en: "Main" } }, { page_id: "m2", name: { en: "Radio" } }]
};
const writes = [];
const core = {
  async get(p) { const m = /^\/activities\/([^/]+)\/ui\/pages$/.exec(p); if (m) return pages[decodeURI(m[1])].map((x) => ({ ...x })); throw new Error("no route " + p); },
  async patch(p, b) {
    const m = /^\/activities\/([^/]+)\/ui\/pages$/.exec(p);
    const id = decodeURI(m[1]);
    writes.push({ id, order: b.page_order });
    pages[id] = b.page_order.map((pid) => pages[id].find((x) => x.page_id === pid));
    return {};
  }
};
const order = (id) => pages[id].map((p) => p.page_id).join(",");
let screen = TV;
let shieldOn = false;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-"));
const pj = new PageJumper({ getCore: () => core, onScreen: () => screen, test: async (c) => (c.entity === "shield" ? shieldOn : false), file: path.join(dir, "pages.json") });

// ---- go to a page in the activity on screen ----
let r = await pj.goTo(null, "Recordings");
ok(order(TV) === "p_rec,p_set,p_live,p_apps" && r === "page Recordings", "go to Recordings: pages rotated so it's first, swipe order kept (" + order(TV) + ")");
ok(pj.saved[TV].join() === "p_live,p_apps,p_rec,p_set", "your own order is remembered");
await pj.goTo(null, "#2");
ok(order(TV) === "p_apps,p_rec,p_set,p_live", "\"#2\" = the 2nd page of your own order (Apps)");
await pj.goTo(null, "p_live");
ok(order(TV) === "p_live,p_apps,p_rec,p_set" && !pj.saved[TV], "back to your first page: your order again, nothing remembered");
writes.length = 0;
await pj.goTo(null, "live tv");
ok(writes.length === 2 && order(TV) === "p_live,p_apps,p_rec,p_set", "page already first while on screen: two writes so the remote still jumps");
let threw = ""; try { await pj.goTo(null, "Nope"); } catch (e) { threw = e.message; }
ok(/no page "Nope"/.test(threw), "unknown page: clear error");

// ---- leaving: the order goes back ----
await pj.goTo(null, "Apps");
screen = MUSIC;
await pj.opened(MUSIC);
ok(order(TV) === "p_live,p_apps,p_rec,p_set" && !pj.saved[TV], "after switching to Music, TV's own page order is back");

// ---- another activity: sets the page it opens on ----
writes.length = 0;
r = await pj.goTo(TV, "Settings");
ok(order(TV) === "p_set,p_live,p_apps,p_rec" && writes.length === 1 && /start page/.test(r), "go to a page of an activity not on screen: it will open there");

// ---- start-page rules ----
let v = validateStarts({ starts: [{ activity: TV, name: "Watch TV", rules: [{ if: { entity: "shield", is: "ON" }, page: "Apps" }], otherwise: "Live TV" }] });
ok(!v.errors.length, "valid start-page rule");
ok(validateStarts({ starts: [{ activity: TV, rules: [] }] }).errors.length === 1, "a rule needs a branch or an otherwise page");
pj.replaceStarts(v.starts);
await pj.refresh();
ok(order(TV).startsWith("p_live"), "Shield off: Watch TV opens on Live TV");
shieldOn = true;
writes.length = 0;
await pj.refresh();
ok(order(TV).startsWith("p_apps") && writes.length === 1, "Shield on: Watch TV now opens on Apps");
await pj.refresh();
ok(writes.length === 1, "nothing changed: nothing written");
screen = TV;
shieldOn = false;
await pj.refresh();
ok(order(TV).startsWith("p_apps"), "while Watch TV is on screen its pages aren't touched");
screen = MUSIC;
await pj.opened(MUSIC);
ok(order(TV).startsWith("p_live"), "after leaving, the start page follows the rule again (Live TV)");

// ---- the smart step ----
const ctx = { resolvable: (x) => x.includes("."), selfKnown: () => true };
let errs = [];
vCond({ entity: "a.b", is: "ON" }, "c", errs, ctx);
ok(!errs.length, "conditions validate with the smart engine's checker");
const rules = validateRules({ buttons: [{ id: "smart_apps", name: "Apps page", do: [{ page: "Apps" }, { page: "Radio", activity: MUSIC }] }] });
ok(!rules.errors.length, "smart step { page } and { page, activity } are valid");
ok(validateRules({ buttons: [{ id: "smart_x", name: "X", do: [{ page: "" }] }] }).errors.some((e) => /page/.test(e)), "empty page refused");

// ---- a page jump in an activity without that page: skipped, the other steps still run ----
{
  const ran = [];
  const eng = new SmartEngine({ core: () => null, self: { keys: ["haptic"], read: () => null, control: () => "", run: async (k, st) => ran.push(k), page: async (act, spec) => { if (spec !== "Apps") throw new Error(`no page "${spec}"`); return "page Apps"; } },
    varsFile: path.join(dir, "vars.json"), report: () => {}, log: () => {} });
  eng.load(JSON.stringify({ buttons: [{ id: "smart_jump", name: "Jump", do: [{ page: "Recordings" }, { self: "haptic", state: "toggle" }] }] }));
  const res = await eng.run("smart_jump");
  ok(ran.includes("haptic") && /no page "Recordings", page jump skipped/.test(String(res)), "missing page: jump skipped, next step still runs: " + JSON.stringify(res).slice(0, 160));
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
