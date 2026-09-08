import type { Body } from "planck";
import { bodyBoundsPx, type AfterRender } from "./physics";
import { scaleBody } from "./shapes";
import { toPixels, type Point } from "./units";

const BOX_PADDING = 6;
const HANDLE_SIZE = 10;
const HANDLE_HIT_RADIUS = 9;
const MIN_WIDTH = 12;

/** Distance of the rotation knob above the top edge of the box. */
const ROTATE_OFFSET = 24;
const ROTATE_KNOB_RADIUS = 6;
const ROTATE_HIT_RADIUS = 10;
/** Shift-drag rotation snaps to this step (15 degrees). */
const ROTATE_SNAP = Math.PI / 12;

const ACCENT = "#3b6fe0";

interface Handle {
  kind: "scale" | "rotate";
  x: number;
  y: number;
  cursor: string;
}

type Interaction = "none" | "scale" | "rotate";

export interface SelectionOptions {
  canvas: HTMLCanvasElement;
  getSize(): { w: number; h: number };
  /** Selection and editing are only available while the simulation is paused. */
  isPaused(): boolean;
  /** Called when the selection changes, and every frame while a body is selected (for readouts). */
  onSelectionUpdate(body: Body | null): void;
  onAfterRender(cb: AfterRender): void;
}

export interface Selection {
  readonly selected: Body | null;
  /** Select a body. Ignored unless paused. */
  select(body: Body): void;
  deselect(): void;
  /** True while a handle drag (scale or rotate) is in progress. */
  readonly isInteracting: boolean;
}

export function createSelection({
  canvas,
  getSize,
  isPaused,
  onSelectionUpdate,
  onAfterRender,
}: SelectionOptions): Selection {
  let selected: Body | null = null;

  // Handle drag state
  let interaction: Interaction = "none";
  // scale
  let startDist = 0;
  let startWidth = 0;
  let applied = 1;
  // rotate
  let startPointerAngle = 0;
  let startBodyAngle = 0;

  function select(body: Body): void {
    if (!isPaused() || body === selected) return;
    selected = body;
    onSelectionUpdate(selected);
  }

  function deselect(): void {
    if (!selected) return;
    selected = null;
    interaction = "none";
    canvas.style.cursor = "";
    onSelectionUpdate(null);
  }

  function boxRect(body: Body): { x: number; y: number; w: number; h: number } {
    const { min, max } = bodyBoundsPx(body);
    return {
      x: min.x - BOX_PADDING,
      y: min.y - BOX_PADDING,
      w: max.x - min.x + BOX_PADDING * 2,
      h: max.y - min.y + BOX_PADDING * 2,
    };
  }

  function handles(body: Body): Handle[] {
    const r = boxRect(body);
    return [
      { kind: "scale", x: r.x, y: r.y, cursor: "nwse-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y, cursor: "nesw-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y + r.h, cursor: "nwse-resize" },
      { kind: "scale", x: r.x, y: r.y + r.h, cursor: "nesw-resize" },
      { kind: "rotate", x: r.x + r.w / 2, y: r.y - ROTATE_OFFSET, cursor: "grab" },
    ];
  }

  function hitHandle(point: Point): Handle | null {
    if (!selected || !isPaused()) return null;
    for (const handle of handles(selected)) {
      if (handle.kind === "rotate") {
        if (Math.hypot(point.x - handle.x, point.y - handle.y) <= ROTATE_HIT_RADIUS) return handle;
      } else if (
        Math.abs(point.x - handle.x) <= HANDLE_HIT_RADIUS &&
        Math.abs(point.y - handle.y) <= HANDLE_HIT_RADIUS
      ) {
        return handle;
      }
    }
    return null;
  }

  function canvasPoint(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function maxWidth(): number {
    const { w, h } = getSize();
    return Math.min(w, h) * 0.6;
  }

  function pointerAngle(p: Point, body: Body): number {
    const pos = body.getPosition();
    return Math.atan2(p.y - toPixels(pos.y), p.x - toPixels(pos.x));
  }

  // --- Rendering -------------------------------------------------------------------------------

  onAfterRender((ctx) => {
    if (!selected) return;
    const r = boxRect(selected);

    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);

    ctx.fillStyle = "#ffffff";
    for (const h of handles(selected)) {
      if (h.kind === "rotate") {
        ctx.beginPath();
        ctx.moveTo(h.x, r.y);
        ctx.lineTo(h.x, h.y + ROTATE_KNOB_RADIUS);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h.x, h.y, ROTATE_KNOB_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      }
    }
    ctx.restore();

    onSelectionUpdate(selected);
  });

  // --- Handle interaction ----------------------------------------------------------------------

  function onMove(event: MouseEvent): void {
    if (interaction === "none" || !selected) return;
    const p = canvasPoint(event);

    if (interaction === "scale") {
      const pos = selected.getPosition();
      const dist = Math.hypot(p.x - toPixels(pos.x), p.y - toPixels(pos.y));
      const desiredWidth = Math.min(Math.max(startWidth * (dist / startDist), MIN_WIDTH), maxWidth());
      const total = desiredWidth / startWidth;
      const factor = total / applied;

      if (Math.abs(factor - 1) > 1e-4) {
        scaleBody(selected, factor);
        applied = total;
      }
      return;
    }

    let angle = startBodyAngle + (pointerAngle(p, selected) - startPointerAngle);
    if (event.shiftKey) {
      angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
    }
    if (angle !== selected.getAngle()) {
      selected.setAngle(angle);
      selected.synchronizeFixtures();
    }
  }

  function onUp(): void {
    interaction = "none";
    canvas.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  // Capture phase so this runs before the input module's listener.
  canvas.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || !selected) return;
      const p = canvasPoint(event);
      const handle = hitHandle(p);
      if (!handle) return;

      event.stopImmediatePropagation();
      event.preventDefault();

      if (handle.kind === "scale") {
        const pos = selected.getPosition();
        startDist = Math.max(Math.hypot(p.x - toPixels(pos.x), p.y - toPixels(pos.y)), 1);
        const bounds = bodyBoundsPx(selected);
        startWidth = bounds.max.x - bounds.min.x;
        applied = 1;
        interaction = "scale";
      } else {
        startPointerAngle = pointerAngle(p, selected);
        startBodyAngle = selected.getAngle();
        interaction = "rotate";
        canvas.style.cursor = "grabbing";
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    { capture: true },
  );

  canvas.addEventListener("mousemove", (event) => {
    if (interaction !== "none" || event.buttons !== 0) return;
    const handle = hitHandle(canvasPoint(event));
    canvas.style.cursor = handle ? handle.cursor : "";
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") deselect();
  });

  return {
    get selected() {
      return selected;
    },
    get isInteracting() {
      return interaction !== "none";
    },
    select,
    deselect,
  };
}
