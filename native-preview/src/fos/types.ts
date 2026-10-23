/** A bundled page: the flat DSL tree plus every token already resolved to a concrete value. */

export interface FlatNode {
  id: string;
  type: string;
  parent: string | null;
  idx: number;
  src?: string;
  props: Record<string, any>;
}

export interface TypeSpec {
  size: number;
  weight: number;
  family: string;
  lineHeight: number;
  letterSpacing: number; // em
}

export interface SurfaceLayer {
  type: "color" | "gradient" | "image";
  color?: string;
  degree?: number;
  stops?: { color: string; at: number }[];
  uri?: string;
  fit?: string;
  opacity?: number;
}

export interface Surface {
  layers: SurfaceLayer[];
  radius?: number;
  border?: { width: number; color?: string; style?: string };
  shadow?: string;
}

export interface FontInfo {
  name: string;
  pkg: string;
  ascent: number;
  descent: number;
  capHeight: number;
}

export interface Page {
  name: string;
  width: number;
  /** The page width the design was made for — breakpoints key off this, not the section's width. */
  viewport?: number;
  nodes: FlatNode[];
  tokens: {
    color: Record<string, string>;
    space: Record<string, number>;
    radius: Record<string, number>;
    opacity: Record<string, number>;
    gradient: Record<string, { degree: number; stops: { color: string; at: number }[] }>;
    shadow: Record<string, string>;
    type: Record<string, Record<"mobile" | "tablet" | "desktop", TypeSpec>>;
    surface: Record<string, Surface>;
  };
  fonts: Record<string, FontInfo>;
}
