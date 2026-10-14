// Puts the "Smart Controls: Last Result" tile (and optionally the Smart Control buttons) on a page in an activity.
// The web configurator doesn't offer sensor entities for activities, but the Core REST API accepts them.
//
//   GET   /activities                      list (paged)
//   GET   /activities/{id}                 options.included_entities
//   PATCH /activities/{id}                 { options: { entity_ids } }
//   GET   /activities/{id}/ui/pages        existing pages
//   POST  /activities/{id}/ui/pages        new page
//   PATCH /activities/{id}/ui/pages/{pid}  replace our page on a re-run

export const PAGE_NAME = "Smart Controls";
const GRID_W = 4;
const GRID_H = 6;

const nameOf = (n) => (n && typeof n === "object" ? n.en || n.en_US || Object.values(n)[0] || "" : n || "");

async function pagedGet(core, base) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const part = await core.get(`${base}${base.includes("?") ? "&" : "?"}limit=100&page=${page}`);
    if (!Array.isArray(part) || part.length === 0) break;
    out.push(...part);
    if (part.length < 100) break;
  }
  return out;
}

/** Activities the user can edit, sorted by name: [{ id, name }] */
export async function listActivities(core) {
  const list = await pagedGet(core, "/activities");
  return list
    .filter((a) => a && a.entity_id && a.options?.editable !== false)
    .map((a) => ({ id: a.entity_id, name: nameOf(a.name) || a.entity_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Entity ids of this integration on the remote, keyed by the driver's own id (e.g. "smart_last_result"). */
export async function ownEntities(core, driverId) {
  const list = await pagedGet(core, "/entities");
  const out = {};
  for (const e of list) {
    const id = String(e?.entity_id || "");
    if (!id.startsWith(driverId + ".") && !String(e?.integration_id || "").startsWith(driverId)) continue;
    out[id.split(".").pop()] = { id, name: nameOf(e.name) };
  }
  return out;
}

/** Page items: the result tile across the top, then the buttons two per row. */
export function buildPage(sensorId, buttons) {
  const items = [{ type: "sensor", location: { x: 0, y: 0 }, size: { width: GRID_W, height: 1 }, text: "Last result", sensor: { sensor_id: sensorId, show_label: false } }];
  buttons.forEach((b, i) => {
    items.push({
      type: "text",
      text: (b.name || b.id).slice(0, 50),
      location: { x: (i % 2) * 2, y: 1 + Math.floor(i / 2) },
      size: { width: 2, height: 1 },
      command: { entity_id: b.id, cmd_id: "button.push" }
    });
  });
  const height = Math.max(GRID_H, 1 + Math.ceil(buttons.length / 2));
  return { name: PAGE_NAME, grid: { width: GRID_W, height }, items };
}

/**
 * Adds the tile (and buttons) to an activity. Re-running replaces the earlier "Smart Controls" page.
 * smartIds: the ids of the current Smart Controls, in order (from the rules).
 * Returns { activity, page, buttons, missing, replaced }.
 */
export async function addTile(core, { activityId, withButtons, driverId, sensorKey, smartIds }) {
  const own = await ownEntities(core, driverId);
  const sensor = own[sensorKey];
  if (!sensor) {
    const e = new Error('"Smart Controls: Last Result" isn\'t added to the integration yet. Add it under Integrations → Remote Self-Control, then run this again.');
    e.kind = "missing_sensor";
    throw e;
  }
  const buttons = [];
  const missing = [];
  if (withButtons) {
    for (const key of smartIds) {
      if (own[key]) buttons.push(own[key]);
      else missing.push(key);
    }
  }

  const act = await core.get(`/activities/${encodeURI(activityId)}`);
  const included = (act?.options?.included_entities || []).map((x) => x.entity_id).filter(Boolean);
  const want = [sensor.id, ...buttons.map((b) => b.id)];
  const add = want.filter((id) => !included.includes(id));
  if (add.length) await core.patch(`/activities/${encodeURI(activityId)}`, { options: { entity_ids: [...included, ...add] } });

  const page = buildPage(sensor.id, buttons);
  const pages = (await core.get(`/activities/${encodeURI(activityId)}/ui/pages`)) || [];
  const existing = Array.isArray(pages) ? pages.find((p) => p.name === PAGE_NAME) : null;
  let pageId;
  if (existing) {
    await core.patch(`/activities/${encodeURI(activityId)}/ui/pages/${encodeURIComponent(existing.page_id)}`, page);
    pageId = existing.page_id;
  } else {
    const res = await core.post(`/activities/${encodeURI(activityId)}/ui/pages`, page);
    pageId = res?.page_id;
  }
  return { activity: nameOf(act?.name) || activityId, page: pageId, buttons: buttons.map((b) => b.name), missing, replaced: !!existing, added: add };
}
