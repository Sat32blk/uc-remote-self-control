// Page Editor support: the Core pass-through only lets through what the editor needs, pictures are
// checked before they reach the remote, and a full remote backup is kept before the first change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCoreCall } from "../src/bin/editor.js";
import { startWebServer } from "../src/bin/web.js";
import { CoreClient } from "../src/bin/core.js";
import { startMockEditorCore, calls } from "./mock-editor-core.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// --- the allow list
const allowed = [["GET", "/activities?limit=100&page=1"], ["PATCH", "/activities/uc.main.x/ui/pages/p1"], ["DELETE", "/activities/uc.main.x/buttons/MUTE/short_press"], ["PATCH", "/activities/uc.main.x/ui/pages"],
  ["POST", "/macros"], ["DELETE", "/macros/uc.main.m"], ["PATCH", "/activity_groups/g1"], ["PATCH", "/profiles/p/pages/h1"], ["GET", "/resources/Icon?limit=100&page=1"], ["DELETE", "/resources/Icon/a.png"],
  ["DELETE", "/entities/hass.main.light.x"], ["PUT", "/entities/uc.main.m/command"], ["POST", "/intg/instances/hass.main/entities"], ["PUT", "/intg/instances/hass.main?cmd=CONNECT"], ["GET", "/system"], ["GET", "/cfg/device/screen_layout"], ["GET", "/intg/drivers/intg_manager_driver"]];
for (const [m, p] of allowed) ok(checkCoreCall(m, p) === null, `allowed: ${m} ${p}`);
const refused = [["DELETE", "/activities"], ["DELETE", "/entities"], ["DELETE", "/resources/Icon"], ["DELETE", "/macros"], ["POST", "/system"], ["GET", "/system/backup/export"], ["PUT", "/system/power"],
  ["POST", "/auth/api_keys"], ["GET", "/auth/api_keys"], ["PATCH", "/cfg/device"], ["GET", "/activities/../auth/api_keys"], ["GET", "/activities//x"], ["POST", "/resources/Icon"], ["DELETE", "/intg/instances"],
  ["GET", "/activities?x=<script>"], ["TRACE", "/activities"], ["GET", "activities"], ["DELETE", "/intg/drivers/intg_manager_driver"], ["PATCH", "/intg/drivers/x"]];
for (const [m, p] of refused) ok(checkCoreCall(m, p) !== null, `refused: ${m} ${p}`);

// --- over HTTP, with a fake remote
const mock = await startMockEditorCore(0);
const addr = "127.0.0.1:" + mock.address().port;
const core = new CoreClient(addr, { apiKey: "k" });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-editor-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const srv = startWebServer({ port, pagePath: new URL("../src/bin/web/builder.html", import.meta.url).pathname, editorPath: new URL("../src/bin/web/editor.html", import.meta.url).pathname, dataDir,
  getCore: () => core, makePinClient: (pin) => new CoreClient(addr, { pin }), smart: () => null, controls: () => ({}), settings: {}, loadRulesText: () => ({ text: "{}" }), defaultRulesText: () => "{}",
  saveRules: () => {}, validate: () => [], stateIcons: () => ({}), validateIcons: () => ({ errors: [] }), extras: () => ({}), controlsApi: {}, deviceStates: () => ({}), validateExtras: () => ({ errors: [] }),
  returnSettings: async () => ({}), saveReturn: async () => [], onScreen: () => "uc.main.watch", version: "test", log: () => {}, warn: () => {} });
await new Promise((r) => setTimeout(r, 300));
const base = `http://127.0.0.1:${port}`;
let cookie = "";
const req = async (method, p, body, raw) => {
  const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) };
};
ok((await req("POST", "/api/core", { method: "GET", path: "/activities" })).status === 401, "pass-through needs the builder login");
ok((await req("GET", "/editor", undefined, true)).status === 401, "editor page needs the login");
const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
ok(!!cookie, "logged in");
const ed = await req("GET", "/editor", undefined, true);
ok(ed.status === 200 && ed.headers.get("x-frame-options") === "SAMEORIGIN" && ed.body.toString().includes("Page Editor"), "editor page served, framable by the builder only");
let r = await req("POST", "/api/core", { method: "GET", path: "/activities?limit=100&page=1" });
ok(r.status === 200 && Array.isArray(r.body.data) && r.body.data.length === 3, "GET activities through the pass-through");
r = await req("POST", "/api/core", { method: "DELETE", path: "/activities" });
ok(r.status === 403, "deleting all activities refused");
r = await req("POST", "/api/core", { method: "GET", path: "/auth/api_keys" });
ok(r.status === 403, "API keys out of reach");
r = await req("POST", "/api/core", { method: "PATCH", path: "/activities/uc.main.watch/ui/pages/nope", body: { name: "x" } });
ok(r.status === 404 && /no page/.test(r.body.error), "the remote's own error comes back as it is");
r = await req("POST", "/api/core", { method: "PATCH", path: "/activities/uc.main.watch", body: { name: { en: "Renamed" } } });
ok(r.status === 200 && calls.some((c) => c.m === "PATCH" && c.p === "/activities/uc.main.watch" && c.b.name.en === "Renamed"), "PATCH reaches the remote");
// catalog and state
r = await req("GET", "/api/editor/catalog");
ok(r.status === 200 && r.body.model === "ucr3-r3" && r.body.devices.some((d) => d.id === "self_control.main.haptic") && r.body.devices.some((d) => d.type === "activity"), "catalog: the integration's own entities and activities included, model read");
ok(r.body.devices.find((d) => d.type === "remote")?.simple.includes("POWER_ON"), "catalog: simple commands");
r = await req("GET", "/api/editor/state");
ok(r.body.onScreen === "uc.main.watch", "on-screen activity reported");
// pictures
r = await req("GET", "/api/core/image?type=Icon&id=netflix.png", undefined, true);
ok(r.status === 200 && r.body.readUInt32BE(0) === 0x89504e47, "picture download");
ok((await req("GET", "/api/core/image?type=Secret&id=a.png", undefined, true)).status === 400, "unknown picture type refused");
ok((await req("GET", "/api/core/image?type=Icon&id=../x", undefined, true)).status === 400, "odd picture id refused");
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(100)]).toString("base64");
r = await req("POST", "/api/core/upload", { type: "Icon", name: "my pic.png", data: png });
ok(r.status === 400, "file name with a space refused");
r = await req("POST", "/api/core/upload", { type: "Icon", name: "a.png", data: Buffer.from("hello").toString("base64") });
ok(r.status === 400, "not a picture refused");
r = await req("POST", "/api/core/upload", { type: "Icon", name: "big.png", data: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40 * 1024)]).toString("base64") });
ok(r.status === 413, "icon over 32 KB refused");
r = await req("POST", "/api/core/upload", { type: "BackgroundImage", name: "room.jpg", data: Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(200 * 1024)]).toString("base64") });
ok(r.status === 200 && r.body.id === "room.jpg", "background (JPEG, 200 KB) uploaded");
r = await req("POST", "/api/core/upload", { type: "Icon", name: "new_icon.png", data: png });
ok(r.status === 200 && r.body.id === "new_icon.png", "icon uploaded");
r = await req("POST", "/api/core/upload", { type: "Icon", name: "new_icon.png", data: png });
ok(r.status === 200 && r.body.id === "new_icon.png", "same name again: the remote's copy is used");
// the remote's built-in icon font, found in its web configurator
r = await req("GET", "/api/editor/iconfont", undefined, true);
ok(r.status === 200 && r.body.toString() === "wOF2-fake-icon-font" && r.headers.get("content-type") === "font/woff2", "built-in icon font found through the web configurator's style sheet (not the text font)");
ok((await req("POST", "/api/core", { method: "GET", path: "/cfg/device/icon_mapping" })).body.data.home === "uE900", "icon names readable");
// backups
r = await req("GET", "/api/core/backup/latest", undefined, true);
ok(r.status === 404, "no backup yet");
r = await req("POST", "/api/core/backup", {});
ok(r.status === 200 && r.body.ok && !r.body.reused && /\.zip$/.test(r.body.name), "full remote backup made");
r = await req("POST", "/api/core/backup", {});
ok(r.status === 200 && r.body.reused, "a second one within 30 minutes isn't needed");
for (let i = 0; i < 3; i++) { await new Promise((x) => setTimeout(x, 1100)); await req("POST", "/api/core/backup", { force: true }); }
const kept = fs.readdirSync(path.join(dataDir, "remote-backups"));
ok(kept.length === 2, `only the newest two backups are kept (${kept.length})`);
r = await req("GET", "/api/core/backup/latest", undefined, true);
ok(r.status === 200 && r.body.toString() === "PK-fake-backup" && /attachment/.test(r.headers.get("content-disposition")), "newest backup downloads");

srv.close(); mock.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
