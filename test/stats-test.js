// Statistics recorder: uses, screen time, battery off the dock, idle drain, sleep gaps, settings, clear.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Stats } from "../src/bin/stats.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stats-")), "statistics.json");
const S = new Stats({ file, originalOf: (id) => (id === "uc.main.copy" ? "uc.main.tv" : id) });
const act = (id, on, name = id) => ({ entity_id: id, name: { en: name }, attributes: { state: on ? "ON" : "OFF" } });
let t = Date.UTC(2026, 9, 27, 18, 0), lvl = 80;
const tick = (acts, screen, docked = false) => { S.tick(t, acts, screen, { level: Math.round(lvl), charging: docked, on_charger: docked }); t += 20000; };
// 30 minutes of Watch TV, screen on half the time, battery dropping 3 points
for (let i = 0; i < 90; i++) { tick([act("uc.main.tv", true, "Watch TV")], i % 2 ? "on" : "off"); lvl -= 3 / 90; }
tick([act("uc.main.tv", false, "Watch TV")], "on");
ok(S.uses.length === 1 && S.uses[0].name === "Watch TV", "one use recorded when the activity turns off");
const u = S.uses[0];
ok(Math.abs((u.end - u.start) / 6e4 - 30) < 1, `about 30 minutes on (${((u.end - u.start) / 6e4).toFixed(1)})`);
ok(Math.abs(u.screen / 6e4 - 15) < 1, `about 15 minutes screen on (${(u.screen / 6e4).toFixed(1)})`);
ok(u.drain >= 2 && u.drain <= 4, `battery points used off the dock (${u.drain})`);
// nothing on: idle drain
const idle0 = S.idle.off;
for (let i = 0; i < 30; i++) { tick([], "off"); lvl -= 0.01; }
ok(S.idle.off > idle0, "time with nothing on counts as idle");
// on the dock: no drain counted
for (let i = 0; i < 30; i++) { tick([act("uc.main.copy", true, "Watch TV (copy)")], "on", true); lvl += 0.2; }
tick([], "on", true);
ok(S.uses.length === 2 && S.uses[1].id === "uc.main.tv" && S.uses[1].drain === 0 && S.uses[1].off === 0, "a launcher copy counts as its original; nothing counted on the dock");
// a sleep gap (2 hours): idle, not use
const before = S.idle.off;
S.pause(); t += 2 * 36e5; lvl -= 1; tick([act("uc.main.tv", true)], "on"); t += 20000;
ok(S.idle.off === before, "the first tick after sleep only starts the clock again");
for (let i = 0; i < 3; i++) tick([act("uc.main.tv", true)], "on");
// short use left out
tick([act("uc.main.tv", false), act("uc.main.music", true)], "on");
tick([act("uc.main.music", false)], "on");
ok(!S.uses.some((x) => x.id === "uc.main.music"), "uses shorter than 30 seconds are left out");
// battery readings every 15 minutes
ok(S.battery.length >= 3 && S.battery.every((b, i) => !i || b[0] - S.battery[i - 1][0] >= 15 * 6e4 - 5000), `battery readings every 15 minutes (${S.battery.length})`);
// saved and read back
S.save(true);
const R = new Stats({ file });
ok(R.uses.length === S.uses.length && R.battery.length === S.battery.length && R.cfg.every === 15, "saved and read back");
// settings and data
ok(S.setConfig({ every: 5, keepDays: 30, on: true }).every === 5 && S.cfg.keepDays === 30, "settings: reading interval and how long to keep");
ok(S.setConfig({ every: 7 }).every === 5, "unknown values are ignored");
const d = S.data(t);
ok(Array.isArray(d.uses) && d.cfg && d.idle && d.size > 0, "data for the builder");
ok(S.csv().startsWith("kind,activity,start,end") && S.csv().includes("Watch TV"), "CSV download");
// old data pruned
S.uses.unshift({ id: "x", name: "Old", start: t - 40 * 864e5, end: t - 40 * 864e5 + 6e5, screen: 0, off: 0, drain: 0 });
S.prune(t);
ok(!S.uses.some((x) => x.name === "Old"), "uses older than the keep period are removed");
S.clear();
ok(S.uses.length === 0 && S.battery.length === 0 && S.idle.off === 0, "clear");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
