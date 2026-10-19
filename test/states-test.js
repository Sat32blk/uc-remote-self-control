// Device states: live read, values seen, watching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceStates } from "../src/bin/states.js";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const ent = { entity_type: "media_player", name: { en: "Marantz" }, attributes: { state: "ON", source: "SHIELD", source_list: ["SHIELD", "ROKU"], volume: 24, muted: false, sound_mode: "STEREO", media_image_url: "x" } };
const core = { get: async (p) => (p === "/entities/rx" ? JSON.parse(JSON.stringify(ent)) : null) };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "st-")), "seen.json");
const s = new DeviceStates({ getCore: () => core, file });
let r = await s.read("rx");
ok(r.name === "Marantz" && r.attributes.source === "SHIELD" && r.lists.source_list.length === 2 && !("media_image_url" in r.attributes), "reads attributes, lists apart, no image url");
ok(r.seen.source.join() === "SHIELD" && r.seen.volume.min === 24 && r.seen.muted.join() === "false", "values seen recorded (text, number range, boolean)");
ent.attributes.source = "ROKU"; ent.attributes.volume = 40; ent.attributes.sound_mode = "DOLBY ATMOS";
s.watch("rx", true);
await s.poll();
ok(s.seen.rx.source.join() === "SHIELD,ROKU" && s.seen.rx.volume.max === 40 && s.seen.rx.sound_mode.includes("DOLBY ATMOS"), "background poll of a watched device adds new values");
const s2 = new DeviceStates({ getCore: () => core, file });
ok(s2.watched.includes("rx") && s2.seen.rx.sound_mode.includes("DOLBY ATMOS"), "values seen and the watch list survive a restart");
s2.forget("rx");
ok(!s2.seen.rx, "forget clears a device's values");
ok(s2.watch("rx", false).length === 0, "unwatch");
let threw = false; try { await s.read("nope"); } catch { threw = true; }
ok(threw, "unknown device is an error");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
