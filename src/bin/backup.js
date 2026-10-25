// Backup and restore of everything a user set up in the builder: smart controls, quick menus and sliders,
// state icons and level pictures, ↩ return buttons, Controls, start pages and launchers. Custom pictures used by them (on the
// remote as custom:<file>) are included, so a backup also works after a factory reset or on another remote.
// Never included: the API key and the remote's address (self_control.json), or caches.

export const BACKUP_KIND = "uc-self-control-backup";
export const BACKUP_FORMAT = 1;
const ICON_RE = /^custom:([A-Za-z0-9_.\-]{1,120})$/;
const MAX_ICONS = 2000;

/** Every custom:<file> picture referenced anywhere in the parts. */
export function iconsIn(parts) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") { const m = ICON_RE.exec(v); if (m) out.add(m[1]); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(parts);
  return [...out];
}

/**
 * Builds a backup. src: { version, rulesText, extras, icons, controls, returnCfg, downloadIcon(id) → Buffer }.
 * Pictures that can't be read are listed in missingIcons instead of failing the backup.
 */
export async function makeBackup(src) {
  let rules = null;
  try { rules = src.rulesText ? JSON.parse(src.rulesText) : null; } catch { rules = null; }
  const parts = {
    smart: rules,
    extras: src.extras ? { sliders: src.extras.sliders || [], menus: src.extras.menus || [] } : null,
    icons: (src.icons || []).map(({ status, page_id, ...b }) => b),
    controls: src.controls || null,
    pages: src.starts ? { starts: src.starts } : null,
    launchers: src.launchers ? { launchers: src.launchers } : null,
    applinks: src.appLinks && Object.keys(src.appLinks).length ? { links: src.appLinks } : null,
    return: src.returnCfg ? { hosts: src.returnCfg.hosts || [], screen: src.returnCfg.screen, button: src.returnCfg.button, press: src.returnCfg.press, buttonScope: src.returnCfg.buttonScope, hostCfg: src.returnCfg.hostCfg || {} } : null
  };
  const pictures = {};
  const missingIcons = [];
  for (const id of iconsIn(parts).slice(0, MAX_ICONS)) {
    try {
      const buf = await src.downloadIcon(id);
      if (buf && buf.length) pictures[id] = Buffer.from(buf).toString("base64");
      else missingIcons.push(id);
    } catch {
      missingIcons.push(id);
    }
  }
  return { kind: BACKUP_KIND, format: BACKUP_FORMAT, driverVersion: src.version || "", created: new Date().toISOString(), parts, pictures, missingIcons };
}

/** Checks the outer shape of a backup file. Returns an error text or null. */
export function checkBackup(b) {
  if (!b || typeof b !== "object" || b.kind !== BACKUP_KIND) return "This isn't a Remote Self-Control backup file.";
  if (b.format !== BACKUP_FORMAT) return `This backup has format ${b.format}; this version reads format ${BACKUP_FORMAT}.`;
  if (!b.parts || typeof b.parts !== "object") return "The backup has no settings in it.";
  return null;
}

/**
 * Restores a backup. api: { uploadIcon(name, Buffer), saveRules(obj), validateRules(obj) → errors,
 * validateExtras(obj) → {errors, extras}, applyExtras(extras), validateIcons(obj) → {errors, icons},
 * applyIcons(icons, defaults) → {errors}, validateControls(obj) → {errors, config}, applyControls(config),
 * applyReturn(obj) → errors }. which: list of parts to restore (default all present).
 * Validates every part first; only then changes anything. Returns { errors, done: [part], warnings }.
 */
export async function restoreBackup(b, api, which = null) {
  const bad = checkBackup(b);
  if (bad) return { errors: [bad], done: [], warnings: [] };
  const want = (k) => b.parts[k] !== null && b.parts[k] !== undefined && (!which || which.includes(k));
  const errors = [];
  const plan = [];
  if (want("smart")) {
    const errs = api.validateRules(b.parts.smart);
    if (errs.length) errors.push(...errs.map((e) => "Smart controls: " + e));
    else plan.push(["smart", () => api.saveRules(b.parts.smart)]);
  }
  if (want("extras")) {
    const v = api.validateExtras(b.parts.extras);
    if (v.errors.length) errors.push(...v.errors.map((e) => "Sliders and menus: " + e));
    else plan.push(["extras", () => api.applyExtras(v.extras)]);
  }
  if (want("icons")) {
    const v = api.validateIcons({ icons: b.parts.icons });
    if (v.errors.length) errors.push(...v.errors.map((e) => "State icons: " + e));
    else {
      // the buttons' own looks from the backup, for pages that still show a state icon's picture
      const defaults = new Map();
      for (const o of b.parts.icons) {
        const cells = Array.isArray(o.cells) && o.cells.length ? o.cells : [o.location];
        cells.forEach((c, k) => { const d = cells.length > 1 ? o.cellDefaults?.[k] : o.default; if (c && d) defaults.set(`${o.activity}|${c.x},${c.y}`, d); });
      }
      plan.push(["icons", () => api.applyIcons(v.icons, defaults)]);
    }
  }
  if (want("controls")) {
    const v = api.validateControls(b.parts.controls);
    if (v.errors.length) errors.push(...v.errors.map((e) => "Controls: " + e));
    else plan.push(["controls", () => api.applyControls(v.config)]);
  }
  if (want("return")) plan.push(["return", () => api.applyReturn(b.parts.return)]);
  if (want("pages") && api.validateStarts) {
    const v = api.validateStarts(b.parts.pages.starts || []);
    if (v.errors.length) errors.push(...v.errors.map((e) => "Start pages: " + e));
    else plan.push(["pages", () => api.applyStarts(v.starts)]);
  }
  if (want("launchers") && api.validateLaunchers) {
    const v = api.validateLaunchers(b.parts.launchers.launchers || []);
    if (v.errors.length) errors.push(...v.errors.map((e) => "Launchers: " + e));
    else plan.push(["launchers", () => api.applyLaunchers(v.launchers)]);
  }
  if (want("applinks") && api.validateAppLinks) {
    const why = api.validateAppLinks(b.parts.applinks.links);
    if (why) errors.push("App links: " + why);
    else plan.push(["applinks", () => api.applyAppLinks(b.parts.applinks.links)]);
  }
  if (errors.length) return { errors, done: [], warnings: [] };

  const warnings = [];
  // pictures first: pages and tiles refer to them
  let up = 0;
  for (const [id, data] of Object.entries(b.pictures || {})) {
    if (!/^[A-Za-z0-9_.\-]{1,120}$/.test(id)) continue;
    try {
      await api.uploadIcon(id, Buffer.from(String(data), "base64"));
      up++;
    } catch (e) {
      warnings.push(`picture ${id}: ${e.message}`);
    }
  }
  if (b.missingIcons?.length) warnings.push(`${b.missingIcons.length} picture(s) weren't in the backup (they couldn't be read when it was made).`);
  const done = [];
  for (const [part, run] of plan) {
    try {
      const r = await run();
      const errs = Array.isArray(r) ? r : r?.errors || [];
      if (errs.length) errors.push(...errs.map((e) => `${part}: ${e}`));
      else done.push(part);
    } catch (e) {
      errors.push(`${part}: ${e.message}`);
    }
  }
  return { errors, done, warnings, pictures: up };
}
