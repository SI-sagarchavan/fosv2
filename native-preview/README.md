# FanOS native preview

A sample Expo app that renders FanOS DSL pages with a **React Native** renderer (`src/fos/Render.tsx`),
to test how far the web renderer's semantics carry to native.

## How it works

1. `scripts/bundle-page.mjs` turns a published page into a self-contained `pages/<name>.json`, using the
   repo's own packages: binding plan applied, `{data}` interpolated, every token resolved to a concrete
   value, every surface to concrete layers (colour / gradient / image), button families to colours, and
   font metrics read from the TTF files (for cap-height trim). The app needs no Node-only code.
2. `src/fos/Render.tsx` maps DSL nodes to React Native: Stack -> flexbox, Overlay -> absolute children,
   surfaces -> layers under the children (`expo-linear-gradient`, `expo-image`), Text -> `<Text>` with
   cap-height trim from font metrics and vertical orientation by rotation, Button -> `Pressable`.
3. `App.tsx` lists the bundled pages; designs are laid out at their own width and scaled to fit
   (or 1:1 with horizontal scroll). `preview.config.ts` picks the starting page; edits apply live.

## Run

```bash
# 1. bundle a page (needs `pnpm build` in the repo for packages/*/dist)
node scripts/bundle-page.mjs --name squad --url "http://localhost:3000/v1/preview/<run>?tree=..&theme=..&surfaces=..&plan=..&data=.."
#    or from an agent workdir:  --dir <workdir>   (out/2-agent.dsl.json, out/surfaces.json, theme.json ...)

# 2. run
npx expo start --ios      # iOS simulator via Expo Go
npx expo start --web      # React Native Web, quick checks
```

This project installs from the public npm registry (`.npmrc`) and sits outside the pnpm workspace.

## Not yet native

Grid, Carousel, Repeater, Tabs, RichText, Link (render as plain boxes); icons are unicode stand-ins until
the SVG registry is ported with `react-native-svg`; text trim is calibrated to the CSS model and still
needs per-platform tuning against simulator screenshots; `textCase: title` lowercases the rest of each
word on iOS (CSS does not).
