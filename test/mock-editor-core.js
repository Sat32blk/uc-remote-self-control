// A fake remote Core API with enough of everything for the Page Editor: activities with pages, keys and
// sequences, macros, activity groups, home screen, pictures, integrations. Placeholder ids only.
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";

const clone = (x) => JSON.parse(JSON.stringify(x));
export const calls = []; // every write: { m, p, b }

export const TV = "tvdrv.main.media_player.TV1", ROKU = "rokudrv.main.ROKU1", AVR = "avrdrv.main.media_player.AVR1", SUB = "hass.main.switch.subwoofer";
export const LAMP = "hass.main.light.lamp", TEMP = "hass.main.sensor.temp", APPS = "tvdrv.main.select.TV1.apps", IR = "uc.main.ir-receiver";
export function makeState() {
  const st = {
    entities: [
      { entity_id: TV, entity_type: "media_player", integration_id: "tvdrv.main", name: { en: "Living Room TV" }, features: ["on_off", "volume", "volume_up_down", "mute_toggle", "select_source", "home", "dpad"], attributes: { state: "ON", source_list: ["HDMI 1", "HDMI 2", "HDMI 3"], volume: 12 } },
      { entity_id: ROKU, entity_type: "media_player", integration_id: "rokudrv.main", name: { en: "Living Room Roku" }, features: ["on_off", "play_pause", "home", "back", "dpad", "select_source"], attributes: { state: "PLAYING", source_list: ["Netflix", "YouTube", "Hulu"] } },
      { entity_id: AVR, entity_type: "media_player", integration_id: "avrdrv.main", name: { en: "Marantz Receiver" }, features: ["on_off", "volume", "volume_up_down", "mute_toggle", "select_source"], attributes: { state: "OFF", source_list: ["SHIELD", "MEDIA PLAYER", "TV AUDIO"] } },
      { entity_id: SUB, entity_type: "switch", integration_id: "hass.main", name: { en: "Living Room Subwoofer" }, features: ["on_off", "toggle"], attributes: { state: "OFF" } },
      { entity_id: LAMP, entity_type: "light", integration_id: "hass.main", name: { en: "Table Lamp" }, features: ["on_off", "toggle", "dim"], attributes: { state: "UNAVAILABLE" } },
      { entity_id: TEMP, entity_type: "sensor", integration_id: "hass.main", name: { en: "Living Room Temperature" }, features: [], attributes: { state: "ON", value: 71, unit: "°F" } },
      { entity_id: APPS, entity_type: "select", integration_id: "tvdrv.main", name: { en: "TV Apps" }, features: [], attributes: { state: "ON", options: ["Netflix", "Prime Video"], current_option: "Netflix" } },
      { entity_id: IR, entity_type: "remote", integration_id: "uc.main", name: { en: "Receiver IR" }, features: ["send_cmd"], options: { simple_commands: ["POWER_ON", "POWER_OFF", "INPUT_HDMI_1"] }, attributes: { state: "ON" } },
      { entity_id: "self_control.main.haptic", entity_type: "switch", integration_id: "self_control.main", name: { en: "Haptic" }, features: ["on_off"], attributes: { state: "ON" } }
    ],
    available: { "hass.main": [{ entity_id: "light.porch", entity_type: "light", integration_id: "hass.main", name: { en: "Porch Light" }, features: ["on_off"] },
      { entity_id: "hass.main.switch.fan", entity_type: "switch", integration_id: "hass.main", name: { en: "Bedroom Fan" }, features: ["on_off"] }] },
    intg: [
      { integration_id: "hass.main", driver_id: "hass", name: { en: "Home Assistant" }, enabled: true, device_state: "CONNECTED" },
      { integration_id: "tvdrv.main", driver_id: "tvdrv", name: { en: "TV" }, enabled: true, device_state: "CONNECTED" },
      { integration_id: "avrdrv.main", driver_id: "avrdrv", name: { en: "Receiver" }, enabled: true, device_state: "DISCONNECTED" }
    ],
    activities: {
      "uc.main.watch": { name: { en: "Watch Roku" }, state: "OFF", entity_ids: [TV, ROKU, LAMP],
        sequences: { on: [{ type: "command", command: { entity_id: TV, cmd_id: "media_player.on" } }, { type: "delay", delay: 1500 }, { type: "command", command: { entity_id: ROKU, cmd_id: "media_player.on" } }, { type: "command", command: { entity_id: TV, cmd_id: "media_player.select_source", params: { source: "HDMI 2" } } }],
          off: [{ type: "command", command: { entity_id: ROKU, cmd_id: "media_player.off" } }, { type: "command", command: { entity_id: TV, cmd_id: "media_player.off" } }] },
        buttons: [{ button: "HOME", short_press: { entity_id: ROKU, cmd_id: "media_player.home" } }, { button: "VOLUME_UP", short_press: { entity_id: TV, cmd_id: "media_player.volume_up" } }, { button: "POWER" }],
        options: { prevent_sleep: false, ready_check: true },
        pages: [
          { page_id: "pw1", name: "Main", grid: { width: 4, height: 6 }, items: [
            { type: "media_player", media_player_id: ROKU, location: { x: 0, y: 0 }, size: { width: 4, height: 2 } },
            { type: "text", text: "Home", location: { x: 0, y: 2 }, size: { width: 2, height: 1 }, command: { entity_id: ROKU, cmd_id: "media_player.home" } },
            { type: "icon", icon: "uc:light", location: { x: 3, y: 5 }, command: { entity_id: LAMP, cmd_id: "light.toggle" } }
          ] },
          { page_id: "pw2", name: "Apps", grid: { width: 4, height: 6 }, items: [
            { type: "icon", icon: "custom:netflix.png", location: { x: 0, y: 0 }, size: { width: 1, height: 1 }, command: { entity_id: ROKU, cmd_id: "media_player.select_source", params: { source: "Netflix" } } },
            { type: "icon", icon: "custom:lv_frame_3.png", location: { x: 1, y: 0 }, size: { width: 1, height: 1 }, command: { entity_id: TV, cmd_id: "media_player.volume", params: { volume: 37 } } }
          ] }
        ] },
      "uc.main.music": { name: { en: "Play Music" }, state: "OFF", entity_ids: [AVR], sequences: { on: [{ type: "command", command: { entity_id: AVR, cmd_id: "media_player.on" } }], off: [{ type: "command", command: { entity_id: AVR, cmd_id: "media_player.off" } }] }, buttons: [], options: {},
        pages: [{ page_id: "pm1", name: "Main", grid: { width: 4, height: 6 }, items: [] }] },
      "intg.main.locked": { name: { en: "Integration Activity" }, state: "OFF", editable: false, entity_ids: [], sequences: { on: [], off: [] }, buttons: [], options: {}, pages: [{ page_id: "pl1", name: "Main", grid: { width: 4, height: 6 }, items: [] }] }
    },
    macros: { "uc.main.m1": { name: { en: "Lights off" }, entity_ids: [LAMP], sequence: [{ type: "command", command: { entity_id: LAMP, cmd_id: "light.off" } }] } },
    groups: { g1: { name: { en: "Living room AV" }, activity_ids: ["uc.main.watch"], options: { turn_off_unused_entities: "run_off_sequence", remove_turn_on_delays: "previous_cmd_skipped" } } },
    profile: "prof1",
    homePages: [{ page_id: "hp1", name: { en: "Living room" }, pos: 1, items: [{ entity_id: "uc.main.watch", pos: 1 }, { group_id: "hg1", pos: 2 }] }],
    homeGroups: [{ group_id: "hg1", name: "Lights", entities: [LAMP] }],
    resources: { Icon: { "netflix.png": 1200, "youtube.png": 1300, "lv_frame_3.png": 900, "unused.png": 800 }, TvChannelIcon: {}, BackgroundImage: { "living-room-1.png": 50000 } },
    onScreen: null,
    seq: 1
  };
  return st;
}
export let S = makeState();
export function reset() { S = makeState(); calls.length = 0; }

// a plain coloured square per picture name (stands in for the real pictures)
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); }
const COLORS = { netflix: [229, 9, 20], youtube: [255, 0, 0], unused: [90, 90, 100], lv_frame: [34, 197, 94], "living-room": [120, 80, 40] };
function picture(id) {
  const key = Object.keys(COLORS).find((k) => id.startsWith(k));
  const [r, g, b] = key ? COLORS[key] : [55, 65, 81];
  const W = 48, row = Buffer.alloc(1 + W * 3);
  for (let x = 0; x < W; x++) { const edge = x < 4 || x >= W - 4; row[1 + x * 3] = edge ? 20 : r; row[2 + x * 3] = edge ? 20 : g; row[3 + x * 3] = edge ? 20 : b; }
  const raw = Buffer.concat(Array.from({ length: W }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const CMDS = [
  ...["on", "off", "toggle", "volume_up", "volume_down", "mute_toggle", "home", "back", "play_pause", "cursor_up", "cursor_enter"].map((c) => ({ id: "media_player." + c, cmd_id: c, name: { en: c } })),
  { id: "media_player.select_source", cmd_id: "select_source", name: { en: "Select source" }, params: [{ param: "source", type: "string" }] },
  { id: "media_player.volume", cmd_id: "volume", name: { en: "Volume" }, params: [{ param: "volume", type: "number", min: 0, max: 100 }] },
  ...["on", "off", "toggle"].map((c) => ({ id: "light." + c, cmd_id: c, name: { en: c }, params: c === "on" ? [{ param: "brightness", type: "number", min: 0, max: 255 }] : undefined })),
  ...["on", "off", "toggle"].map((c) => ({ id: "switch." + c, cmd_id: c, name: { en: c } })),
  { id: "select.select_option", cmd_id: "select_option", name: { en: "Select" }, params: [{ param: "option", type: "string" }] },
  ...["on", "off", "send_cmd"].map((c) => ({ id: "remote." + c, cmd_id: c, name: { en: c } })),
  { id: "activity.start", cmd_id: "start", name: { en: "start" } }, { id: "activity.off", cmd_id: "off", name: { en: "off" } },
  { id: "macro.run", cmd_id: "run", name: { en: "run" } }
];
function entityList() {
  const out = S.entities.map(clone);
  for (const [id, a] of Object.entries(S.activities)) out.push({ entity_id: id, entity_type: "activity", integration_id: "uc.main", name: a.name, features: ["on_off"], attributes: { state: a.state } });
  for (const [id, m] of Object.entries(S.macros)) out.push({ entity_id: id, entity_type: "macro", integration_id: "uc.main", name: m.name, features: ["run"], attributes: {} });
  return out;
}
const included = (ids) => ids.map((entity_id) => { const e = entityList().find((x) => x.entity_id === entity_id); return { entity_id, entity_type: e?.entity_type, name: e?.name, available: !!e }; });
function fullActivity(id) {
  const a = S.activities[id];
  return { entity_id: id, entity_type: "activity", name: a.name, attributes: { state: a.state },
    options: { editable: a.editable !== false, ...clone(a.options), included_entities: included(a.entity_ids), sequences: clone(a.sequences), button_mapping: clone(a.buttons), user_interface: { pages: clone(a.pages) },
      ...(Object.entries(S.groups).find(([, g]) => g.activity_ids.includes(id)) ? { activity_group: { group_id: Object.entries(S.groups).find(([, g]) => g.activity_ids.includes(id))[0] } } : {}) } };
}
function page(list, q) { const limit = Number(q.get("limit") || 100), p = Number(q.get("page") || 1); return list.slice((p - 1) * limit, p * limit); }

export function startMockEditorCore(port = 0) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x"), p = u.pathname.replace(/^\/api/, ""), q = u.searchParams, M = req.method;
      const raw = Buffer.concat(chunks);
      let body;
      if (/json/.test(req.headers["content-type"] || "")) try { body = JSON.parse(raw.toString() || "null"); } catch { body = null; }
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
      const bin = (type, buf, extra = {}) => { res.writeHead(200, { "Content-Type": type, ...extra }); res.end(buf); };
      // the web configurator's page, style sheet and icon font (public, like on the remote)
      if (u.pathname === "/configurator/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end('<html><head><link rel="stylesheet" crossorigin href="/configurator/assets/css/index-AbC123.css"></head><body></body></html>'); }
      if (u.pathname === "/configurator/assets/css/index-AbC123.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end('@font-face{font-family:Inter;src:url(../fonts/inter.woff2) format("woff2")}@font-face{font-family:"uc-icons";src:url(../fonts/uc-icons.woff2?v=2) format("woff2"),url(../fonts/uc-icons.ttf) format("truetype")}body{font-family:Inter}'); }
      if (u.pathname === "/configurator/assets/fonts/uc-icons.woff2") { res.writeHead(200, { "Content-Type": "font/woff2" }); return res.end(process.env.MOCK_ICON_FONT ? fs.readFileSync(process.env.MOCK_ICON_FONT) : Buffer.from("wOF2-fake-icon-font")); }
      if (!req.headers.authorization) return send(401, { message: "no auth" });
      if (/^Basic /.test(req.headers.authorization)) { const pin = Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":")[1]; if (pin !== "1234") return send(401, { message: "bad pin" }); }
      if (M !== "GET") calls.push({ m: M, p: p + (u.search || ""), b: body ?? (raw.length ? `<${raw.length} bytes>` : undefined) });
      let m;
      try {
        if (p === "/cfg/device" && M === "GET") return send(200, {});
        if (p === "/system") return send(200, { model_number: "ucr3-r3", model_name: "Remote 3" });
        if (p === "/cfg/device/button_layout") return send(200, { type: "keypad", grid: { width: 3, height: 9 }, buttons: [] });
        if (p === "/cfg/device/screen_layout") return send(200, { grid: { default: { width: 4, height: 6 }, min: { width: 1, height: 1 }, max: { width: 10, height: 12 } } });
        if (p === "/cfg/entity/commands") return send(200, CMDS);
        if (p === "/cfg/device/icon_mapping") return send(200, { home: "uE900", tv: "uE901", light: "uE902", play: "uE903", "hdmi-1": "uE904" });
        if (p === "/system/backup/export") return bin("application/zip", Buffer.from("PK-fake-backup"), { "Content-Disposition": 'attachment; filename="UCR3_backup.zip"' });
        // entities
        if (p === "/entities" && M === "GET") {
          return send(200, page(entityList(), q));
        }
        if ((m = /^\/entities\/([^/]+)\/command$/.exec(p)) && M === "PUT") return send(200, { message: "ok" });
        if ((m = /^\/entities\/([^/]+)$/.exec(p))) {
          const id = decodeURIComponent(m[1]); const i = S.entities.findIndex((e) => e.entity_id === id);
          if (M === "PATCH") { if (i < 0) return send(404, { message: "nf" }); if (body.name) S.entities[i].name = body.name; return send(200, S.entities[i]); }
          if (M === "DELETE") { if (i < 0) return send(404, { message: "nf" }); S.entities.splice(i, 1); return send(200, { message: "deleted" }); }
        }
        // activities
        if (p === "/activities" && M === "GET") return send(200, page(Object.entries(S.activities).map(([entity_id, a]) => ({ entity_id, name: a.name, attributes: { state: a.state } })), q));
        if (p === "/activities" && M === "POST") {
          const id = "uc.main.new" + S.seq++;
          if (body.clone_from) { const src = S.activities[body.clone_from]; S.activities[id] = { ...clone(src), name: body.name, editable: true, pages: src.pages.map((pg) => ({ ...clone(pg), page_id: "pc" + S.seq++ })) }; }
          else S.activities[id] = { name: body.name, state: "OFF", entity_ids: body.options?.entity_ids || [], sequences: { on: [], off: [] }, buttons: [], options: {}, pages: [] };
          return send(201, fullActivity(id));
        }
        if ((m = /^\/activities\/([^/]+)(.*)$/.exec(p))) {
          const id = decodeURIComponent(m[1]), rest = m[2], a = S.activities[id];
          if (!a) return send(404, { message: "no activity" });
          if (rest === "") {
            if (M === "GET") return send(200, fullActivity(id));
            if (M === "DELETE") { delete S.activities[id]; return send(200, { message: "deleted" }); }
            if (M === "PATCH") {
              if (a.editable === false) return send(403, { message: "not editable" });
              if (body.name) a.name = body.name;
              const o = body.options || {};
              if (o.entity_ids) a.entity_ids = o.entity_ids;
              if (o.sequences) {
                const used = [...(o.sequences.on || []), ...(o.sequences.off || [])].filter((s) => s.type === "command").map((s) => s.command.entity_id);
                const bad = used.filter((e) => !a.entity_ids.includes(e));
                if (bad.length) return send(400, { message: "entity not included: " + bad.join(",") });
                a.sequences = { ...a.sequences, ...o.sequences };
              }
              for (const k of ["prevent_sleep", "ready_check", "error_policy", "touch_slider", "voice_assistant"]) if (k in o) a.options[k] = o[k];
              return send(200, fullActivity(id));
            }
          }
          if (rest === "/ui/pages") {
            if (M === "GET") return send(200, clone(a.pages));
            if (M === "POST") { const pg = { page_id: "pn" + S.seq++, name: body.name, grid: body.grid || { width: 4, height: 6 }, items: body.items || [] }; a.pages.push(pg); return send(201, pg); }
            if (M === "PATCH") { const ord = body.page_order; if (!Array.isArray(ord) || ord.length !== a.pages.length) return send(400, { message: "page_order must list every page" }); a.pages = ord.map((x) => a.pages.find((pg) => pg.page_id === x)); return send(200, a.pages); }
          }
          if ((m = /^\/ui\/pages\/([^/]+)$/.exec(rest))) {
            const i = a.pages.findIndex((pg) => pg.page_id === m[1]);
            if (i < 0) return send(404, { message: "no page" });
            if (M === "GET") return send(200, a.pages[i]);
            if (M === "DELETE") { a.pages.splice(i, 1); return send(200, { message: "deleted" }); }
            if (M === "PATCH") { Object.assign(a.pages[i], body.name !== undefined ? { name: body.name } : {}, body.grid ? { grid: body.grid } : {}, body.items ? { items: body.items } : {}); return send(200, a.pages[i]); }
          }
          if ((m = /^\/buttons\/([A-Z0-9_]+)(\/(short_press|long_press))?$/.exec(rest))) {
            let b = a.buttons.find((x) => x.button === m[1]);
            if (!b) { b = { button: m[1] }; a.buttons.push(b); }
            if (M === "PATCH") { Object.assign(b, body); return send(200, b); }
            if (M === "DELETE" && m[3]) { delete b[m[3]]; return send(200, { message: "ok" }); }
          }
          if (rest === "/readiness") return send(200, {});
        }
        // macros
        if (p === "/macros" && M === "GET") return send(200, page(Object.entries(S.macros).map(([entity_id, x]) => ({ entity_id, name: x.name })), q));
        if (p === "/macros" && M === "POST") { const id = "uc.main.mac" + S.seq++; S.macros[id] = { name: body.name, entity_ids: body.options?.entity_ids || [], sequence: [] }; return send(201, { entity_id: id, name: body.name }); }
        if ((m = /^\/macros\/([^/]+)$/.exec(p))) {
          const id = decodeURIComponent(m[1]), x = S.macros[id];
          if (!x) return send(404, { message: "no macro" });
          if (M === "GET") return send(200, { entity_id: id, entity_type: "macro", name: x.name, options: { editable: true, included_entities: included(x.entity_ids), sequence: clone(x.sequence) } });
          if (M === "PATCH") { if (body.name) x.name = body.name; if (body.options?.entity_ids) x.entity_ids = body.options.entity_ids; if (body.options?.sequence) x.sequence = body.options.sequence; return send(200, {}); }
          if (M === "DELETE") { delete S.macros[id]; return send(200, {}); }
        }
        // activity groups
        if (p === "/activity_groups" && M === "GET") return send(200, page(Object.entries(S.groups).map(([group_id, g]) => ({ group_id, name: g.name, activity_count: g.activity_ids.length })), q));
        if (p === "/activity_groups" && M === "POST") { const id = "g" + S.seq++; S.groups[id] = { name: body.name, activity_ids: body.activity_ids || [], options: body.options || {} }; return send(201, { group_id: id }); }
        if ((m = /^\/activity_groups\/([^/]+)$/.exec(p))) {
          const id = decodeURIComponent(m[1]), g = S.groups[id];
          if (!g) return send(404, { message: "no group" });
          if (M === "GET") return send(200, { group_id: id, name: g.name, options: g.options, activities: g.activity_ids.map((entity_id) => ({ entity_id, name: S.activities[entity_id]?.name })) });
          if (M === "PATCH") {
            if (body.activity_ids) { for (const a of body.activity_ids) for (const [oid, o] of Object.entries(S.groups)) if (oid !== id && o.activity_ids.includes(a)) return send(409, { message: "activity already in another group" }); g.activity_ids = body.activity_ids; }
            if (body.name) g.name = body.name; if (body.options) g.options = body.options; return send(200, {});
          }
          if (M === "DELETE") { delete S.groups[id]; return send(200, {}); }
        }
        // home screen
        if (p === "/profiles") return send(200, [{ profile_id: S.profile, name: "Main", restricted: false }]);
        if (p === `/profiles/${S.profile}/pages` && M === "GET") return send(200, clone(S.homePages));
        if (p === `/profiles/${S.profile}/pages` && M === "POST") { const pg = { page_id: "hp" + S.seq++, profile_id: S.profile, name: body.name, image: body.image, items: body.items || [], pos: S.homePages.length + 1 }; S.homePages.push(pg); return send(201, pg); }
        if (p === `/profiles/${S.profile}/groups`) return send(200, clone(S.homeGroups));
        if ((m = new RegExp(`^/profiles/${S.profile}/pages/([^/]+)$`).exec(p))) {
          const i = S.homePages.findIndex((x) => x.page_id === m[1]);
          if (i < 0) return send(404, { message: "nf" });
          if (M === "PATCH") { if (body.image !== undefined && body.image !== "" && !/^custom:/.test(body.image)) return send(400, { message: "bad image" }); Object.assign(S.homePages[i], body); return send(200, S.homePages[i]); }
          if (M === "DELETE") { S.homePages.splice(i, 1); return send(200, {}); }
        }
        // pictures
        if ((m = /^\/resources\/(Icon|TvChannelIcon|BackgroundImage)$/.exec(p))) {
          const r = S.resources[m[1]];
          if (M === "GET") return send(200, page(Object.entries(r).map(([id, size]) => ({ type: m[1], id, size })), q));
          if (M === "POST") {
            const name = (/filename="([^"]+)"/.exec(raw.toString("latin1")) || [])[1] || "upload.png";
            if (r[name]) return send(422, { message: "exists" });
            r[name] = raw.length; return send(201, [{ type: m[1], id: name, size: raw.length }]);
          }
        }
        if ((m = /^\/resources\/(Icon|TvChannelIcon|BackgroundImage)\/(.+)$/.exec(p))) {
          const r = S.resources[m[1]], id = decodeURIComponent(m[2]);
          if (!(id in r)) return send(404, { message: "no picture" });
          if (M === "GET") return bin("image/png", picture(id));
          if (M === "DELETE") { delete r[id]; return send(200, {}); }
        }
        // integrations
        if (p === "/intg/instances" && M === "GET") return send(200, clone(S.intg));
        if ((m = /^\/intg\/instances\/([^/]+)$/.exec(p))) {
          const i = S.intg.find((x) => x.integration_id === m[1]);
          if (!i) return send(404, { message: "nf" });
          if (M === "PATCH") { if ("enabled" in body) i.enabled = body.enabled; return send(200, i); }
          if (M === "PUT") { i.device_state = "CONNECTED"; return send(200, { message: "ok" }); }
        }
        if ((m = /^\/intg\/instances\/([^/]+)\/entities$/.exec(p))) {
          const list = S.available[m[1]] || [];
          if (M === "GET") return send(200, page(list, q));
          if (M === "POST") {
            for (const id of body) {
              const k = list.findIndex((e) => e.entity_id === id || e.entity_id === `${m[1]}.${id}`);
              if (k < 0) return send(400, { message: "unknown entity " + id });
              const e = list.splice(k, 1)[0];
              S.entities.push({ ...e, entity_id: e.entity_id.startsWith(m[1] + ".") ? e.entity_id : `${m[1]}.${e.entity_id}`, attributes: { state: "OFF" } });
            }
            return send(201, body);
          }
        }
        send(404, { message: `mock: no ${M} ${p}` });
      } catch (e) {
        send(500, { message: e.message });
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
