import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface TreeItem {
  id: string;
  parent: string | null;
  depth: number;
}

/**
 * A collapsible tree over a PRE-ORDER list.
 *
 * Both trees arrive as flat lists in document order with a depth, so hiding a
 * subtree is "skip rows until the depth comes back" — no recursion, no nested
 * components, and 3,000 rows is 3,000 divs. When a filter is active the
 * collapse state is ignored and every match shows, indented as it was, because
 * a match inside a collapsed branch that stays hidden is a search that lies.
 */
export function TreePane<T extends TreeItem>({
  items,
  selected,
  onSelect,
  render,
  filtered,
  collapsedAtDepth = 99,
}: {
  items: readonly T[];
  selected: string | null;
  onSelect: (id: string) => void;
  render: (item: T) => ReactNode;
  /** When set, only these ids show and collapse is bypassed. */
  filtered?: ReadonlySet<string> | null;
  /** Branches at this depth or deeper start collapsed. */
  collapsedAtDepth?: number;
}) {
  const hasKids = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.parent) set.add(i.parent);
    return set;
  }, [items]);

  const [closed, setClosed] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const i of items) if (i.depth >= collapsedAtDepth && hasKids.has(i.id)) set.add(i.id);
    return set;
  });

  // The selected node must be visible, or selecting it from another tab shows nothing.
  const ancestors = useMemo(() => {
    const parentOf = new Map(items.map((i) => [i.id, i.parent]));
    const out: string[] = [];
    let cur = selected ? parentOf.get(selected) : null;
    while (cur) {
      out.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return out;
  }, [items, selected]);

  useEffect(() => {
    if (ancestors.length === 0) return;
    setClosed((prev) => {
      if (!ancestors.some((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      for (const a of ancestors) next.delete(a);
      return next;
    });
  }, [ancestors]);

  const visible = useMemo(() => {
    if (filtered) return items.filter((i) => filtered.has(i.id));
    const out: T[] = [];
    let hideBelow: number | null = null;
    for (const item of items) {
      if (hideBelow !== null) {
        if (item.depth > hideBelow) continue;
        hideBelow = null;
      }
      out.push(item);
      if (closed.has(item.id)) hideBelow = item.depth;
    }
    return out;
  }, [items, closed, filtered]);

  const selectedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, visible.length]);

  function toggle(id: string): void {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (visible.length === 0) return <p className="tree-empty">Nothing matches.</p>;

  return (
    <div className="tree" role="tree">
      {visible.map((item) => {
        const isOpen = !closed.has(item.id);
        const branch = hasKids.has(item.id) && !filtered;
        return (
          <div
            key={item.id}
            role="treeitem"
            aria-selected={item.id === selected}
            ref={item.id === selected ? selectedRef : undefined}
            className={item.id === selected ? "tree-row is-selected" : "tree-row"}
            style={{ paddingInlineStart: 8 + (filtered ? 0 : item.depth) * 14 }}
            onClick={() => onSelect(item.id)}
          >
            {branch ? (
              <button
                className="tree-twist"
                aria-label={isOpen ? "Collapse" : "Expand"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(item.id);
                }}
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tree-twist is-leaf" />
            )}
            {render(item)}
          </div>
        );
      })}
    </div>
  );
}
