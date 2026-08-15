/**
 * Studio activity — who bound what, on this frame.
 *
 * PURE. No Figma import.
 *
 * Figma will not tell a plugin who last edited a layer. The only authorship we
 * can stand behind is a bind Studio itself applied. Each designer writes their
 * own pluginData lane so two people hitting Bind at once cannot clobber each
 * other's log. Merge is newest-first.
 */
export type ActivityKind = "bind" | "autofix" | "add";

export interface ActivityActor {
  id: string | null;
  name: string;
  color: string;
}

export interface ActivityEntry {
  id: string;
  actor: ActivityActor;
  kind: ActivityKind;
  label: string;
  tokenRef: string;
  applied: number;
  at: number;
}

export const ACTIVITY_PREFIX = "fanos-studio.act.";
export const ACTIVITY_KEEP = 20;
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function laneKey(userId: string | null): string {
  const id = userId && userId.length > 0 ? userId : "anon";
  return `${ACTIVITY_PREFIX}${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function samePerson(a: ActivityActor, b: ActivityActor): boolean {
  if (a.id && b.id) return a.id === b.id;
  return a.name === b.name;
}

export function firstName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Anonymous";
  return trimmed.split(/\s+/)[0]!;
}

export function initialOf(name: string): string {
  const first = firstName(name);
  return (first[0] ?? "?").toUpperCase();
}

export function mergeActivity(lanes: readonly (readonly ActivityEntry[])[]): ActivityEntry[] {
  const seen = new Set<string>();
  const all: ActivityEntry[] = [];
  for (const lane of lanes) {
    for (const entry of lane) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      all.push(entry);
    }
  }
  return all.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_KEEP);
}

export function appendLane(lane: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [entry, ...lane.filter((item) => item.id !== entry.id)].slice(0, ACTIVITY_KEEP);
}

export function popLane(lane: readonly ActivityEntry[], id?: string): ActivityEntry[] {
  if (lane.length === 0) return [];
  if (!id) return lane.slice(1);
  return lane.filter((item) => item.id !== id);
}

export function recentActors(
  entries: readonly ActivityEntry[],
  now = Date.now(),
  windowMs = RECENT_WINDOW_MS,
): ActivityActor[] {
  const out: ActivityActor[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (now - entry.at > windowMs) continue;
    const key = entry.actor.id ?? entry.actor.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.actor);
    if (out.length >= 4) break;
  }
  return out;
}

export function parseLane(raw: string): ActivityEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ActivityEntry[] = [];
    for (const item of parsed) {
      const entry = asEntry(item);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function asEntry(value: unknown): ActivityEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const actorRaw = row.actor;
  if (!actorRaw || typeof actorRaw !== "object") return null;
  const actorObj = actorRaw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.label !== "string") return null;
  if (typeof row.tokenRef !== "string" || typeof row.applied !== "number" || typeof row.at !== "number") {
    return null;
  }
  if (row.kind !== "bind" && row.kind !== "autofix" && row.kind !== "add") return null;
  if (typeof actorObj.name !== "string") return null;
  return {
    id: row.id,
    actor: {
      id: typeof actorObj.id === "string" ? actorObj.id : null,
      name: actorObj.name,
      color: typeof actorObj.color === "string" ? actorObj.color : "#6b6b6b",
    },
    kind: row.kind,
    label: row.label,
    tokenRef: row.tokenRef,
    applied: row.applied,
    at: row.at,
  };
}
