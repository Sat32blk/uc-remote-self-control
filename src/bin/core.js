// Minimal client for the remote's own REST Core-API (http://<address>/api).
// Auth: Bearer API key for normal use, Basic web-configurator:<PIN> only during setup.

export class CoreError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status; // HTTP status, 0 if the request never got an answer
    this.kind = kind; // "unreachable" | "unauthorized" | "http"
  }
}

// Activities this integration changed (pages, buttons, devices) and when. Changing an activity makes the
// remote send an entity_change for it with its state ("ON" if it's running), which looks exactly like the
// user opening it; the event listener ignores those for 2 s after our own write (the remote reports them
// within a fraction of a second; a person can hardly open that activity again so quickly).
const writes = new Map(); // activity id -> time of our last write
// Every change this integration makes to an activity (pages, buttons, devices), for the builder's counter.
const writeLog = []; // timestamps, last hour
// Pages this integration has just written: the next read of such a page is the new "known" state (used to
// notice when someone else changed a page in between, see StateIcons).
const touched = new Set(); // "activity|page_id"
export function writeStats() {
  const hour = Date.now() - 3600000;
  while (writeLog.length && writeLog[0] < hour) writeLog.shift();
  return { lastHour: writeLog.length };
}
/** True (once) if this integration wrote that page since the last call. */
export function takeTouched(activity, pageId) {
  return touched.delete(`${activity}|${pageId}`);
}
export function wroteActivity(id, withinMs = 2000) {
  const t = writes.get(id);
  return t !== undefined && Date.now() - t < withinMs;
}

// Device values (GET /entities/<id>) are kept in memory. While the remote's live events are connected
// (see CoreEvents) they keep these values current, so a value is read from the remote at most every
// LIVE_MAX_AGE ms as a safety check. Without events every read asks the remote as before (so "wait
// until" steps see a change at once); only reads of the same device at the same moment share a request.
// For BUSY_MS after this integration sends a command, kept values are reused for 1 s at most, so a step
// waiting for a device still sees the change if the remote doesn't report it as an event.
const LIVE_MAX_AGE = Number(process.env.UC_SELF_LIVE_MAX_AGE_MS || 20000);
const BUSY_MS = 15000;
const ENTITY_PATH = /^\/entities\/([^/?#]+)$/;

export class CoreClient {
  #ent = new Map(); // "<id as in the path>" -> { e, at }
  #reading = new Map(); // same key -> promise of a read in progress
  constructor(address, { apiKey, pin, timeoutMs = 5000 } = {}) {
    this.base = `http://${address || "127.0.0.1"}/api`;
    this.apiKey = apiKey;
    this.pin = pin;
    this.timeoutMs = timeoutMs;
    this.live = () => false; // set by the driver: true while the remote's events are connected
    this.reads = { remote: 0, memory: 0 }; // device reads answered by the remote / from memory (builder stats)
  }

  /** An entity_change event: merge the new values into the kept copy (only devices read before). */
  entityEvent(id, attrs) {
    const c = this.#ent.get(encodeURI(id));
    if (!c || !attrs || typeof attrs !== "object") return;
    c.e = { ...(c.e || {}), attributes: { ...(c.e?.attributes || {}), ...attrs } };
  }
  /** Forget every kept device value (events reconnected: some may have been missed). */
  clearEntities() {
    this.#ent.clear();
  }

  #maxAge() {
    if (!this.live()) return 0;
    return Date.now() - (this.commandAt || 0) < BUSY_MS ? 1000 : LIVE_MAX_AGE;
  }

  async #entity(key) {
    const c = this.#ent.get(key);
    if (c && Date.now() - c.at < this.#maxAge()) { this.reads.memory++; return structuredClone(c.e); }
    let p = this.#reading.get(key);
    if (!p) {
      this.reads.remote++;
      p = this.request("GET", `/entities/${key}`).then(
        (e) => { this.#ent.set(key, { e, at: Date.now() }); return e; },
        (err) => { this.#ent.delete(key); throw err; }
      ).finally(() => this.#reading.delete(key));
      this.#reading.set(key, p);
    }
    return structuredClone(await p);
  }

  #authHeader() {
    if (this.apiKey) return `Bearer ${this.apiKey}`;
    if (this.pin) return "Basic " + Buffer.from(`web-configurator:${this.pin}`).toString("base64");
    return undefined;
  }

  async request(method, path, body) {
    if (method !== "GET") { // a command or change to a device: read it fresh next time
      const m = /^\/entities\/([^/?#]+)/.exec(path);
      if (m) { this.#ent.delete(m[1]); this.commandAt = Date.now(); }
    }
    const am = method !== "GET" ? /^\/activities\/([^/?]+)(?:\/ui\/pages\/([^/?]+))?/.exec(path) : null;
    const act = am?.[1];
    if (act) {
      writes.set(decodeURIComponent(act), Date.now());
      writeLog.push(Date.now());
      if (am[2]) touched.add(`${decodeURIComponent(act)}|${decodeURIComponent(am[2])}`);
    }
    const headers = { Accept: "application/json" };
    const auth = this.#authHeader();
    if (auth && !path.startsWith("/pub/")) headers.Authorization = auth;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      throw new CoreError(`${method} ${path}: ${e.message}`, 0, "unreachable");
    }

    if (act) writes.set(decodeURIComponent(act), Date.now()); // the remote reports the change after answering
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (res.status === 401 || res.status === 403) {
      throw new CoreError(`${method} ${path}: HTTP ${res.status}`, res.status, "unauthorized");
    }
    if (!res.ok) {
      const detail = data && typeof data === "object" ? data.message || JSON.stringify(data) : text;
      throw new CoreError(`${method} ${path}: HTTP ${res.status} ${detail || ""}`.trim(), res.status, "http");
    }
    return data;
  }

  get(path) {
    const m = ENTITY_PATH.exec(path);
    return m ? this.#entity(m[1]) : this.request("GET", path);
  }

  /** GET with the paging headers (Pagination-Count / -Limit / -Page): { data, count, limit, page }. */
  async getPaged(path) {
    const headers = { Accept: "application/json" };
    const auth = this.#authHeader();
    if (auth) headers.Authorization = auth;
    let res;
    try { res = await fetch(this.base + path, { headers, signal: AbortSignal.timeout(Math.max(this.timeoutMs, 10000)) }); }
    catch (e) { throw new CoreError(`GET ${path}: ${e.message}`, 0, "unreachable"); }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const detail = data && typeof data === "object" ? data.message || JSON.stringify(data) : text;
      throw new CoreError(`GET ${path}: HTTP ${res.status} ${detail || ""}`.trim(), res.status, "http");
    }
    const num = (h) => { const v = res.headers.get(h); return v === null ? undefined : Number(v); };
    return { data, count: num("pagination-count"), limit: num("pagination-limit"), page: num("pagination-page") };
  }

  patch(path, body) {
    return this.request("PATCH", path, body);
  }

  post(path, body) {
    return this.request("POST", path, body);
  }

  /**
   * Uploads a PNG as a custom icon. Returns the icon id ("custom:<id>" in UI items).
   * An icon with the same name is kept (the remote never overwrites) and its id returned.
   */
  async uploadIcon(name, png) {
    return this.uploadResource("Icon", name, png, "image/png");
  }

  /** Uploads a picture resource (Icon, TvChannelIcon, BackgroundImage). Same name already there: its id. */
  async uploadResource(type, name, buf, mime = "image/png") {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), name);
    try {
      const res = await this.request("POST", `/resources/${type}`, form);
      const item = Array.isArray(res) ? res[0] : res;
      return item?.id || name;
    } catch (e) {
      if (e.status === 422) return name; // already there
      throw e;
    }
  }

  /** Raw download (e.g. an icon image). Returns { type, body: Buffer }. */
  async download(path, timeoutMs = this.timeoutMs) {
    const headers = {};
    const auth = this.#authHeader();
    if (auth) headers.Authorization = auth;
    let res;
    try {
      res = await fetch(this.base + path, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new CoreError(`GET ${path}: ${e.message}`, 0, "unreachable");
    }
    if (!res.ok) throw new CoreError(`GET ${path}: HTTP ${res.status}`, res.status, res.status === 401 ? "unauthorized" : "http");
    const disp = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") || "");
    return { type: res.headers.get("content-type") || "application/octet-stream", body: Buffer.from(await res.arrayBuffer()), filename: disp ? disp[1] : null };
  }

  /** Creates an admin API key using the PIN. Returns the key string. */
  async createApiKey(name) {
    const res = await this.post("/auth/api_keys", {
      name,
      scopes: ["admin"],
      active: true,
      description: "Created by the Remote Self-Control integration"
    });
    if (!res || !res.api_key) throw new CoreError("API key response had no api_key", 0, "http");
    return res.api_key;
  }
}
