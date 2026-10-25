// Page Editor support: a guarded pass-through to the remote's Core API for the builder's Page Editor tab,
// plus picture download / upload and a full remote backup before the first change.
//
//   GET  /editor                    the Page Editor page (shown inside the builder's first tab)
//   POST /api/core                  { method, path, body } -> { status, data }   only the paths in ALLOW
//   GET  /api/core/image?type=&id=  a picture (Icon, TvChannelIcon, BackgroundImage)
//   POST /api/core/upload           { type, name, data (base64) } -> { id }
//   POST /api/core/backup           saves a full remote backup on the remote (kept: last 2), unless one
//                                    was made in the last 30 minutes -> { ok, name, size, reused }
//   GET  /api/core/backup/latest    downloads the newest of those backups
//   GET  /api/editor/state          { onScreen } the activity on the remote's screen (if known)
//   GET  /api/editor/iconfont       the remote's built-in icon font (from its web configurator)
//   GET/POST /api/editor/applinks   app links per integration ("<command> = <name>"), kept on the remote
//
// Everything needs the builder login (web-configurator PIN), like the rest of the builder.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ---- sending less over the remote's Wi-Fi: gzip for pages and larger answers ----
const accepts = (req) => /\bgzip\b/.test(req?.headers?.["accept-encoding"] || "");
/** Sends a body, gzipped when the browser accepts it and it's worth it. */
export function sendBody(req, res, code, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (buf.length > 1024 && accepts(req)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    res.writeHead(code, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(code, { ...headers, "Content-Length": buf.length });
  res.end(buf);
}
const pageCache = new Map(); // file -> { mtime, raw, gz }
/** Serves an HTML page from disk; read and compressed once per change of the file. */
export function servePage(req, res, file, extraHeaders = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"error":"page missing"}'); }
  let c = pageCache.get(file);
  if (!c || c.mtime !== st.mtimeMs) {
    const raw = fs.readFileSync(file);
    c = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }) };
    pageCache.set(file, c);
  }
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders };
  if (accepts(req)) { res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": c.gz.length }); return res.end(c.gz); }
  res.writeHead(200, { ...headers, "Content-Length": c.raw.length });
  res.end(c.raw);
}

// Paths the editor may use, and with which methods. Anything else is refused.
const ALL = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const ID = "[^/?#]+";
export const ALLOW = [
  [new RegExp(`^/activities(/${ID}(/buttons(/[A-Z0-9_]{1,20}(/(short_press|long_press))?)?|/ui/pages(/${ID})?|/readiness)?)?$`), ALL],
  [new RegExp(`^/activity_groups(/${ID})?$`), ALL],
  [new RegExp(`^/macros(/${ID}(/readiness)?)?$`), ALL],
  [new RegExp(`^/profiles(/${ID}(/(pages|groups)(/${ID})?)?)?$`), ALL],
  [/^\/resources\/(Icon|TvChannelIcon|BackgroundImage)(\/[^/?#]+)?$/, ["GET", "DELETE"]],
  [new RegExp(`^/entities(/${ID}(/command)?)?$`), ["GET", "PATCH", "PUT", "DELETE"]],
  [new RegExp(`^/intg(/instances(/${ID}(/entities)?)?|/discover|/drivers)?$`), ["GET", "POST", "PATCH", "PUT", "DELETE"]],
  [new RegExp(`^/intg/drivers/${ID}$`), ["GET"]],
  [/^\/cfg\/(device(\/(button_layout|screen_layout|icon_mapping))?|entity\/commands)$/, ["GET"]],
  [/^\/system$/, ["GET"]],
  [/^\/pub\/version$/, ["GET"]]
];
export const RESOURCE_TYPES = { Icon: 32 * 1024, TvChannelIcon: 32 * 1024, BackgroundImage: 1024 * 1024 };

/** null if the call is allowed, otherwise why not. */
export function checkCoreCall(method, fullPath) {
  method = String(method || "").toUpperCase();
  if (!ALL.includes(method)) return "method not allowed";
  const p = String(fullPath || "");
  if (!p.startsWith("/") || p.length > 600 || /\.\.|\/\/|[\s\\]/.test(p)) return "invalid path";
  const [pathOnly, query = ""] = p.split("?");
  if (query && !/^[A-Za-z0-9_=&%.,\-:]*$/.test(query)) return "invalid query";
  // deleting a whole collection (e.g. DELETE /activities) is never allowed: only one item at a time
  if (method === "DELETE" && !/^\/[a-z_]+\/[^/]+/.test(pathOnly)) return "only single items can be deleted";
  if (method === "DELETE" && /^\/(resources\/[A-Za-z]+|intg\/instances|intg\/drivers|intg\/discover|profiles\/[^/]+\/(pages|groups))$/.test(pathOnly)) return "only single items can be deleted";
  const rule = ALLOW.find(([re]) => re.test(pathOnly));
  if (!rule) return "path not allowed";
  if (!rule[1].includes(method)) return "method not allowed for this path";
  return null;
}

const sniff = (buf) => {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
};

/**
 * The remote's built-in icon font (the "uc:" icons), found in its own web configurator: the configurator's
 * page links its style sheets, and one of their @font-face rules is the icon font. Returns
 * { family, url, type, body } or null. fetchText / fetchBin: (url) -> string / { type, body }.
 */
export async function findIconFont(origin, fetchText, fetchBin) {
  const page = new URL("/configurator/", origin).href;
  const html = await fetchText(page);
  const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/gi)].map((m) => new URL(m[1], page).href);
  const faces = [];
  for (const css of sheets.slice(0, 8)) {
    let text;
    try { text = await fetchText(css); } catch { continue; }
    for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const fam = (/font-family\s*:\s*["']?([^;"']+)/i.exec(m[1]) || [])[1] || "";
      const urls = [...m[1].matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)].map((u) => new URL(u[1], css).href);
      const src = urls.find((u) => /\.woff2(\?|#|$)/i.test(u)) || urls.find((u) => /\.woff(\?|#|$)/i.test(u)) || urls.find((u) => /\.ttf(\?|#|$)/i.test(u));
      if (src) faces.push({ family: fam.trim(), url: src });
    }
  }
  const pick = faces.find((f) => /icon|^uc|ucr|remote/i.test(f.family)) || faces.find((f) => /icon/i.test(f.url));
  if (!pick) return null;
  const font = await fetchBin(pick.url);
  const type = /\.woff2/i.test(pick.url) ? "font/woff2" : /\.woff/i.test(pick.url) ? "font/woff" : "font/ttf";
  return { family: pick.family, url: pick.url, type, body: font.body };
}

/**
 * App links for an integration (e.g. Android TV apps that aren't in its input list), from a text file:
 * one per line, "<command> = <name shown>", e.g. "market://launch?id=ar.tvplayer.tv = Tivimate".
 * The command may contain "=" itself: the line is split at the last " = ". Empty lines and # comments are skipped.
 * Returns { links: [{ cmd, name }], errors: [string] }.
 */
export function parseAppLinks(text) {
  const links = [], errors = [];
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(.*\S)\s+=\s+(.+)$/.exec(line);
    if (!m) { errors.push(`line ${i + 1}: expected "<command> = <name>"`); return; }
    const cmd = m[1].trim(), name = m[2].trim();
    if (cmd.length > 255) errors.push(`line ${i + 1}: the command is longer than 255 characters`);
    else if (name.length > 60) errors.push(`line ${i + 1}: the name is longer than 60 characters`);
    else links.push({ cmd, name });
  });
  return { links, errors };
}
/** Checks a saved list: { [integration id]: [{ cmd, name }] }. */
export function checkAppLinks(all) {
  if (!all || typeof all !== "object" || Array.isArray(all)) return "a list per integration expected";
  const ids = Object.keys(all);
  if (ids.length > 50) return "too many integrations";
  for (const id of ids) {
    if (!/^[A-Za-z0-9_.\-:]{1,120}$/.test(id)) return `invalid integration id "${id}"`;
    const l = all[id];
    if (!Array.isArray(l) || l.length > 300) return `${id}: up to 300 app links`;
    for (const x of l) if (!x || typeof x.cmd !== "string" || typeof x.name !== "string" || !x.cmd.trim() || !x.name.trim() || x.cmd.length > 255 || x.name.length > 60) return `${id}: each app link needs a command (≤ 255) and a name (≤ 60)`;
  }
  return null;
}

export function editorRoutes({ getCore, onScreen = () => null, dataDir, editorPath, send, readJson, log = () => {}, warn = () => {} }) {
  const backupDir = dataDir ? path.join(dataDir, "remote-backups") : null;
  let lastBackup = null; // { name, size, at }
  const notConnected = (res) => send(res, 503, { error: "The integration isn't connected to the remote." });
  let iconFont = null, iconFontTried = 0;

  return {
    "GET /editor": async (req, res) => servePage(req, res, editorPath, { "X-Frame-Options": "SAMEORIGIN" }),
    // the remote's built-in icon font, so the editor can draw "uc:" icons like the remote does
    "GET /api/editor/iconfont": async (req, res) => {
      const core = getCore();
      if (!core) return notConnected(res);
      if (!iconFont && Date.now() - iconFontTried > 10 * 60 * 1000) {
        iconFontTried = Date.now();
        const origin = core.base.replace(/\/api$/, "");
        const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; };
        try {
          iconFont = await findIconFont(origin, async (u) => (await get(u)).text(), async (u) => ({ body: Buffer.from(await (await get(u)).arrayBuffer()) }));
          if (iconFont) log(`page editor: built-in icon font found (${iconFont.family}, ${Math.round(iconFont.body.length / 1024)} KB)`);
          else warn("page editor: the web configurator's icon font wasn't found");
        } catch (e) { warn("page editor: icon font:", e.message); }
      }
      if (!iconFont) return send(res, 404, { error: "The remote's icon font wasn't found." });
      res.writeHead(200, { "Content-Type": iconFont.type, "Cache-Control": "private, max-age=86400", "X-Font-Family": encodeURIComponent(iconFont.family) });
      res.end(iconFont.body);
    },
    // app links per integration (kept by this integration, on the remote)
    "GET /api/editor/applinks": async (req, res) => {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(path.join(dataDir, "app_links.json"), "utf8")); } catch {}
      send(res, 200, { links: all });
    },
    "POST /api/editor/applinks": async (req, res) => {
      const body = await readJson(req);
      const why = checkAppLinks(body.links);
      if (why) return send(res, 422, { ok: false, error: why });
      const clean = Object.fromEntries(Object.entries(body.links).filter(([, l]) => l.length).map(([id, l]) => [id, l.map((x) => ({ cmd: x.cmd.trim(), name: x.name.trim() }))]));
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "app_links.json"), JSON.stringify(clean, null, 1));
      log(`page editor: app links saved (${Object.values(clean).reduce((n, l) => n + l.length, 0)})`);
      send(res, 200, { ok: true, links: clean });
    },
    "GET /api/editor/state": async (req, res) => send(res, 200, { onScreen: onScreen() || null }),
    "POST /api/core": async (req, res) => {
      const body = await readJson(req);
      const core = getCore();
      if (!core) return notConnected(res);
      const method = String(body.method || "GET").toUpperCase();
      const why = checkCoreCall(method, body.path);
      if (why) return send(res, 403, { error: `${method} ${body.path}: ${why}` });
      try {
        const data = await core.request(method, body.path, method === "GET" || method === "DELETE" ? undefined : body.body ?? undefined);
        send(res, 200, { status: 200, data: data ?? null });
      } catch (e) {
        // the remote's own answer (400 validation, 404, 409...) goes back to the page as it is
        send(res, e.status && e.status >= 400 && e.status < 600 ? (e.status === 401 || e.status === 403 ? 502 : e.status) : 502, { error: e.message, status: e.status || 0 });
      }
    },
    "GET /api/core/image": async (req, res) => {
      const q = new URL(req.url, "http://x").searchParams;
      const type = q.get("type") || "Icon", id = q.get("id") || "";
      if (!RESOURCE_TYPES[type]) return send(res, 400, { error: "invalid type" });
      if (!/^[A-Za-z0-9_.\-]{1,160}$/.test(id)) return send(res, 400, { error: "invalid id" });
      const core = getCore();
      if (!core) return notConnected(res);
      const img = await core.download(`/resources/${type}/${encodeURIComponent(id)}`);
      res.writeHead(200, { "Content-Type": img.type, "Cache-Control": "private, max-age=3600" });
      res.end(img.body);
    },
    "POST /api/core/upload": async (req, res) => {
      const body = await readJson(req, 2 * 1024 * 1024);
      const core = getCore();
      if (!core) return notConnected(res);
      const type = String(body.type || "");
      const max = RESOURCE_TYPES[type];
      if (!max) return send(res, 400, { error: "invalid type" });
      const name = String(body.name || "");
      if (!/^[A-Za-z0-9_.\-]{1,120}\.(png|jpe?g)$/i.test(name)) return send(res, 400, { error: "invalid file name (letters, digits, . _ - and .png / .jpg)" });
      const buf = Buffer.from(String(body.data || ""), "base64");
      const mime = sniff(buf);
      if (!mime) return send(res, 400, { error: "not a PNG or JPEG picture" });
      if (buf.length > max) return send(res, 413, { error: `picture is larger than ${Math.round(max / 1024)} KB` });
      const id = await core.uploadResource(type, name, buf, mime);
      log(`page editor: uploaded ${type} ${id}`);
      send(res, 200, { id });
    },
    "POST /api/core/backup": async (req, res) => {
      const body = await readJson(req);
      const core = getCore();
      if (!core) return notConnected(res);
      if (!backupDir) return send(res, 500, { error: "no place to keep backups" });
      if (!body.force && lastBackup && Date.now() - lastBackup.at < 30 * 60 * 1000) return send(res, 200, { ok: true, reused: true, ...lastBackup });
      let file;
      try {
        file = await core.download("/system/backup/export", 120000);
      } catch (e) {
        warn("page editor: remote backup failed:", e.message);
        return send(res, 502, { ok: false, error: e.message });
      }
      fs.mkdirSync(backupDir, { recursive: true });
      const ext = (/\.([A-Za-z0-9.]{1,12})$/.exec(file.filename || "") || [])[1] || (/zip/.test(file.type) ? "zip" : "bin");
      const name = `remote-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext.replace(/[^A-Za-z0-9.]/g, "")}`;
      fs.writeFileSync(path.join(backupDir, name), file.body);
      // keep the newest two: the remote has little room
      const old = fs.readdirSync(backupDir).filter((f) => /^remote-backup-/.test(f)).sort().reverse().slice(2);
      for (const f of old) try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
      lastBackup = { name, size: file.body.length, at: Date.now() };
      log(`page editor: remote backup saved (${Math.round(file.body.length / 1024)} KB)`);
      send(res, 200, { ok: true, reused: false, ...lastBackup });
    },
    "GET /api/core/backup/latest": async (req, res) => {
      const list = backupDir && fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /^remote-backup-/.test(f)).sort().reverse() : [];
      if (!list.length) return send(res, 404, { error: "No remote backup made yet." });
      const buf = fs.readFileSync(path.join(backupDir, list[0]));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${list[0]}"` });
      res.end(buf);
    }
  };
}
