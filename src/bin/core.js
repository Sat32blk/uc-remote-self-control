// Minimal client for the remote's own REST Core-API (http://<address>/api).
// Auth: Bearer API key for normal use, Basic web-configurator:<PIN> only during setup.

export class CoreError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status; // HTTP status, 0 if the request never got an answer
    this.kind = kind; // "unreachable" | "unauthorized" | "http"
  }
}

export class CoreClient {
  constructor(address, { apiKey, pin, timeoutMs = 5000 } = {}) {
    this.base = `http://${address || "127.0.0.1"}/api`;
    this.apiKey = apiKey;
    this.pin = pin;
    this.timeoutMs = timeoutMs;
  }

  #authHeader() {
    if (this.apiKey) return `Bearer ${this.apiKey}`;
    if (this.pin) return "Basic " + Buffer.from(`web-configurator:${this.pin}`).toString("base64");
    return undefined;
  }

  async request(method, path, body) {
    const headers = { Accept: "application/json" };
    const auth = this.#authHeader();
    if (auth && !path.startsWith("/pub/")) headers.Authorization = auth;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      throw new CoreError(`${method} ${path}: ${e.message}`, 0, "unreachable");
    }

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
    return this.request("GET", path);
  }

  patch(path, body) {
    return this.request("PATCH", path, body);
  }

  post(path, body) {
    return this.request("POST", path, body);
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
