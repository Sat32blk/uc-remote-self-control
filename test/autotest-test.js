// Auto Widget test entity: switching, hold, copying, buttons and browsing through the core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoTest } from "../src/bin/autotest.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"));
let t = 1000;
const sent = [], cmds = [], gets = [];
const ent = {
  "x.atv": { attributes: { state: "PLAYING", source: "Max", media_title: "Max", media_image_url: "data:image/png;base64,AAAA" } },
  "x.plex": { attributes: { state: "OFF", media_title: "", media_image_url: "data:image/jpeg;base64,BBBB" } }
};
const core = {
  get: async (p) => { gets.push(p); const id = decodeURI(p.split("/")[2]); return ent[id]; },
  request: async (m, p, body) => { cmds.push([p, body]); if (body.cmd_id === "media_player.bad") { const e = new Error("HTTP 400"); e.status = 400; throw e; } },
  getPaged: async (p) => { gets.push(p); if (p.includes("/media/search")) return { data: [{ media_id: "m1", title: "Found" }], count: 1, limit: 10, page: 1 };
    return { data: { media: { media_id: "root", title: "Library", items: [{ media_id: "a", title: "Movies", can_browse: true }, { media_id: "b", title: "Shows", can_browse: true }] } }, count: 2, limit: 10, page: 1 }; }
};
const at = new AutoTest({ file: path.join(dir, "autotest.json"), publish: (a) => sent.push(a), getCore: () => core, now: () => t });
ok(!at.enabled, "off until two players are picked");
ok(!at.save({ a: "x.atv", b: "x.atv" }).ok, "the same player twice is refused");
ok(at.save({ a: "x.atv", b: "x.plex", attr: "source", value: "Plex", hold: 3 }).ok && at.enabled, "saved");
ok(JSON.parse(fs.readFileSync(path.join(dir, "autotest.json"), "utf8")).b === "x.plex", "settings kept in a file");
await at.read(true);
ok(at.shown === "a" && sent.at(-1).media_title === "Max" && sent.at(-1).state === "PLAYING", "shows A, with A's attributes");
const n = sent.length;
at.event("x.atv", { media_position: 5 }); at.event("x.atv", { media_position: 5 });
ok(sent.length === n + 1, "only changes are published");
// Plex opens on the Shield, then the Plex player turns on
t += 100; at.event("x.atv", { source: "Plex" });
ok(at.shown === "b" && sent.at(-1).state === "OFF", "A's source is Plex → shows B");
ok(at.status().log.some((l) => /switch → shows B .* after a event, \d+ ms after the event/.test(l.text)), "the switch is logged with its delay");
at.event("x.plex", { state: "PLAYING", media_title: "The Long Walk Home", media_position: 12, media_duration: 3000 });
ok(sent.at(-1).media_title === "The Long Walk Home" && sent.at(-1).media_duration === 3000, "B's playing details copied");
at.event("x.atv", { media_title: "Ignored" });
ok(sent.at(-1).media_title === "The Long Walk Home", "A's changes don't show while B shows");
// buttons go to the shown player
await at.command("play_pause");
ok(cmds.at(-1)[0] === "/entities/x.plex/command" && cmds.at(-1)[1].cmd_id === "media_player.play_pause", "a button goes to B with the media_player prefix");
await at.command("seek", { media_position: 60 });
ok(cmds.at(-1)[1].params.media_position === 60, "parameters passed on");
const bad = await at.command("bad");
ok(!bad.ok && bad.status === 400 && at.status().log[0].text.includes("FAILED"), "a refused button is logged");
// browsing and search through the core
const br = await at.browse({ paging: { page: 1, limit: 10 } });
ok(gets.at(-1).startsWith("/entities/x.plex/media/browse?") && br.media.items.length === 2 && br.pagination.count === 2, "browse asks B through the core and returns its items with paging");
await at.browse({ media_id: "a", media_type: "movies", paging: { page: 2, limit: 5 } });
ok(/media_id=a/.test(gets.at(-1)) && /media_type=movies/.test(gets.at(-1)) && /page=2/.test(gets.at(-1)) && /limit=5/.test(gets.at(-1)), "browse passes media_id, media_type and paging");
const sr = await at.search({ query: "walk", paging: { page: 1, limit: 10 } });
ok(/media\/search\?query=walk/.test(gets.at(-1)) && sr.media[0].title === "Found", "search passes the query");
// Plex closed: back to A after the hold
t += 100; at.event("x.atv", { source: "Netflix" });
ok(at.shown === "b", "still B during the hold");
t += 3100; at.tick();
ok(at.shown === "a", "back to A after 3 s");
await at.command("home");
ok(cmds.at(-1)[0] === "/entities/x.atv/command", "buttons go to A again");
await at.browse({ paging: { page: 1, limit: 10 } });
ok(gets.at(-1).startsWith("/entities/x.plex/media/browse"), "browsing still asks B while A shows (A can't browse)");

console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
