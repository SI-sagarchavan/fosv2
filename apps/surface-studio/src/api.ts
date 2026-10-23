import { useCallback, useEffect, useRef, useState } from "react";
import type { BindingsResult, InspectResult, PlanWire } from "./inspect-types.js";

/**
 * Where an inspection reads its IR from.
 *
 * `export` sends the artifact id — the board already holds it and the bytes are
 * stored. `inline` sends the document itself, which is what lets the Playground
 * work with only this process running.
 */
export type Source =
  | { kind: "export"; irArtifact: string; key: string }
  | { kind: "inline"; ir: unknown; key: string; name: string };

export type Loadable<T> =
  | { state: "idle" }
  | { state: "loading"; data?: T }
  | { state: "ready"; data: T }
  | { state: "error"; message: string; data?: T };

function sourceBody(source: Source): Record<string, unknown> {
  return source.kind === "export" ? { irArtifact: source.irArtifact } : { ir: source.ir };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error((parsed as { message?: string }).message ?? `${response.status} ${response.statusText}`);
  }
  return parsed as T;
}

/**
 * A result is a pure function of (IR, theme, compiler), and the IR is immutable
 * for an export — so switching tabs, which unmounts and remounts the view, must
 * not recompile. Session-long cache by source key; `reload` is the way out.
 */
const inspections = new Map<string, InspectResult>();

export function useInspect(source: Source | null): Loadable<InspectResult> & { reload(): void } {
  const [value, setValue] = useState<Loadable<InspectResult>>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!source) {
      setValue({ state: "idle" });
      return;
    }
    const cached = tick === 0 ? inspections.get(source.key) : undefined;
    if (cached) {
      setValue({ state: "ready", data: cached });
      return;
    }

    const mine = ++seq.current;
    setValue((v) => ({ state: "loading", ...("data" in v && v.data ? { data: v.data } : {}) }));
    post<InspectResult>("/v1/inspect", { ...sourceBody(source), render: true })
      .then((data) => {
        if (mine !== seq.current) return;
        inspections.set(source.key, data);
        setValue({ state: "ready", data });
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setValue({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, [source?.key, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...value, reload };
}

export interface BindingsRequestState {
  data: Record<string, unknown> | undefined;
  plan: PlanWire;
}

/** Debounced: this fires while someone types into the sample editor. */
export function useBindings(
  source: Source | null,
  request: BindingsRequestState,
  render: boolean,
): Loadable<BindingsResult & { themeSource?: string }> {
  const [value, setValue] = useState<Loadable<BindingsResult & { themeSource?: string }>>({ state: "idle" });
  const seq = useRef(0);
  const signature = JSON.stringify([source?.key, request.data, request.plan, render]);

  useEffect(() => {
    if (!source) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      setValue((v) => ({ state: "loading", ...("data" in v && v.data ? { data: v.data } : {}) }));
      post<BindingsResult & { themeSource?: string }>("/v1/bindings", {
        ...sourceBody(source),
        ...(request.data ? { data: request.data } : {}),
        plan: request.plan,
        render,
      })
        .then((data) => {
          if (mine === seq.current) setValue({ state: "ready", data });
        })
        .catch((err: unknown) => {
          if (mine === seq.current) setValue({ state: "error", message: err instanceof Error ? err.message : String(err) });
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return value;
}

export async function fetchDatasets(): Promise<{ datasets: string[]; available: boolean }> {
  const response = await fetch("/v1/datasets");
  return (await response.json()) as { datasets: string[]; available: boolean };
}

export async function fetchDataset(name: string): Promise<unknown> {
  const response = await fetch(`/v1/datasets/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`dataset ${name}: ${response.status}`);
  return response.json();
}

export async function setExportStatus(id: string, status: "received" | "dismissed"): Promise<void> {
  const response = await fetch(`/v1/exports/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `${response.status} ${response.statusText}`);
  }
}
