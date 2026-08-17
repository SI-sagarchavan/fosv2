/**
 * Assets tab — drop an image in, and it finds where it belongs.
 *
 * An asset creates `asset.texture.<name>`: a token the compiler emits, the run
 * stores a URL against, and the renderer fetches. Getting one into the pipeline
 * used to mean MARKING Figma layers here — ticking the four layers of a header,
 * ordering them, and having the plugin flatten them itself.
 *
 * That was the wrong shape twice over. It asked the designer to re-describe,
 * inside a panel, a composition Figma already understood. And it re-implemented
 * an exporter Figma already ships — one that honours export settings, scale,
 * effects and clipping, which ours did not.
 *
 * Exporting a region is something designers already do without being asked. So
 * they do that, drag the file in, and the only remaining question — which
 * region was it? — is answered by matching the filename and pixel size against
 * the frame. When that is certain, nothing is asked at all.
 */
import type { DragEvent, JSX } from "react";
import { useState } from "react";
import type { TargetMatch, TargetOption } from "../assets.js";
import { assetRef, type AssetBinding, type AssetFit } from "../ir/schema.js";
import type { AssetPlacement } from "../ir/placement.js";
import { send } from "./main.js";
import type { PanelAction, StudioState } from "./state.js";

const FITS: ReadonlyArray<{ value: AssetFit; label: string; hint: string }> = [
  { value: "cover", label: "Cover", hint: "fills the box, cropping the overflow" },
  { value: "contain", label: "Contain", hint: "fits inside the box, whole" },
  { value: "repeat", label: "Tile", hint: "repeats from the top-left" },
  { value: "none", label: "None", hint: "natural size, no scaling" },
];

export function AssetsTab({
  state,
  dispatch,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  return (
    <div className="scroll">
      <DropZone busy={state.busy} />

      {state.unmapped ? <UnmappedPrompt unmapped={state.unmapped} dispatch={dispatch} /> : null}

      {state.assets.length > 0 ? (
        <div className="section" style={{ paddingTop: 6 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            {state.assets.length} {state.assets.length === 1 ? "asset" : "assets"} in this frame
          </div>
          {state.assets.map((binding) => (
            <AssetRow
              key={binding.imageHash}
              binding={binding}
              placement={state.placements[binding.imageHash]}
              targets={state.targets[binding.imageHash] ?? []}
              busy={state.busy}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Read the dropped files and hand the bytes to the sandbox.
 *
 * The natural size is measured HERE, in the iframe, because the sandbox has no
 * `Image` and no `createImageBitmap` — and the size is half of what identifies
 * the region the file came from. Sending bytes without it would leave the
 * matcher with only the filename to go on.
 */
function DropZone({ busy }: { busy: boolean }): JSX.Element {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(0);

  async function accept(files: readonly File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;

    setReading(images.length);
    try {
      for (const file of images) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const size = await naturalSize(file);
        send({
          type: "upload-asset",
          fileName: file.name,
          bytes,
          width: size.width,
          height: size.height,
        });
      }
    } finally {
      setReading(0);
    }
  }

  return (
    <div className="section">
      <label
        className={`dropzone${over ? " over" : ""}`}
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          void accept([...e.dataTransfer.files]);
        }}
      >
        {/* A file input as well as a drop target: dragging out of Figma's own
            export dialog is fiddly, and some people would rather browse. */}
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          onChange={(e) => {
            void accept([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <div className="dropzone-title">
          {reading > 0
            ? `Reading ${reading} ${reading === 1 ? "image" : "images"}…`
            : "Drop exported images here"}
        </div>
        <div className="muted" style={{ marginTop: 2 }}>
          Export a region from Figma as usual, then drop the file in. Each one is
          matched to the part of the design it came from.
        </div>
      </label>
    </div>
  );
}

/**
 * "Which element is this?" — asked only when the matcher is not sure.
 *
 * A background painted onto the wrong element is harder to notice, and harder
 * to diagnose, than one that was never placed. So an uncertain match asks. The
 * bytes are already in the document, so answering costs a click rather than
 * another drag.
 */
function UnmappedPrompt({
  unmapped,
  dispatch,
}: {
  unmapped: NonNullable<StudioState["unmapped"]>;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  return (
    <div className="section unmapped">
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="grow truncate" style={{ fontWeight: 600 }}>
          Where does “{unmapped.fileName}” go?
        </span>
        <button className="ghost muted" onClick={() => dispatch({ type: "dismiss-unmapped" })}>
          Skip
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        {unmapped.width}×{unmapped.height} px ·{" "}
        {unmapped.candidates.length === 0
          ? "nothing in this frame is that shape or name"
          : "closest matches first"}
      </div>

      {unmapped.candidates.map((candidate) => (
        <Candidate key={candidate.id} candidate={candidate} unmapped={unmapped} />
      ))}
    </div>
  );
}

function Candidate({
  candidate,
  unmapped,
}: {
  candidate: TargetMatch;
  unmapped: NonNullable<StudioState["unmapped"]>;
}): JSX.Element {
  return (
    <button
      className="outline candidate"
      onClick={() =>
        // `place-asset`, not `upload-asset`: the bytes went into the document
        // when the file was dropped, and re-uploading would duplicate them.
        send({
          type: "place-asset",
          imageHash: unmapped.imageHash,
          fileName: unmapped.fileName,
          width: unmapped.width,
          height: unmapped.height,
          targetId: candidate.id,
        })
      }
      onMouseEnter={() => send({ type: "select-nodes", nodeIds: [candidate.id] })}
    >
      <span className="truncate" style={{ fontWeight: 600 }}>
        {candidate.name}
      </span>
      <span className="muted truncate">
        {candidate.width}×{candidate.height} · {candidate.reasons.join(", ")}
      </span>
    </button>
  );
}

function AssetRow({
  binding,
  placement,
  targets,
  busy,
}: {
  binding: AssetBinding;
  placement: AssetPlacement | undefined;
  targets: readonly TargetOption[];
  busy: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const key = binding.imageHash;

  return (
    <div className="asset-row">
      <div className="grow" style={{ minWidth: 0 }}>
        {editing ? (
          <NameField
            name={binding.name}
            onCommit={(name) => {
              setEditing(false);
              if (name !== binding.name) send({ type: "rename-asset", key, name });
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            className="ghost"
            style={{ textAlign: "left", padding: 0, width: "100%" }}
            onClick={() => setEditing(true)}
            title={`${assetRef(binding.name)} — click to rename`}
          >
            <span className="truncate" style={{ fontWeight: 600 }}>
              {binding.name}
            </span>
            {/* An auto-mapping is a guess. Saying so is what lets a designer who
                later finds the wrong region painted know where to look. */}
            {binding.mapping === "auto" ? (
              <span className="pill" style={{ marginLeft: 6 }}>
                auto
              </span>
            ) : null}
          </button>
        )}

        <div className="muted truncate" style={{ marginTop: 2 }}>
          {binding.fileName} · {binding.width}×{binding.height} → {binding.targetName}
        </div>

        <Placement placement={placement} />

        <div className="row" style={{ marginTop: 6, gap: 4, flexWrap: "wrap" }}>
          <FitPicker binding={binding} busy={busy} />
        </div>

        <TargetPicker binding={binding} targets={targets} busy={busy} />
      </div>

      <button
        className="ghost"
        onClick={() => send({ type: "remove-asset", key })}
        title="Stop shipping this image"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Where the bitmap lands, in the words that describe what will be emitted.
 *
 * "Covers" and "placed" are the two branches the compiler takes: a covering
 * asset folds into the target's surface, a placed one stays a positioned node.
 */
function Placement({ placement }: { placement: AssetPlacement | undefined }): JSX.Element | null {
  if (!placement) return null;

  const { covers, offset, size, target } = placement;
  const box = `${Math.round(size.w)}×${Math.round(size.h)}`;

  if (covers) {
    return (
      <div className="muted truncate" style={{ marginTop: 2 }}>
        paints the whole element
      </div>
    );
  }

  return (
    <div className="truncate" style={{ marginTop: 2, color: "var(--fos-warn)" }}>
      {box} at {Math.round(offset.x)},{Math.round(offset.y)} in a {Math.round(target.w)}×
      {Math.round(target.h)} target — placed, not full-bleed
    </div>
  );
}

/** Which element this asset paints, chosen from the target's ancestors. */
function TargetPicker({
  binding,
  targets,
  busy,
}: {
  binding: AssetBinding;
  targets: readonly TargetOption[];
  busy: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (targets.length === 0) return null;

  if (!open) {
    return (
      <button
        className="ghost"
        style={{ marginTop: 6, padding: 0, textAlign: "left" }}
        onClick={() => setOpen(true)}
        title="Choose which element this image paints"
      >
        <span className="muted">change what it paints</span>
      </button>
    );
  }

  return (
    <div className="target-picker">
      {targets.map((target) => {
        const current = target.id === binding.targetId;
        return (
          <button
            key={target.id}
            className={current ? "primary" : "ghost"}
            disabled={busy}
            style={{ width: "100%", textAlign: "left", marginBottom: 2 }}
            onClick={() => {
              setOpen(false);
              if (!current) {
                send({ type: "retarget-asset", key: binding.imageHash, targetId: target.id });
              }
            }}
            onMouseEnter={() => send({ type: "select-nodes", nodeIds: [target.id] })}
            title={`${target.width}×${target.height}`}
          >
            <span className="truncate">
              {"↳ ".repeat(Math.min(target.depth - 1, 3))}
              {target.name}
            </span>
            <span className="muted">
              {" "}
              {target.width}×{target.height}
            </span>
          </button>
        );
      })}
      <button className="ghost muted" style={{ padding: 0 }} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function FitPicker({ binding, busy }: { binding: AssetBinding; busy: boolean }): JSX.Element {
  const current = binding.fit ?? "cover";
  return (
    <>
      {FITS.map((fit) => (
        <button
          key={fit.value}
          className={current === fit.value ? "primary" : "ghost"}
          disabled={busy}
          style={{ padding: "2px 8px" }}
          onClick={() => send({ type: "set-asset-fit", key: binding.imageHash, fit: fit.value })}
          title={fit.hint}
        >
          {fit.label}
        </button>
      ))}
    </>
  );
}

/**
 * Rename, validated on the way in.
 *
 * The sandbox is the authority — it owns the other assets and refuses a
 * collision — but a field that lets you type a space and only complains after a
 * round trip is a worse field.
 */
function NameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(name);

  return (
    <input
      className="name-field"
      autoFocus
      value={value}
      onChange={(event) => setValue(normalizeName(event.target.value))}
      onBlur={() => (value ? onCommit(value) : onCancel())}
      onKeyDown={(event) => {
        if (event.key === "Enter" && value) onCommit(value);
        if (event.key === "Escape") onCancel();
      }}
      spellCheck={false}
      aria-label="Asset name"
    />
  );
}

/** What the token layer will accept, applied while typing rather than after. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "");
}

/**
 * The image's own pixel size.
 *
 * Half of what identifies the region it came from: a 2732x836 file is the
 * 1366x418 header at a 2x export, and no other element in the frame is that
 * shape. Measured with a blob URL rather than `createImageBitmap`, which Figma's
 * iframe does not reliably expose.
 */
function naturalSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    // A size of zero still uploads: the filename alone may identify the layer,
    // and refusing the file outright over an unreadable header helps nobody.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
}
