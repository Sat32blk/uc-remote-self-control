// A slider that counts presses (no value reported): setting the bottom presses down the whole range,
// so the guess starts from zero again; with zeroSync off it only presses the difference.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Extras, validateExtras } from "../src/bin/extras.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sent = [];
const core = { request: async (method, p, body) => { sent.push(body.cmd_id); return {}; }, get: async () => ({}) };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zs-")), "sliders_menus.json");
const X = new Extras({ getCore: () => core, engine: () => null, file, publish: () => {}, log: () => {}, warn: () => {} });
const base = { id: "slider_amp", name: "Amp volume", entity: "media_player.amp", min: 0, max: 50, step: 1, mode: "steps", up: "media_player.volume_up", down: "media_player.volume_down", per_press: 1, delay: 0 };
let v = validateExtras({ sliders: [base] });
ok(!v.errors.length && v.extras.sliders[0].zeroSync === undefined, "on by default");
X.replace(v.extras);
const count = (c) => sent.filter((x) => x === c).length;
await X.setValue("slider_amp", 30);
ok(count("media_player.volume_up") === 30 && X.values.slider_amp === 30, "from the unknown start (the bottom): 30 presses up");
sent.length = 0;
await X.setValue("slider_amp", 0);
ok(count("media_player.volume_down") === 52 && X.values.slider_amp === 0, `to the bottom: the whole range down (${count("media_player.volume_down")} presses)`);
sent.length = 0;
await X.setValue("slider_amp", 10);
ok(count("media_player.volume_up") === 10 && X.values.slider_amp === 10, "then counting from zero: 10 up");
// off: only the difference
v = validateExtras({ sliders: [{ ...base, zeroSync: false }] });
ok(v.extras.sliders[0].zeroSync === false, "can be turned off");
X.replace(v.extras); X.values.slider_amp = 10; sent.length = 0;
await X.setValue("slider_amp", 0);
ok(count("media_player.volume_down") === 10, "turned off: only 10 down");
// a slider that reads the device's value isn't swept
v = validateExtras({ sliders: [{ ...base, attr: "volume" }] });
X.replace(v.extras); X.values.slider_amp = 5; sent.length = 0;
await X.setValue("slider_amp", 0);
ok(count("media_player.volume_down") === 5, "a slider that reads the value presses only the difference");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
