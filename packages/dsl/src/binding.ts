/**
 * Data binding — how a tree reads data, and the only module that knows how.
 *
 * A bound prop is a TEMPLATE: literal text with `{ref}` holes.
 *
 *   ref   := "{" path ( "|" pipe )* "}"
 *   path  := name ( "." ( name | index ) )*        news.items.0.title
 *   pipe  := name ( ":" arg )*                     date:"MMM DD, YYYY"
 *   arg   := '"' text '"' | bare word
 *
 * The web renderer, the native bundler and the validator all read refs through
 * here. Before this module each kept its own regex, and they had already
 * drifted: the renderer's `lookup` indexed arrays while its comment said it did
 * not, and a `null` field rendered as the four letters "null".
 *
 * PIPES ARE A CLOSED LIST. Every renderer — web, native, the bundler that
 * pre-resolves for native — has to implement each one identically, and an
 * agent that is allowed to invent a pipe will. Shaping data (renaming fields,
 * joining APIs, building `detail_url`) is the CAST hook's job and already
 * happens there in JSONata. A pipe only does what depends on the DESIGN: the
 * date pattern the mock-up shows, and what to draw when a field is empty.
 *
 * `{{RATIO}}` IS NOT A REF. It is a slot in CDN image URLs that the hook emits
 * and the Image fills from its own `ratio` — see `fillImageRatio`. The
 * look-around in the regex keeps `{{…}}` from parsing as `{…}`.
 *
 * PURE. No filesystem, no process, no clock.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PATH = `${NAME}(?:\\.(?:${NAME}|\\d+))*`;
const ARG = `(?:"[^"]*"|[^\\s|:{}"]+)`;
const PIPE = `\\s*\\|\\s*${NAME}(?:\\s*:\\s*${ARG})*`;

/** One whole ref, `{path | pipe:arg}`. Groups: 1 = path, 2 = the pipe chain. */
const REF_SOURCE = `(?<!\\{)\\{(${PATH})((?:${PIPE})*)\\s*\\}(?!\\})`;

/** A fresh global regex over refs — fresh because a shared `g` regex carries `lastIndex`. */
export const refRegex = (): RegExp => new RegExp(REF_SOURCE, "g");

/** A bare data path, as `Repeater.over` and `when` conditions take it. */
export const PATH_RE = new RegExp(`^${PATH}$`);

export interface Pipe {
  name: string;
  args: string[];
}

export interface Ref {
  /** The ref exactly as written, braces included. */
  text: string;
  path: string;
  pipes: Pipe[];
}

/** Every ref in a template, in order. */
export function parseRefs(template: string): Ref[] {
  if (!template.includes("{")) return [];
  return [...template.matchAll(refRegex())].map((m) => ({
    text: m[0],
    path: m[1]!,
    pipes: parsePipes(m[2] ?? ""),
  }));
}

/** Does this string carry at least one ref? */
export function hasRef(value: unknown): boolean {
  return typeof value === "string" && value.includes("{") && refRegex().test(value);
}

function parsePipes(chain: string): Pipe[] {
  const pipes: Pipe[] = [];
  for (const m of chain.matchAll(new RegExp(PIPE, "g"))) {
    const body = m[0].replace(/^\s*\|\s*/, "");
    const name = body.match(new RegExp(`^${NAME}`))![0];
    const args = [...body.slice(name.length).matchAll(new RegExp(`:\\s*(${ARG})`, "g"))].map((a) => {
      const raw = a[1]!;
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    });
    pipes.push({ name, args });
  }
  return pipes;
}

/**
 * Rewrite the PATH of every ref, leaving its pipes alone.
 *
 * What a collapse needs: `{news.items.4.published_date | date:"MMM DD"}` inside
 * a folded card becomes `{article.published_date | date:"MMM DD"}`.
 */
export function mapRefPaths(template: string, rewrite: (path: string) => string): string {
  if (!template.includes("{")) return template;
  return template.replace(refRegex(), (whole, path: string, chain: string) => {
    const next = rewrite(path);
    return next === path ? whole : `{${next}${chain}}`;
  });
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Dot-path lookup. A numeric segment indexes an array — `news.items.0.title` —
 * which is how an index-tiered grid binds its lead card.
 */
export function lookup(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

export interface PipeSpec {
  /** Accepted argument counts. */
  arity: readonly number[];
  doc: string;
}

/**
 * The whole list. Adding one means adding it to every renderer.
 *
 * `date` takes the token set of `formatDate` in fanxp-web-renderer's utils
 * (DD MM YYYY YY HH hh mm ss a MMM MMMM DDD DDDD), so a pattern lifted from a
 * production molecule's `date_format` means the same thing here.
 */
export const PIPES: Readonly<Record<string, PipeSpec>> = {
  date: { arity: [1, 2], doc: 'date:"MMM DD, YYYY" or date:"hh:mm a":"Asia/Kolkata" — formatDate tokens; zone defaults to the render\'s' },
  default: { arity: [1], doc: 'default:"—" — used when the value is missing, null or ""' },
};

export interface ResolveOptions {
  /** IANA zone for `date` when the pipe names none. Defaults to UTC, so SSR is deterministic. */
  timeZone?: string;
}

/** `undefined` means "nothing to draw" — the caller decides what that looks like. */
function applyPipe(pipe: Pipe, value: unknown, options: ResolveOptions): unknown {
  switch (pipe.name) {
    case "date": {
      if (value === undefined || value === null || value === "") return value;
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      return formatDate(value, pipe.args[0] ?? "", pipe.args[1] ?? options.timeZone ?? "UTC");
    }
    case "default":
      return isEmpty(value) ? (pipe.args[0] ?? "") : value;
    default:
      return undefined;
  }
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * fanxp's `formatDate`, minus its one environmental input: the zone is always
 * explicit. Theirs falls back to the machine's zone, which makes a server render
 * and a browser render of the same card disagree after midnight UTC.
 *
 * An ISO string with no offset is read as UTC for the same reason — the Date parser
 * would read it in the machine's zone.
 *
 * Returns `undefined` for an unparseable date, so a `default` pipe can catch it.
 */
export function formatDate(input: string | number, pattern: string, timeZone: string): string | undefined {
  const normalized =
    typeof input === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input) ? `${input}Z` : input;
  // Parsing, not reading the clock — `Date.parse` keeps the purity gate honest.
  const ms = typeof normalized === "number" ? normalized : Date.parse(normalized);
  if (Number.isNaN(ms)) return undefined;

  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        weekday: "short",
      })
        .formatToParts(ms)
        .map((p) => [p.type, p.value]),
    );
  } catch {
    return undefined; // an unknown zone
  }

  const h24 = Number(parts.hour) % 24;
  const month = Number(parts.month) - 1;
  const weekday = DAYS.indexOf(parts.weekday ?? "");
  const pad = (n: number) => String(n).padStart(2, "0");

  const tokens: Record<string, string> = {
    DDDD: DAYS_FULL[weekday] ?? "",
    DDD: DAYS[weekday] ?? "",
    DD: parts.day ?? "",
    MMMM: MONTHS_FULL[month] ?? "",
    MMM: MONTHS[month] ?? "",
    MM: parts.month ?? "",
    YYYY: parts.year ?? "",
    YY: (parts.year ?? "").slice(-2),
    HH: pad(h24),
    hh: pad(h24 % 12 || 12),
    mm: parts.minute ?? "",
    ss: parts.second ?? "",
    a: h24 >= 12 ? "PM" : "AM",
  };
  return pattern.replace(/DDDD|DDD|DD|MMMM|MMM|MM|YYYY|YY|HH|hh|mm|ss|a/g, (t) => tokens[t] ?? t);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  value: string;
  /** Refs that could not be drawn — missing path, unknown pipe, or an object where text goes. */
  unresolved: string[];
}

/**
 * Fill every ref in `template` from `scope`.
 *
 * A ref that cannot be drawn is left as its literal text and reported. Never
 * the string "undefined", "null" or "[object Object]": a present-but-null field
 * draws as nothing, which is what a CAST payload's `duration: null` means.
 */
export function resolveTemplate(template: string, scope: unknown, options: ResolveOptions = {}): ResolveResult {
  if (!template.includes("{")) return { value: template, unresolved: [] };
  const unresolved: string[] = [];
  const value = template.replace(refRegex(), (whole, path: string, chain: string) => {
    let v = lookup(scope, path);
    for (const pipe of parsePipes(chain)) {
      if (!(pipe.name in PIPES)) {
        v = undefined;
        break;
      }
      v = applyPipe(pipe, v, options);
    }
    if (v === undefined || (typeof v === "object" && v !== null)) {
      unresolved.push(path);
      return whole;
    }
    return v === null ? "" : String(v);
  });
  return { value, unresolved };
}

// ---------------------------------------------------------------------------
// `when` — conditional rendering
// ---------------------------------------------------------------------------

/**
 * A condition on one path, with exactly one operator.
 *
 * `when` takes one condition or a list (all must hold). NOT recursive: no
 * `any`/`all`/`not` nesting, because the agent emits this through a JSON
 * schema and recursive schemas are what structured output fails on (see
 * `flat.ts`). `in` covers OR on one field, `ne`/`exists:false` cover NOT.
 *
 * This is what fanxp's molecules hand-code as `data?.duration && atoms.x.visibility`
 * and `asset_type_id === 4`, and what its analytics bridge already spells as
 * `when: [{ path, equals }]`.
 */
export type Scalar = string | number | boolean | null;

export interface Condition {
  path: string;
  eq?: Scalar;
  ne?: Scalar;
  in?: Scalar[];
  /** true: present (not missing, null, "" or []). false: the opposite. */
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export type Predicate = Condition | Condition[];

export const CONDITION_OPS = ["eq", "ne", "in", "exists", "gt", "gte", "lt", "lte"] as const;

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const conditionSchema = z
  .object({
    path: z.string().regex(PATH_RE, "not a data path"),
    eq: scalarSchema.optional(),
    ne: scalarSchema.optional(),
    in: z.array(scalarSchema).min(1).optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict()
  .refine((c) => CONDITION_OPS.filter((op) => op in c).length === 1, {
    message: `a condition takes exactly one of ${CONDITION_OPS.join(", ")}`,
  });

export const predicateSchema = z.union([conditionSchema, z.array(conditionSchema).min(1)]);

/** The conditions of a `when`, as a list. */
export const conditionsOf = (predicate: Predicate): Condition[] =>
  Array.isArray(predicate) ? predicate : [predicate];

const present = (v: unknown): boolean => !isEmpty(v) && !(Array.isArray(v) && v.length === 0);

export function evaluateCondition(condition: Condition, scope: unknown): boolean {
  const v = lookup(scope, condition.path);
  if (condition.exists !== undefined) return present(v) === condition.exists;
  if ("eq" in condition) return v === condition.eq;
  if ("ne" in condition) return v !== condition.ne;
  if (condition.in) return condition.in.includes(v as Scalar);
  if (typeof v !== "number") return false;
  if (condition.gt !== undefined) return v > condition.gt;
  if (condition.gte !== undefined) return v >= condition.gte;
  if (condition.lt !== undefined) return v < condition.lt;
  if (condition.lte !== undefined) return v <= condition.lte;
  return false;
}

/**
 * Should this node draw? A missing or malformed `when` draws — the validator
 * reports the malformed one (S12); the renderer is not the place to hide it.
 */
export function evaluateWhen(when: unknown, scope: unknown): boolean {
  if (when === undefined || when === null) return true;
  const parsed = predicateSchema.safeParse(when);
  if (!parsed.success) return true;
  return conditionsOf(parsed.data).every((c) => evaluateCondition(c, scope));
}

// ---------------------------------------------------------------------------
// Images — the `{{RATIO}}` slot and relative URLs
// ---------------------------------------------------------------------------

export const RATIO_SLOT = "{{RATIO}}";

/**
 * Crops the SI media CDN serves for `/static-assets/media/{{RATIO}}-<file>`.
 *
 * Measured against dc.surface.fan-os.net on 2026-10-23: each returns a 480px-wide
 * crop of that aspect; `0` returns the 16:9 default; an unlisted ratio (7-5)
 * returns a 1×1 pixel with a 200, so a wrong ratio fails SILENTLY. The list
 * matches the aspect classes in fanxp-web-renderer's `class.config.ts`.
 */
export const CDN_RATIOS = ["16/9", "9/16", "1/1", "2/3", "3/2", "4/3", "3/4", "21/9"] as const;

/**
 * Fill the CDN's `{{RATIO}}` slot from an Image's `ratio` — `16/9` → `16-9`,
 * none → `0`, as fanxp's `resolveRatioToken` does. A URL without the slot is
 * returned unchanged.
 */
export function fillImageRatio(url: string, ratio: string | undefined): string {
  if (!url.includes(RATIO_SLOT)) return url;
  const token = ratio && ratio !== "auto" ? ratio.replace(/\s/g, "").replace(/[/:]/, "-") : "0";
  return url.split(RATIO_SLOT).join(token);
}

/**
 * Root-relative URLs from a CAST payload (`/static-assets/…`, `/news/…`) are
 * relative to the TENANT's site, not to wherever the tree is being rendered —
 * a Studio preview on localhost would otherwise request its own origin.
 */
export function absolutize(url: string, origin: string | undefined): string {
  if (!origin || !url.startsWith("/") || url.startsWith("//")) return url;
  return `${origin.replace(/\/+$/, "")}${url}`;
}
