// Small helpers shared by the integration's modules.

/** A name from the remote: plain text, or { en: "…", de: "…" }. */
export const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");
/** A short stable hash of a text (file names for generated pictures, change detection). */
export const hashOf = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
