// The remote's own events → return tracker: reopening an activity that is already on (↩) is seen,
// and the activity left is turned off when it's marked for that.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoreEvents } from "../src/bin/coreevents.js";
import { ReturnTracker } from "../src/bin/returnbtn.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const SHIELD = "uc.main.shield", DEV = "uc.main.receiver_page";
const sent = [];
const core = {
  async get(p) { if (p.startsWith("/activities")) return []; throw new Error("no route " + p); },
  async patch() { return {}; },
  async request(method, p, b) { sent.push({ method, p, ...b }); return {}; }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
const rt = new ReturnTracker({ getCore: () => core, file: path.join(dir, "return.json"), log: () => {}, warn: () => {} });
rt.cfg.hosts = [DEV];
rt.cfg.hostCfg = { [DEV]: { screen: "none", button: "NONE", close: true } };
rt.refresh = async () => {}; // no pages to update here
rt.history = [SHIELD];
rt.states = { [SHIELD]: "ON", [DEV]: "OFF" };

const ev = new CoreEvents({ address: "x", apiKey: "k", onActivity: (id) => rt.opened(id) });
const msg = (id, attrs) => Buffer.from(JSON.stringify({ kind: "event", msg: "entity_change", cat: "ENTITY", msg_data: { entity_id: id, entity_type: "activity", event_type: "CHANGE", new_state: { attributes: attrs } } }));
const tick = () => new Promise((r) => setTimeout(r, 20));

// the user opens the receiver page (already on: only an "ON" event, no sequence)
rt.states[DEV] = "ON";
ev.onMessage(msg(DEV, { state: "ON" }));
await tick();
ok(rt.current === DEV && rt.previous === SHIELD, "event: receiver page opened, previous Shield");
ok(!sent.length, "nothing turned off when entering");

// ↩ back to Shield, which is still on: it re-runs its sequence, then reports ON
ev.onMessage(msg(SHIELD, { state: "RUNNING", step: { index: 1 } }));
await tick();
ok(rt.current === DEV, "RUNNING steps alone don't count as opened");
ev.onMessage(msg(SHIELD, { state: "ON" }));
await tick();
ok(rt.current === SHIELD, "event: Shield reopened with ↩ (already on) is seen");
ok(sent.some((c) => c.p === `/entities/${DEV}/command` && c.cmd_id === "activity.off"), "the receiver page (turn off when leaving) gets activity.off");
ok(ev.events.length === 3 && ev.events.every((e) => e.msg === "entity_change"), "test panel keeps the activity events");

// a repeat ON for the current activity changes nothing
sent.length = 0;
ev.onMessage(msg(SHIELD, { state: "ON" }));
await tick();
ok(!sent.length && rt.current === SHIELD, "repeat ON of the current activity: nothing happens");

// other entities are ignored
ev.onMessage(Buffer.from(JSON.stringify({ kind: "event", msg: "entity_change", msg_data: { entity_id: "x.sensor", entity_type: "sensor", new_state: { attributes: { state: "ON" } } } })));
ok(ev.events.length === 4 && rt.current === SHIELD, "non-activity events ignored");

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
