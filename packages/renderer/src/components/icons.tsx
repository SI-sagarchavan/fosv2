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

/** Ticket stub, for the GET TICKETS button — notched sides, dashed perforation. */
const Ticket: IconRenderer = ({ size, color, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 16 14" fill="none" aria-hidden>
    <path d="M1.6 2.2h12.8a.8.8 0 0 1 .8.8v1.6a2.4 2.4 0 0 0 0 4.8V11a.8.8 0 0 1-.8.8H1.6A.8.8 0 0 1 .8 11V9.4a2.4 2.4 0 0 0 0-4.8V3a.8.8 0 0 1 .8-.8z"
      stroke={color ?? "currentColor"} strokeWidth="1.1" fill="none" />
    {/* The perforation: a dashed divider down the middle — stub, bar, stub. */}
    <path d="M8 2.4v1.4M8 5.3v3.4M8 10.2v1.4" stroke={color ?? "currentColor"} strokeWidth="1.1" strokeLinecap="round" />
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

/**
 * The interface set: the glyphs a compiled design asks for by name.
 *
 * These are not brand artwork, which is why they belong in code rather than in
 * an asset store. Every one of them appeared on the fan-preferences page as a
 * dashed "?" — four disclosure chevrons, five remove buttons, an add, an edit
 * and a sign-out — because the registry held only the seven match-context
 * glyphs the fixtures page needed. A control the user is meant to press is not
 * something to render a placeholder for.
 *
 * Stroked, 1.5 at 16px, round caps: the same weight as `Check` above, so a row
 * mixing them does not look like two icon sets.
 */
const stroke = (color?: string) => ({
  stroke: color ?? "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
});

const Frame = ({
  size,
  className,
  children,
}: {
  size: number;
  className?: string;
  children: ReactElement | ReactElement[];
}) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    {children}
  </svg>
);

const ChevronRight: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M6 3.5 10.5 8 6 12.5" {...stroke(color)} />
  </Frame>
);

const ChevronLeft: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M10 3.5 5.5 8 10 12.5" {...stroke(color)} />
  </Frame>
);

const ChevronDown: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M3.5 6 8 10.5 12.5 6" {...stroke(color)} />
  </Frame>
);

const ChevronUp: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M3.5 10 8 5.5 12.5 10" {...stroke(color)} />
  </Frame>
);

/** Remove. A bare rule — the enclosing circle is the button's surface, not the glyph. */
const Minus: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M4 8h8" {...stroke(color)} />
  </Frame>
);

const Plus: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M8 4v8M4 8h8" {...stroke(color)} />
  </Frame>
);

const X: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M4 4l8 8M12 4l-8 8" {...stroke(color)} />
  </Frame>
);

/** Edit — a pencil on the diagonal, nib at bottom-left. */
const Pencil: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M11.2 2.4a1.4 1.4 0 0 1 2 2L5.5 12.1 2.6 13l.9-2.9 7.7-7.7Z" {...stroke(color)} />
    <path d="M10 3.6l2.4 2.4" {...stroke(color)} />
  </Frame>
);

/** Sign out — a door with an arrow leaving it. */
const SignOut: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M9.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5.5" {...stroke(color)} />
    <path d="M10 5.5 13 8l-3 2.5M6.5 8H13" {...stroke(color)} />
  </Frame>
);

/** Search. */
const Search: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <circle cx="7" cy="7" r="4" {...stroke(color)} />
    <path d="M10 10l3 3" {...stroke(color)} />
  </Frame>
);

/** A shaft and a head. Carousel controls are these inside a ring, not chevrons. */
const ArrowLeft: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M13.5 8H2.8M7.2 3.6 2.8 8l4.4 4.4" {...stroke(color)} strokeWidth={1.25} />
  </Frame>
);

const ArrowRight: IconRenderer = ({ size, color, className }) => (
  <Frame size={size} className={className}>
    <path d="M2.5 8h10.7M8.8 3.6 13.2 8l-4.4 4.4" {...stroke(color)} strokeWidth={1.25} />
  </Frame>
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

  // The interface set. See the block above.
  arrow_left: ArrowLeft,
  arrow_right: ArrowRight,
  chevron_right: ChevronRight,
  chevron_left: ChevronLeft,
  chevron_down: ChevronDown,
  chevron_up: ChevronUp,
  minus: Minus,
  plus: Plus,
  x: X,
  close: X,
  pencil: Pencil,
  pencil_simple: Pencil,
  edit: Pencil,
  sign_out: SignOut,
  signout: SignOut,
  search: Search,
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
