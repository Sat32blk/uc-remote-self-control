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
// quick presses add up: three "up" nudges while the first one is still being sent = +3, three presses
{
  const slow = { request: async (m, p, body) => { await new Promise((r) => setTimeout(r, 40)); sent.push(body.cmd_id); return {}; }, get: async () => ({}) };
  const Y = new Extras({ getCore: () => slow, engine: () => null, file: file + ".2", publish: () => {}, log: () => {}, warn: () => {} });
  Y.replace(validateExtras({ sliders: [base] }).extras); Y.values.slider_amp = 10; sent.length = 0;
  const ps = [Y.nudge("slider_amp", 1), Y.nudge("slider_amp", 1), Y.nudge("slider_amp", 1)];
  await Promise.all(ps); await new Promise((r) => setTimeout(r, 300));
  ok(Y.values.slider_amp === 13 && count("media_player.volume_up") === 3, `three quick presses up: 10 → ${Y.values.slider_amp} with ${count("media_player.volume_up")} presses`);
  sent.length = 0;
  await Promise.all([Y.nudge("slider_amp", -1), Y.nudge("slider_amp", -1)]); await new Promise((r) => setTimeout(r, 300));
  ok(Y.values.slider_amp === 11 && count("media_player.volume_down") === 2, `two quick presses down: → ${Y.values.slider_amp}`);
}
// stepping down to the bottom is quick (no whole-range sweep); a press at the bottom still presses down once
{
  const Z = new Extras({ getCore: () => core, engine: () => null, file: file + ".3", publish: () => {}, log: () => {}, warn: () => {} });
  Z.replace(validateExtras({ sliders: [base] }).extras); Z.values.slider_amp = 1; sent.length = 0;
  await Z.nudge("slider_amp", -1);
  ok(Z.values.slider_amp === 0 && count("media_player.volume_down") === 2, `step down from 1 to the bottom: ${count("media_player.volume_down")} presses (1 + 1 to be sure), not the whole range`);
  sent.length = 0;
  await Z.nudge("slider_amp", -1);
  ok(Z.values.slider_amp === 0 && count("media_player.volume_down") === 1, "down again at the bottom: one more press down, still 0");
}
// a whole-range sweep stops as soon as something new is asked
{
  const slow = { request: async (m, p, body) => { await new Promise((r) => setTimeout(r, 10)); sent.push(body.cmd_id); return {}; }, get: async () => ({}) };
  const Y = new Extras({ getCore: () => slow, engine: () => null, file: file + ".4", publish: () => {}, log: () => {}, warn: () => {} });
  Y.replace(validateExtras({ sliders: [base] }).extras); Y.values.slider_amp = 30; sent.length = 0;
  const p1 = Y.setValue("slider_amp", 0);
  await new Promise((r) => setTimeout(r, 120));
  const p2 = Y.nudge("slider_amp", 1);
  await Promise.all([p1, p2]); await new Promise((r) => setTimeout(r, 100));
  const downs = count("media_player.volume_down");
  ok(downs < 52 && downs > 0 && Y.values.slider_amp === Math.max(1, 30 - downs), `the sweep stopped after ${downs} of 52 presses when "up" was pressed; the slider is at ${Y.values.slider_amp}`);
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
