// Fake remote Core REST API for local testing. Records every PATCH.
import http from "node:http";

const PIN = "1234";
const KEY = "test-api-key-abc";
export const patches = [];

export const cfg = {
  display: { brightness: 50, auto_brightness: true },
  sound: { enabled: true, volume: 80 },
  haptic: { enabled: true },
  power_saving: { wakeup_sensitivity: 2, display_off_sec: 15, standby_sec: 120 },
  button: { brightness: 100, static_color: { rgb: [127, 172, 255] }, auto_brightness: true, features: ["BACKLIGHT", "RGB_COLOR", "ZONES"] },
  network: { bt_enabled: true, wifi_enabled: true, wifi: { wake_on_wlan: { enabled: true }, bands: ["a", "b"], band: "a" }, wake_on_wlan: { enabled: true } }
};

// Fake media players (ids as on the user's remote).
export const SHIELD = "uc_androidtv_driver.main.YOUR_SHIELD_ID";
export const TV = "samsungtv_driver.main.media_player.YOUR_TV_ID";
export const MARANTZ = "uc_denon_driver.main.media_player.YOUR_RECEIVER_ID";
export const devices = {
  [SHIELD]: { state: "PLAYING", source: "YouTube" },
  [TV]: { state: "ON", source: "HDMI2", volume: 10 },
  [MARANTZ]: { state: "OFF", source: "SHIELD", volume: 24, sound_mode: "STEREO" }
};
export const commands = []; // {entity, cmd_id, params}

// This integration's entities that are "added to the integration" on the fake remote.
export const selfEntities = { haptic: "Haptic", smart_last_result: "Smart Controls: Last Result", smart_test_button: "Smart Test Button" };

// Activities with included entities and UI pages.
export const activities = {
  "uc.main.act1": { name: { en: "Watch TV" }, state: "OFF", entity_ids: [TV], buttons: { BACK: { short_press: { entity_id: TV, cmd_id: "media_player.back" } }, RECORD: {} }, pages: [{ page_id: "p1", name: "Main", grid: { width: 4, height: 6 }, items: [
    { type: "icon", icon: "uc:tv", location: { x: 0, y: 0 }, size: { width: 1, height: 1 }, command: { entity_id: TV, cmd_id: "media_player.toggle" } },
    { type: "text", text: "Receiver", location: { x: 1, y: 0 }, size: { width: 2, height: 1 } }
  ] }] },
  "uc.main.act2": { name: { en: "Play Music" }, state: "OFF", entity_ids: [MARANTZ], buttons: { BACK: {}, RECORD: {} }, pages: [{ page_id: "p2", name: "Main", grid: { width: 4, height: 1 }, items: [{ type: "text", text: "Full", location: { x: 0, y: 0 }, size: { width: 4, height: 1 } }] }] },
  "uc.main.ro": { name: { en: "Integration Activity" }, editable: false, entity_ids: [], pages: [] }
};
let pageSeq = 100;
export const icons = {}; // uploaded icon id -> raw body
export const groups = [
  { group_id: "g_av", name: { en: "Living room AV" }, activity_ids: [], options: { turn_off_unused_entities: "run_off_sequence" } },
  { group_id: "g_other", name: { en: "Bedroom" }, activity_ids: ["uc.main.ro"], options: { turn_off_unused_entities: "always" } }
];
export const entityIcons = {}; // entity id -> icon set with PATCH /entities/{id}

// Command metadata as GET /cfg/entity/commands returns it (subset).
const mpCmd = (c, params) => ({ id: "media_player." + c, cmd_id: c, name: { en: c.replace(/_/g, " ") }, params });
const ENTITY_COMMANDS = [
  ...["on", "off", "toggle", "volume_up", "volume_down", "play_pause", "mute_toggle"].map((c) => mpCmd(c)),
  mpCmd("select_source", [{ param: "source", type: "string", name: { en: "Source" } }]),
  mpCmd("select_sound_mode", [{ param: "mode", type: "string", name: { en: "Sound mode" } }]),
  mpCmd("volume", [{ param: "volume", type: "number", min: 0, max: 100, name: { en: "Volume" } }]),
  { id: "activity.on", cmd_id: "on", name: { en: "Start" } }, { id: "activity.off", cmd_id: "off", name: { en: "Stop" } }
];
const FEATURES = {
  [SHIELD]: ["on_off", "play_pause", "volume_up_down", "select_source"],
  [TV]: ["on_off", "volume_up_down", "mute_toggle", "select_source"],
  [MARANTZ]: ["on_off", "volume", "volume_up_down", "select_source", "select_sound_mode"]
};
const NAMES = { [SHIELD]: "SHIELD", [TV]: "Living Room TV", [MARANTZ]: "Marantz" };
function entityList() {
  const list = Object.keys(devices).map((id) => ({
    entity_id: id, entity_type: "media_player", integration_id: id.split(".").slice(0, 2).join("."), name: { en: NAMES[id] }, features: FEATURES[id],
    attributes: { ...devices[id], source_list: ["HDMI1", "HDMI2", "SHIELD"], ...(id === MARANTZ ? { sound_mode_list: ["STEREO", "MOVIE", "MUSIC"] } : {}) },
    options: id === MARANTZ ? { simple_commands: ["DIMMER"] } : {}
  }));
  for (const [id, a] of Object.entries(activities)) if (a.editable !== false) list.push({ entity_id: id, entity_type: "activity", integration_id: "uc.main", name: a.name, attributes: { state: a.state || "OFF" } });
  for (const [k, n] of Object.entries(selfEntities)) list.push({ entity_id: "self_control.main." + k, entity_type: k.startsWith("smart_last") ? "sensor" : k.startsWith("smart_") ? "button" : "switch", integration_id: "self_control.main", name: { en: n }, attributes: { state: "ON" } });
  return list;
}
export const options = { marantzBootMs: 300 }; // how long the receiver takes to report ON

function deviceCommand(id, cmd, params = {}) {
  const d = devices[id];
  const c = cmd.replace(/^media_player\./, "");
  switch (c) {
    case "on":
      if (id === MARANTZ && d.state === "OFF") setTimeout(() => (d.state = "ON"), options.marantzBootMs);
      else if (d.state === "OFF") d.state = "ON";
      break;
    case "off":
      d.state = "OFF";
      break;
    case "play_pause":
      d.state = d.state === "PLAYING" ? "PAUSED" : "PLAYING";
      break;
    case "volume":
      d.volume = Number(params.volume);
      break;
    case "volume_up":
      d.volume += 1;
      break;
    case "volume_down":
      d.volume -= 1;
      break;
    case "select_source":
      if (d.state === "OFF") return 409;
      d.source = params.source;
      break;
    case "select_sound_mode":
      if (d.state === "OFF") return 409;
      d.sound_mode = params.mode;
      break;
    default:
      return 400;
  }
  return 200;
}

function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === "object" && !Array.isArray(v) && t[k] && typeof t[k] === "object") deepMerge(t[k], v);
    else t[k] = v;
  }
}

export function start(port) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      const auth = req.headers.authorization || "";
      const url = req.url;
      if (url === "/api/pub/version") return send(200, { api: "0.19.0", core: "0.81.2" });
      if (url === "/api/auth/api_keys" && req.method === "POST") {
        if (auth !== "Basic " + Buffer.from("web-configurator:" + PIN).toString("base64")) return send(401, { code: "UNAUTHORIZED" });
        const b = JSON.parse(body);
        if (!b.name || !b.scopes) return send(400, { message: "name/scopes missing" });
        return send(201, { name: b.name, api_key: KEY, active: true, scopes: b.scopes });
      }
      const pinAuth = auth === "Basic " + Buffer.from("web-configurator:" + PIN).toString("base64");
      if (url === "/api/cfg/device" && req.method === "GET") {
        if (!pinAuth && auth !== "Bearer " + KEY) return send(401, { code: "UNAUTHORIZED" });
        return send(200, { name: "Test Remote" });
      }
      if (auth !== "Bearer " + KEY) return send(401, { code: "UNAUTHORIZED" });
      if (url === "/api/cfg" && req.method === "GET") return send(200, cfg);
      if (url === "/api/system/power/battery" && req.method === "GET") return send(200, { capacity: 55, power_supply: true, status: "CHARGING" });
      if (url === "/api/cfg/entity/commands" && req.method === "GET") return send(200, ENTITY_COMMANDS);
      if (url === "/api/resources/Icon" && req.method === "POST") {
        if (!/^multipart\/form-data/.test(req.headers["content-type"] || "")) return send(400, { message: "multipart expected" });
        const fn = /filename="([^"]+)"/.exec(body);
        if (!fn) return send(400, { message: "no file" });
        const id = fn[1].replace(/ /g, "_");
        if (icons[id]) return send(422, { message: "exists" });
        icons[id] = body;
        return send(201, [{ type: "Icon", id, size: body.length }]);
      }
      const ri = /^\/api\/resources\/Icon\/([^/?]+)$/.exec(url);
      if (ri && req.method === "GET") {
        const id = decodeURIComponent(ri[1]);
        if (!icons[id]) return send(404, { message: "no icon" });
        res.writeHead(200, { "Content-Type": "image/png" });
        // a real (green 2x2) PNG so builder thumbnails render
        return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mPU2tDwn4GBgYEJxmBkZAQAI48DP5/3hu8AAAAASUVORK5CYII=", "base64"));
      }
      const gm = /^\/api\/activity_groups(?:\/([^/?]+))?(?:\?(.*))?$/.exec(url);
      if (gm && req.method === "GET" && !gm[1]) {
        const q = new URLSearchParams(gm[2] || "");
        const limit = Number(q.get("limit") || 10), page = Number(q.get("page") || 1);
        // like the real core: the list is an overview without members or options
        return send(200, groups.slice((page - 1) * limit, page * limit).map((g) => ({ group_id: g.group_id, name: g.name, activity_count: g.activity_ids.length })));
      }
      const groupDetail = (g) => ({ group_id: g.group_id, name: g.name, options: g.options, activities: g.activity_ids.map((entity_id) => ({ entity_id, name: activities[entity_id]?.name || { en: entity_id } })) });
      if (gm && req.method === "GET" && gm[1]) {
        const g = groups.find((x) => x.group_id === decodeURIComponent(gm[1]));
        return g ? send(200, groupDetail(g)) : send(404, { message: "no group" });
      }
      if (gm && req.method === "PATCH" && gm[1]) {
        const g = groups.find((x) => x.group_id === decodeURIComponent(gm[1]));
        if (!g) return send(404, { message: "no group" });
        const b = JSON.parse(body);
        if (b.activity_ids) {
          const missing = b.activity_ids.filter((id) => !activities[id]);
          if (missing.length) return send(400, { code: "BAD_REQUEST", message: "Activity not found: " + missing.join(", ") });
          g.activity_ids = b.activity_ids;
        }
        return send(200, groupDetail(g));
      }
      const am = /^\/api\/activities(?:\?(.*))?$/.exec(url);
      if (am && req.method === "GET") {
        const q = new URLSearchParams(am[1] || "");
        const limit = Number(q.get("limit") || 10), page = Number(q.get("page") || 1);
        const list = Object.entries(activities).map(([id, a]) => ({ entity_id: id, entity_type: "activity", name: a.name, attributes: { state: a.state || "OFF" }, options: a.editable === false ? { editable: false } : {} }));
        return send(200, list.slice((page - 1) * limit, page * limit));
      }
      const abd = /^\/api\/activities\/([^/?]+)\/buttons\/([A-Z0-9_]+)\/(short_press|long_press)$/.exec(url);
      if (abd && req.method === "DELETE") {
        const act = activities[decodeURIComponent(abd[1])];
        if (!act) return send(404, { message: "no activity" });
        if (act.buttons[abd[2]]) delete act.buttons[abd[2]][abd[3]];
        return send(200, {});
      }
      const ab = /^\/api\/activities\/([^/?]+)\/buttons(?:\/([A-Z0-9_]+))?$/.exec(url);
      if (ab) {
        const act = activities[decodeURIComponent(ab[1])];
        if (!act) return send(404, { message: "no activity" });
        if (!ab[2] && req.method === "GET") return send(200, Object.entries(act.buttons || {}).map(([button, m]) => ({ button, ...m })));
        if (ab[2] && req.method === "PATCH") {
          const b = JSON.parse(body);
          const cmd = b.short_press || b.long_press;
          if (cmd?.entity_id && !act.entity_ids.includes(cmd.entity_id)) return send(400, { message: "entity not included: " + cmd.entity_id });
          act.buttons[ab[2]] = { ...(act.buttons[ab[2]] || {}), ...b };
          return send(200, { button: ab[2], ...act.buttons[ab[2]] });
        }
      }
      const a1 = /^\/api\/activities\/([^/?]+)(\/ui\/pages(?:\/([^/?]+))?)?$/.exec(url);
      if (a1) {
        const act = activities[decodeURIComponent(a1[1])];
        if (!act) return send(404, { message: "no activity" });
        const b = body ? JSON.parse(body) : {};
        if (!a1[2] && req.method === "GET") return send(200, { entity_id: a1[1], name: act.name, options: { included_entities: act.entity_ids.map((entity_id) => ({ entity_id })) } });
        if (!a1[2] && req.method === "PATCH") {
          for (const id of b.options?.entity_ids || []) if (!entityList().some((e) => e.entity_id === id) && !devices[id]) return send(400, { message: "Entity does not exist: " + id });
          if (b.options?.entity_ids) act.entity_ids = b.options.entity_ids;
          return send(200, {});
        }
        const checkItems = (items) => {
          for (const it of items || []) {
            const ref = it.sensor?.sensor_id || it.command?.entity_id;
            if (ref && !act.entity_ids.includes(ref)) return "entity not included: " + ref;
            if (it.type === "sensor" && !it.sensor?.sensor_id) return "Invalid sensor configuration";
          }
          return null;
        };
        if (a1[2] && !a1[3] && req.method === "GET") return send(200, act.pages);
        if (a1[2] && !a1[3] && req.method === "POST") {
          const err = checkItems(b.items); if (err) return send(400, { message: err });
          const pg = { page_id: "p" + pageSeq++, ...b }; act.pages.push(pg); return send(201, { page_id: pg.page_id });
        }
        if (a1[3] && req.method === "PATCH") {
          const pg = act.pages.find((x) => x.page_id === decodeURIComponent(a1[3]));
          if (!pg) return send(404, { message: "no page" });
          const err = checkItems(b.items); if (err) return send(400, { message: err });
          Object.assign(pg, b); return send(200, pg);
        }
      }
      const lm = /^\/api\/entities\?(.*)$/.exec(url);
      if (lm && req.method === "GET") {
        const q = new URLSearchParams(lm[1]);
        const limit = Number(q.get("limit") || 10), page = Number(q.get("page") || 1);
        return send(200, entityList().slice((page - 1) * limit, page * limit));
      }
      const pe = /^\/api\/entities\/([^/?]+)$/.exec(url);
      if (pe && req.method === "PATCH") {
        const id = decodeURIComponent(pe[1]);
        const known = devices[id] || (id.startsWith("self_control.main.") && selfEntities[id.slice(18)]);
        if (!known) return send(404, { message: "no entity " + id });
        const b = JSON.parse(body);
        if (b.icon) entityIcons[id] = b.icon;
        return send(200, { entity_id: id, icon: b.icon });
      }
      const em = /^\/api\/entities\/([^/]+)(\/command)?$/.exec(url);
      if (em) {
        const id = decodeURIComponent(em[1]);
        if (!devices[id]) return send(404, { message: "no entity " + id });
        if (!em[2] && req.method === "GET") return send(200, { entity_id: id, name: { en: NAMES[id] }, attributes: devices[id] });
        if (em[2] && req.method === "PUT") {
          const b = JSON.parse(body);
          commands.push({ entity: id, cmd_id: b.cmd_id, params: b.params });
          const code = deviceCommand(id, b.cmd_id, b.params);
          return send(code, code === 200 ? { code: "OK" } : { message: "command failed" });
        }
      }
      const m = /^\/api\/cfg\/(\w+)$/.exec(url);
      if (m && req.method === "PATCH") {
        const b = JSON.parse(body);
        patches.push({ section: m[1], body: b });
        if (m[1] === "display" && (b.brightness === undefined || b.auto_brightness === undefined)) return send(400, { message: "display needs both fields" });
        deepMerge(cfg[m[1]], b);
        return send(200, cfg[m[1]]);
      }
      send(404, { message: "not found " + url });
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
