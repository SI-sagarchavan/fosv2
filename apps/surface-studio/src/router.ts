import { useEffect, useState } from "react";

/**
 * A hash router, because this app is served by Vite's middleware and a refresh
 * on `/export/abc/ir` would otherwise 404 into the proxy's JSON. `#/` survives
 * a reload, a pasted link and a second tab with nothing configured.
 *
 *   #/                         the board
 *   #/export/:id[/:tab]        one export
 *   #/playground[/:tab]        any IR, dropped in
 *   #/pipeline                 how the trip works
 *
 * `?node=` selects a row on the IR and DSL tabs, so a link from a gap lands on
 * the thing it is about.
 */
export interface Route {
  path: string[];
  query: URLSearchParams;
}

function read(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart = "/", queryPart = ""] = hash.split("?");
  return {
    path: pathPart.split("/").filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(queryPart),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export function go(path: string, query?: Record<string, string | undefined>): void {
  window.location.hash = href(path, query).slice(1);
}
