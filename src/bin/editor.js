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
//
// Everything needs the builder login (web-configurator PIN), like the rest of the builder.

import fs from "node:fs";
import path from "node:path";

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

export function editorRoutes({ getCore, onScreen = () => null, dataDir, editorPath, send, readJson, log = () => {}, warn = () => {} }) {
  const backupDir = dataDir ? path.join(dataDir, "remote-backups") : null;
  let lastBackup = null; // { name, size, at }
  const notConnected = (res) => send(res, 503, { error: "The integration isn't connected to the remote." });

  return {
    "GET /editor": async (req, res) => {
      let html;
      try {
        html = fs.readFileSync(editorPath, "utf8");
      } catch {
        return send(res, 500, { error: "editor page missing" });
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN" });
      res.end(html);
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
