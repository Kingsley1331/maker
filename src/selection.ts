import type { Body, Joint } from "planck";
import { connectedBodies, groupBoundsPx, rotateGroup, scaleGroup, translateGroup } from "./group";
import { bodyBoundsPx, type AfterRender } from "./physics";
import type { ActiveTool } from "./ui";
import { vecToMeters, type Point } from "./units";

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
  getZoom(): number;
  getActiveTool(): ActiveTool;
  isSpray(): boolean;
  screenToWorld(p: Point): Point;
  /** Selection and editing are only available while the simulation is paused. */
  isPaused(): boolean;
  /**
   * Called when the selection changes, and every frame while something is selected (for
   * readouts). `members` is every selected shape: one body, or the whole jointed group.
   */
  onSelectionUpdate(body: Body | null, members: Body[]): void;
  /** Called when the selected motor joint changes (not every frame). */
  onJointSelectionUpdate(joint: Joint | null): void;
  onAfterRender(cb: AfterRender): void;
}

export interface Selection {
  /** The clicked (primary) body, or null. */
  readonly selected: Body | null;
  /** Every body being edited: `[selected]` alone, or the whole jointed group. */
  readonly members: readonly Body[];
  readonly selectedJoint: Joint | null;
  /**
   * Select a body. Ignored unless paused. Clears any selected joint. Shapes connected by joints
   * select as a group; selecting a member of the selected group narrows to that shape, and
   * selecting it again widens back to the group.
   */
  select(body: Body): void;
  /** Select a motor joint. Ignored unless paused. Clears any selected body. */
  selectJoint(joint: Joint): void;
  deselect(): void;
  /** Move everything selected by `dPx` pixels. */
  translate(dPx: Point): void;
  /** True while a handle drag (scale or rotate) is in progress. */
  readonly isInteracting: boolean;
}

export function createSelection({
  canvas,
  getSize,
  getZoom,
  getActiveTool,
  isSpray,
  screenToWorld,
  isPaused,
  onSelectionUpdate,
  onJointSelectionUpdate,
  onAfterRender,
}: SelectionOptions): Selection {
  let selected: Body | null = null;
  /** Bodies being edited. Empty when nothing is selected. */
  let members: Body[] = [];
  /** Whether `members` is the whole jointed group or just `selected`. */
  let mode: "group" | "body" = "body";
  let selectedJoint: Joint | null = null;

  // Handle drag state
  let interaction: Interaction = "none";
  /** Pivot (px) for the current scale / rotate drag: the box centre at press time. */
  let pivot: Point = { x: 0, y: 0 };
  // scale
  let startDist = 0;
  let startWidth = 0;
  let applied = 1;
  // rotate
  let lastPointerAngle = 0;
  let accumulated = 0;
  let snappedApplied = 0;

  function select(body: Body): void {
    if (!isPaused()) return;
    const jointChanged = selectedJoint !== null;
    selectedJoint = null;

    const group = connectedBodies(body);
    if (group.length <= 1) {
      // Unjointed shape: plain single selection.
      if (body === selected && mode === "body" && !jointChanged) return;
      selected = body;
      members = [body];
      mode = "body";
    } else if (mode === "group" && members.includes(body)) {
      // Click on a member of the selected group narrows to that shape.
      selected = body;
      members = [body];
      mode = "body";
    } else if (mode === "body" && body === selected) {
      // Click on the individually selected shape widens back to its group.
      members = group;
      mode = "group";
    } else {
      selected = body;
      members = group;
      mode = "group";
    }
    onSelectionUpdate(selected, members);
    if (jointChanged) onJointSelectionUpdate(null);
  }

  function selectJoint(joint: Joint): void {
    if (!isPaused() || joint === selectedJoint) return;
    const bodyChanged = selected !== null;
    selected = null;
    members = [];
    mode = "body";
    interaction = "none";
    canvas.style.cursor = "";
    selectedJoint = joint;
    if (bodyChanged) onSelectionUpdate(null, []);
    onJointSelectionUpdate(joint);
  }

  function deselect(): void {
    if (!selected && !selectedJoint) return;
    selected = null;
    members = [];
    mode = "body";
    selectedJoint = null;
    interaction = "none";
    canvas.style.cursor = "";
    onSelectionUpdate(null, []);
    onJointSelectionUpdate(null);
  }

  function rectOf(bounds: { min: Point; max: Point }): { x: number; y: number; w: number; h: number } {
    const { min, max } = bounds;
    return {
      x: min.x - BOX_PADDING,
      y: min.y - BOX_PADDING,
      w: max.x - min.x + BOX_PADDING * 2,
      h: max.y - min.y + BOX_PADDING * 2,
    };
  }

  /** Box around everything selected. */
  function boxRect(): { x: number; y: number; w: number; h: number } {
    return rectOf(groupBoundsPx(members));
  }

  function boxCentre(): Point {
    const r = boxRect();
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function handles(): Handle[] {
    const r = boxRect();
    return [
      { kind: "scale", x: r.x, y: r.y, cursor: "nwse-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y, cursor: "nesw-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y + r.h, cursor: "nwse-resize" },
      { kind: "scale", x: r.x, y: r.y + r.h, cursor: "nesw-resize" },
      { kind: "rotate", x: r.x + r.w / 2, y: r.y - ROTATE_OFFSET, cursor: "grab" },
    ];
  }

  function hitHandle(point: Point): Handle | null {
    if (members.length === 0 || !isPaused()) return null;
    for (const handle of handles()) {
      if (handle.kind === "rotate") {
        if (Math.hypot(point.x - handle.x, point.y - handle.y) <= ROTATE_HIT_RADIUS / getZoom()) {
          return handle;
        }
      } else if (
        Math.abs(point.x - handle.x) <= HANDLE_HIT_RADIUS / getZoom() &&
        Math.abs(point.y - handle.y) <= HANDLE_HIT_RADIUS / getZoom()
      ) {
        return handle;
      }
    }
    return null;
  }

  function canvasPoint(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  function maxWidth(): number {
    const { w, h } = getSize();
    return Math.min(w, h) * 0.6;
  }

  function pointerAngle(p: Point): number {
    return Math.atan2(p.y - pivot.y, p.x - pivot.x);
  }

  function translate(dPx: Point): void {
    if (members.length === 0) return;
    translateGroup(members, vecToMeters(dPx));
  }

  // --- Rendering -------------------------------------------------------------------------------

  onAfterRender((ctx) => {
    if (!selected || members.length === 0) return;
    const r = boxRect();

    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    if (mode === "group") {
      // Faint box per member so the individual shapes stay legible inside the group box.
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const body of members) {
        const m = rectOf(bodyBoundsPx(body));
        ctx.strokeRect(m.x + 3, m.y + 3, m.w - 6, m.h - 6);
      }
      ctx.restore();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = "#ffffff";
    for (const h of handles()) {
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

    onSelectionUpdate(selected, members);
  });

  // --- Handle interaction ----------------------------------------------------------------------

  function onMove(event: MouseEvent): void {
    if (interaction === "none" || members.length === 0) return;
    const p = canvasPoint(event);
    const pivotM = vecToMeters(pivot);

    if (interaction === "scale") {
      const dist = Math.hypot(p.x - pivot.x, p.y - pivot.y);
      const desiredWidth = Math.min(Math.max(startWidth * (dist / startDist), MIN_WIDTH), maxWidth());
      const total = desiredWidth / startWidth;
      const factor = total / applied;

      if (Math.abs(factor - 1) > 1e-4) {
        scaleGroup(members, pivotM, factor);
        applied = total;
      }
      return;
    }

    // Rotate: accumulate pointer travel around the pivot, optionally snapped to 15 degrees.
    const angle = pointerAngle(p);
    let delta = angle - lastPointerAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    else if (delta < -Math.PI) delta += Math.PI * 2;
    lastPointerAngle = angle;
    accumulated += delta;

    const target = event.shiftKey ? Math.round(accumulated / ROTATE_SNAP) * ROTATE_SNAP : accumulated;
    const step = target - snappedApplied;
    if (step !== 0) {
      rotateGroup(members, pivotM, step);
      snappedApplied = target;
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
      if (event.button !== 0 || members.length === 0) return;
      if (getActiveTool().kind === "zoom" || isSpray()) return;
      const p = canvasPoint(event);
      const handle = hitHandle(p);
      if (!handle) return;

      event.stopImmediatePropagation();
      event.preventDefault();

      pivot = boxCentre();
      if (handle.kind === "scale") {
        startDist = Math.max(Math.hypot(p.x - pivot.x, p.y - pivot.y), 1);
        const bounds = groupBoundsPx(members);
        startWidth = Math.max(bounds.max.x - bounds.min.x, 1);
        applied = 1;
        interaction = "scale";
      } else {
        lastPointerAngle = pointerAngle(p);
        accumulated = 0;
        snappedApplied = 0;
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
    if (getActiveTool().kind === "zoom" || isSpray()) return;
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
    get members() {
      return members;
    },
    get selectedJoint() {
      return selectedJoint;
    },
    get isInteracting() {
      return interaction !== "none";
    },
    select,
    selectJoint,
    deselect,
    translate,
  };
}
