// Display sensors: validation, formats, switching, messages, scrolling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateDisplays, formatValue, scrollText, width, barOf, Displays } from "../src/bin/displays.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disp-"));

// ---- validation
const good = { displays: [{ id: "disp_volume", name: "Volume", size: "4x2",
  def: { type: "value", src: { ent: "slider:slider_rx", attr: "value" }, fmt: "dec", before: "🔊 ", after: " dB" },
  rules: [
    { when: { type: "changes", src: { ent: "slider:slider_tv", attr: "value" } }, show: { type: "value", src: { ent: "slider:slider_tv", attr: "value" }, fmt: "bar", bar: "green", cells: 5, pct: true, before: "📺 " }, dur: "4", prio: "normal" },
    { when: { type: "control", control: "" }, show: { type: "value", src: { ent: "control", attr: "value" }, fmt: "num", before: "💡 ", after: " %" }, dur: "while", prio: "high" },
    { when: { type: "above", src: { ent: "slider:slider_rx", attr: "value" }, val: -10 }, show: { type: "messages", steps: [{ t: "Careful", s: 1 }, { t: "Loud!", s: 1 }], repeat: "loop" }, dur: "while", prio: "normal" },
    { when: { type: "activity", activity: "uc.main.watch" }, show: { type: "messages", steps: [{ t: "Starting…", s: 1 }, { t: "Enjoy!", s: 2 }], repeat: "once" }, dur: "once", prio: "high" },
  ] }] };
let v = validateDisplays(good);
ok(!v.errors.length, "a full display is valid: " + v.errors.join("; "));
ok(v.displays[0].rules[0].show.bar === "green" && v.displays[0].rules[0].show.cells === 5, "bar style and cells kept");
v = validateDisplays({ displays: [{ id: "bad id", name: "", def: { type: "messages", steps: [] }, rules: [{ when: { type: "above", src: { ent: "x.y" }, val: "abc" }, show: { type: "value" }, dur: "999" }] }] });
ok(v.errors.some((e) => /name/.test(e)) && v.errors.some((e) => /id must/.test(e)) && v.errors.some((e) => /at least one message/.test(e)) && v.errors.some((e) => /a number/.test(e)) && v.errors.some((e) => /pick what to show/.test(e)) && v.errors.some((e) => /1–300 seconds/.test(e)), "bad input explained: " + v.errors.length + " errors");
v = validateDisplays({ displays: [{ id: "disp_a", name: "A", def: { type: "value", src: { ent: "clock", attr: "time" } }, rules: [{ when: { type: "changes", src: { ent: "clock", attr: "time" } }, show: { type: "value", src: { ent: "clock", attr: "time" } }, dur: "while" }] }] });
ok(v.displays[0].rules[0].dur === "4", "'while it's true' only for conditions that can stay true");
ok(validateDisplays({ displays: [{ id: "disp_a", name: "A", def: { type: "value", src: { ent: "clock" } }, rules: [] }, { id: "disp_a", name: "B", def: { type: "value", src: { ent: "clock" } }, rules: [] }] }).errors.some((e) => /twice/.test(e)), "duplicate ids refused");

// ---- formats
ok(formatValue(-35.46, { fmt: "dec" }) === "−35.5", "dec with a real minus");
ok(formatValue(37.6, { fmt: "num" }) === "38", "num rounds");
ok(formatValue("HDMI 2", { fmt: "text" }) === "HDMI 2" && formatValue(undefined, { fmt: "num" }) === "–", "text, and a dash for no value");
ok(formatValue(60, { fmt: "bar", bar: "sq", cells: 5, pct: true }) === "◼◼◼◻◻ 60 %", "square bar with %");
ok(formatValue(-45, { fmt: "bar", bar: "green", cells: 5 }, { min: -80, max: 10 }) === "🟩🟩⬜⬜⬜", "bar uses the source's range");
ok(barOf(0.5, { bar: "hash", cells: 4 }) === "[##--]", "keyboard bar in brackets");
ok(!/[█░▌▁▰━□○▼]/.test(Object.keys({ sq: 1, small: 1, green: 1, dots: 1, blue: 1, black: 1, hash: 1, pipe: 1 }).map((b) => barOf(0.5, { bar: b, cells: 6 })).join("")), "bars only use characters that showed on the remote");
ok(width("📺 ab") === 5, "emoji are two cells wide");
ok(scrollText("short", 26, 99999) === "short", "short text doesn't scroll");
const long = "♪ Radiohead · Reckoner (In Rainbows, 2007)";
ok(scrollText(long, 20, 0) === scrollText(long, 20, 1400) && scrollText(long, 20, 0).startsWith("♪ Radiohead"), "scroll pauses at the start");
ok(scrollText(long, 20, 1500 + 300) !== scrollText(long, 20, 0) && width(scrollText(long, 20, 5000)) <= 20, "then moves, within the width");

// ---- engine
let t = 1000;
const vals = { "slider:slider_rx": { v: -35, min: -80, max: 10 }, "slider:slider_tv": { v: 23, min: 0, max: 100 }, "control": { v: 40 } };
let ctlOn = false;
const pushed = [];
const eng = new Displays({ file: path.join(dir, "displays.json"), now: () => t, value: (src) => vals[src.ent], controlOn: () => ctlOn, publish: (id, a) => pushed.push([id, a.value]) });
eng.replace(validateDisplays(good).displays);
const last = () => pushed[pushed.length - 1][1];
ok(last() === "🔊 −35.0 dB", "default shown: " + last());
t += 250; eng.tick();
ok(pushed.length === 1, "nothing pushed when the text didn't change");
vals["slider:slider_tv"].v = 24; t += 250; eng.tick();
ok(last() === "📺 🟩⬜⬜⬜⬜ 24 %", "a change switches the display: " + last());
t += 4100; eng.tick();
ok(last() === "🔊 −35.0 dB", "back to the default after 4 s");
ctlOn = true; t += 250; eng.tick();
ok(last() === "💡 40 %", "a Control on takes over");
vals["slider:slider_tv"].v = 30; t += 250; eng.tick();
ok(last() === "💡 40 %", "a normal change waits while a high-priority one shows");
vals.control.v = 50; t += 250; eng.tick();
ok(last() === "💡 50 %", "the Control's value updates live");
ctlOn = false; t += 250; eng.tick();
ok(last() === "🔊 −35.0 dB", "Control off: back to the default");
vals["slider:slider_rx"].v = -5; t += 250; eng.tick();
ok(last() === "Careful", "above −10: messages");
t += 1000; eng.tick();
ok(last() === "Loud!", "next message after 1 s");
t += 1000; eng.tick();
ok(last() === "Careful", "messages over and over while it's true");
vals["slider:slider_rx"].v = -20; t += 250; eng.tick();
ok(last() === "🔊 −20.0 dB", "no longer above: default again");
eng.activityStarted("uc.main.watch");
ok(last() === "Starting…", "an activity started: its messages");
t += 1000; eng.tick(); ok(last() === "Enjoy!", "second message");
t += 2100; eng.tick(); ok(last() === "🔊 −20.0 dB", "once through, then the default");
// a condition still true shows when another change ends
vals["slider:slider_rx"].v = 0; t += 250; eng.tick();
ok(last() === "Careful", "loud again");
eng.showMessages("disp_volume", ["Ding dong", "at the door"], 1);
ok(last() === "Ding dong", "smart control messages, high priority");
t += 2100; eng.tick();
ok(last() === "Careful" || last() === "Loud!", "after the messages, the condition still true shows again: " + last());
ok(fs.existsSync(path.join(dir, "displays.json")) && new Displays({ file: path.join(dir, "displays.json"), value: () => null, publish: () => {} }).displays.length === 1, "saved and loaded again");
let threw = false; try { eng.showMessages("disp_nope", ["x"]); } catch { threw = true; }
ok(threw, "unknown display refused");

console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
