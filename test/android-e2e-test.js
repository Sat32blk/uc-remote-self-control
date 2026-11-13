// End-to-end: Android apps through the builder API, the integration's entity, browsing like the remote does.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start, icons, ownAdded, selfEntities } from "./mock-core.js";
import { startMockAdbd } from "./mock-adbd.js";

const CORE_PORT = 18086;
const WS_PORT = 19101;
const WEB = "http://127.0.0.1:10941";
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfctl-android-"));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let front = "com.google.android.tvlauncher";
const tv = await startMockAdbd({ approve: "manual", model: "SHIELD Android TV", shell: (c) => {
  if (c.startsWith("cmd package query-activities")) return "  com.netflix.ninja/.MainActivity\n  com.plexapp.android/com.plexapp.plex.Splash\n  org.xbmc.kodi/.Splash\n";
  if (c === "pm list packages -s") return "";
  if (c.startsWith("dumpsys activity")) return `  mResumedActivity: ActivityRecord{abc u0 ${front}/.X t1}\n`;
  if (c.startsWith("am start -n ")) { front = c.slice(12).split("/")[0]; return "Starting\n"; }
  return "";
} });
icons["netflix.png"] = "x"; icons["plex.png"] = "x";
// ---- driver -------------------------------------------------------------------------
const srv = await start(CORE_PORT);
const binDir = path.resolve("src/bin");
const ownDriverJson = !fs.existsSync(path.join(binDir, "driver.json")); // run-all.js puts one there for all tests running at once
if (ownDriverJson) fs.copyFileSync("src/driver.json", path.join(binDir, "driver.json"));
const drv = spawn(process.execPath, ["driver.js"], {
  cwd: binDir,
  env: { ...process.env, UC_CONFIG_HOME: cfgDir, UC_INTEGRATION_HTTP_PORT: String(WS_PORT), UC_DISABLE_MDNS_PUBLISH: "true", UC_SELF_BUILDER_PORT: "10941", UC_SELF_PUBLIC_URL: "http://127.0.0.1:10941" },
  stdio: ["ignore", "pipe", "pipe"]
});
let drvLog = "";
drv.stdout.on("data", (d) => (drvLog += d));
drv.stderr.on("data", (d) => (drvLog += d));
await sleep(1200);
const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
const events = [];
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.kind === "resp" && pending.has(m.req_id)) { pending.get(m.req_id)(m); pending.delete(m.req_id); }
  else if (m.kind === "event") events.push(m);
});
let rid = 1;
const req = (msg, msg_data) => new Promise((r) => { const id = rid++; pending.set(id, r); ws.send(JSON.stringify({ kind: "req", id, msg, msg_data })); });
await req("setup_driver", { reconfigure: false, setup_data: {} });
await sleep(300);
await req("set_driver_user_data", { input_values: { pin: "1234", address: `127.0.0.1:${CORE_PORT}` } });
await sleep(1200);
ws.send(JSON.stringify({ kind: "event", msg: "connect", cat: "DEVICE" }));
await sleep(500);

let cookie = "";
const http = async (method, url, body) => {
  const res = await fetch(WEB + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: res.status, data: await res.json() };
};
await http("POST", "/api/login", { pin: "1234" });
let h = await http("GET", "/api/android");
ok(h.status === 200 && h.data.devices.length === 0 && h.data.publicBase === "http://127.0.0.1:10941", "no Android devices yet");
h = await http("POST", "/api/android/add", { name: "SHIELD Theater", host: "127.0.0.1", port: tv.port });
const id = h.data.id;
ok(h.status === 200 && id === "shield_theater", "device added");
const conn = http("POST", "/api/android/connect", { id });
await sleep(500);
h = await http("GET", "/api/android");
ok(h.data.devices[0].status.state === "waiting", "the builder sees: waiting for Allow on the TV");
tv.state.approveNow();
h = await conn;
ok(h.status === 200 && h.data.status.state === "ok", "allowed: connected");
h = await http("POST", "/api/android/scan", { id });
ok(h.status === 200 && h.data.found === 3 && h.data.device.apps.find((a) => a.pkg === "com.netflix.ninja").pic === "netflix.png", "scan finds 3 apps and matches pictures from the remote's library");
h = await http("POST", "/api/android/apps", { id, apps: [{ pkg: "com.netflix.ninja", on: true, fav: true }, { pkg: "com.plexapp.android", on: true, folder: "Movies" }, { pkg: "org.xbmc.kodi", on: false }] });
ok(h.status === 200 && h.data.apps.filter((a) => a.on).length === 2, "picked 2 apps");
h = await http("POST", "/api/android/publish", { id });
ok(h.status === 200 && h.data.added && ownAdded.includes("aa_shield_theater") && h.data.entity === "self_control.main.aa_shield_theater", "added to the remote as one entity");

// the remote's side
let r = await req("get_available_entities");
const ent = r.msg_data.available_entities.find((e) => e.entity_id === "aa_shield_theater");
ok(ent && ent.entity_type === "media_player" && ent.features.includes("browse_media") && ent.features.includes("select_source") && ent.name.en === "SHIELD Theater apps", "the entity: a media player with browse and input list");
await req("subscribe_events", { entity_ids: ["aa_shield_theater"] });
await sleep(300);
const st = async () => Object.fromEntries((await req("get_entity_states")).msg_data.map((e) => [e.entity_id, e.attributes]))["aa_shield_theater"];
let a = await st();
ok(JSON.stringify(a.source_list) === JSON.stringify(["Netflix", "Plex"]), "its input list is the picked apps");
r = await req("entity_command", { entity_id: "aa_shield_theater", entity_type: "media_player", cmd_id: "select_source", params: { source: "Plex" } });
ok(r.code === 200 && tv.state.commands.some((c) => c.startsWith("am start -n com.plexapp.android/")), "select source · Plex opens Plex on the TV");
await sleep(200);
a = await st();
ok(a.media_title === "Plex" && a.media_image_url === "http://127.0.0.1:10941/aa/pic/shield_theater/com.plexapp.android", "the widget shows Plex with its picture link");
const img = await fetch(a.media_image_url);
ok(img.status === 200 && img.headers.get("content-type") === "image/png", "the picture link works without a login (the remote fetches it)");
r = await req("browse_media", { entity_id: "aa_shield_theater", paging: { page: 1, limit: 10 } });
const top = r.msg_data?.media;
ok(top && top.items.map((x) => x.title).join() === "Favorites,Recently used,All apps,Movies", "Browse: Favorites, Recently used, All apps, Movies " + JSON.stringify(r.msg_data).slice(0, 200));
r = await req("browse_media", { entity_id: "aa_shield_theater", media_id: "all", paging: { page: 1, limit: 10 } });
ok(r.msg_data?.media.items.length === 2 && r.msg_data.media.items[0].media_class === "app", "All apps lists the apps");
r = await req("entity_command", { entity_id: "aa_shield_theater", entity_type: "media_player", cmd_id: "play_media", params: { media_id: "app:com.netflix.ninja" } });
ok(r.code === 200 && front === "com.netflix.ninja", "tapping an app in Browse opens it");
r = await req("search_media", { entity_id: "aa_shield_theater", query: "ple", paging: { page: 1, limit: 10 } });
ok(JSON.stringify(r.msg_data || r).includes("Plex"), "search finds Plex");
r = await req("entity_command", { entity_id: "aa_shield_theater", entity_type: "media_player", cmd_id: "cursor_enter" });
ok(r.code === 200 && tv.state.commands.includes("input keyevent 23"), "OK key goes to the TV");

// restart: the entity is still offered
h = await http("POST", "/api/android/remove", { id });
r = await req("get_available_entities");
ok(h.status === 200 && !r.msg_data.available_entities.some((e) => e.entity_id === "aa_shield_theater"), "removing the device removes its entity");

drv.kill(); ws.terminate(); srv.close(); tv.server.close();
if (ownDriverJson) fs.rmSync(path.join(binDir, "driver.json"), { force: true });
if (failures) console.log(drvLog.split("\n").filter((l) => /android|aa_|error/i.test(l)).slice(-20).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
