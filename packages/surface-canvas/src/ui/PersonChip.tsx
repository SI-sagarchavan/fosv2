/**
 * A person, as a chip. The name never lives in the change line.
 *
 * `nameless` is the same chip with the label dropped — used where the line is
 * already carrying one name and the rest are presence, not attribution.
 */
import type { JSX } from "react";
import type { ActivityActor } from "../health/activity.js";
import { firstName, initialOf } from "../health/activity.js";

export function PersonChip({
  actor,
  mine = false,
  nameless = false,
}: {
  actor: ActivityActor;
  mine?: boolean;
  nameless?: boolean;
}): JSX.Element {
  const classes = ["person"];
  if (mine) classes.push("person-mine");
  if (nameless) classes.push("person-bare");

  return (
    <span
      className={classes.join(" ")}
      title={mine ? `${actor.name} (you)` : actor.name}
    >
      <span className="person-initial" style={{ background: actor.color }}>
        {initialOf(actor.name)}
      </span>
      {nameless ? null : <span className="person-name">{firstName(actor.name)}</span>}
    </span>
  );
}
