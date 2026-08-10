/**
 * Inline SVG icon registry.
 *
 * Unknown names render a visible placeholder glyph AND emit a console warning —
 * never fail silently, never render nothing.
 */

import type { CSSProperties, ReactElement } from "react";

export type IconRenderer = (props: { size: number; color?: string; className?: string }) => ReactElement;

/**
 * Captain is the letter C, not a star — that is what the badge shows in the
 * design, and cricket captaincy is universally marked with the letter.
 * Drawn as a path rather than <text> so it cannot depend on a webfont loading.
 */
const Captain: IconRenderer = ({ size, color, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <path
      d="M11.1 4.7A4.4 4.4 0 1 0 11.1 11.3"
      stroke={color ?? "currentColor"}
      strokeWidth="2.6"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

/** Overseas player — an aeroplane, banking up-right as in the design. */
const Plane: IconRenderer = ({ size, color, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <path
      d="M14.4 1.6a1.4 1.4 0 0 0-2 0l-2.3 2.3-6.4-1.8a.6.6 0 0 0-.6.16l-.9.9a.6.6 0 0 0 .12.94l4.9 2.9-2.2 2.2-2.1-.3a.6.6 0 0 0-.5.17l-.6.6a.6.6 0 0 0 .13.95l2.3 1.3 1.3 2.3a.6.6 0 0 0 .95.13l.6-.6a.6.6 0 0 0 .17-.5l-.3-2.1 2.2-2.2 2.9 4.9a.6.6 0 0 0 .94.12l.9-.9a.6.6 0 0 0 .16-.6l-1.8-6.4 2.3-2.3a1.4 1.4 0 0 0 0-2z"
      fill={color ?? "currentColor"}
    />
  </svg>
);

const Globe: IconRenderer = ({ size, color, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <circle cx="8" cy="8" r="6" stroke={color ?? "currentColor"} strokeWidth="1.5" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" stroke={color ?? "currentColor"} strokeWidth="1.25" />
    <path d="M2 8h12M3.5 5h9M3.5 11h9" stroke={color ?? "currentColor"} strokeWidth="1.25" />
  </svg>
);

/** Video play button: red disc with a white triangle, on a lighter ring. */
const Play: IconRenderer = ({ size, color, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
    <circle cx="30" cy="30" r="29" stroke={color ?? "currentColor"} strokeWidth="1.5" opacity="0.55" />
    <circle cx="30" cy="30" r="20" fill={color ?? "currentColor"} />
    <path d="M25.5 22.5l12 7.5-12 7.5z" fill="#ffffff" />
  </svg>
);

/** Arrow pointing up-right, for "view more" style links. */
const ArrowUpRight: IconRenderer = ({ size, color, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
    <path d="M5 13L13 5M13 5H6.5M13 5v6.5" stroke={color ?? "currentColor"} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Ticket stub, for the GET TICKETS button. */
const Ticket: IconRenderer = ({ size, color, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 16 14" fill="none" aria-hidden>
    <path d="M1.6 2.2h12.8a.8.8 0 0 1 .8.8v1.6a2.4 2.4 0 0 0 0 4.8V11a.8.8 0 0 1-.8.8H1.6A.8.8 0 0 1 .8 11V9.4a2.4 2.4 0 0 0 0-4.8V3a.8.8 0 0 1 .8-.8z"
      stroke={color ?? "currentColor"} strokeWidth="1.1" fill="none" />
    <path d="M6.2 4.6v4.8M9.8 4.6v4.8" stroke={color ?? "currentColor"} strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/**
 * Checkmark for a checked checkbox.
 *
 * Figma draws it as a stroked polyline 7.14x4.29 inside a 20x20 box — a wide,
 * shallow tick rather than the tall default — so the viewBox is proportioned to
 * match instead of being square.
 */
const Check: IconRenderer = ({ size, color, className }) => (
  <svg className={className} width={size} height={size * (4.286 / 7.143)} viewBox="0 0 10 6" fill="none" aria-hidden>
    <path
      d="M1 3.1L3.7 5.4 9 1"
      stroke={color ?? "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Unknown: IconRenderer = ({ size, color, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <rect x="1" y="1" width="14" height="14" rx="2" stroke={color ?? "currentColor"} strokeWidth="1.5" strokeDasharray="3 2" />
    <text x="8" y="11" textAnchor="middle" fontSize="9" fill={color ?? "currentColor"}>
      ?
    </text>
  </svg>
);

export const ICON_REGISTRY: Record<string, IconRenderer> = {
  captain: Captain,
  plane: Plane,
  play: Play,
  arrow_up_right: ArrowUpRight,
  ticket: Ticket,
  globe: Globe,
  check: Check,
};

export function renderIcon(
  name: string,
  opts: { size: number; color?: string; className?: string; style?: CSSProperties },
): ReactElement {
  const Glyph = ICON_REGISTRY[name];
  if (!Glyph) {
    console.warn(`[fos-render] unknown icon name "${name}" — rendering placeholder`);
    return (
      <span className={`fos-icon-unknown ${opts.className ?? ""}`} style={opts.style} data-fos-icon={name}>
        <Unknown size={opts.size} color={opts.color} />
      </span>
    );
  }
  return (
    <span className={opts.className} style={opts.style} data-fos-icon={name}>
      <Glyph size={opts.size} color={opts.color} />
    </span>
  );
}
