import type { Body, Joint, World } from "planck";
import {
  alignThreshold,
  collectTargetBounds,
  matchRotate,
  type AlignGuides,
} from "./align-guides";
import { connectedBodies, groupBoundsPx, rotateGroup, scaleGroup, translateGroup } from "./group";
import { bodyBoundsPx, nearestWrapPoint, withWrapOffsets, type AfterRender } from "./physics";
import { isPickable } from "./shapes";
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
  isCut(): boolean;
  isChainOutline(): boolean;
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
  /** World-pixel offsets for wrap copies (identity when wrap is off). */
  getWrapOffsets(): Point[];
  world: World;
  guides: AlignGuides;
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
  /** Select an arbitrary set of pickable bodies (marquee). Ignored unless paused. */
  selectMembers(bodies: readonly Body[]): void;
  /** Select a scene joint. Ignored unless paused. Clears any selected body. */
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
  isCut,
  isChainOutline,
  screenToWorld,
  isPaused,
  onSelectionUpdate,
  onJointSelectionUpdate,
  onAfterRender,
  getWrapOffsets,
  world,
  guides,
}: SelectionOptions): Selection {
  let selected: Body | null = null;
  /** Bodies being edited. Empty when nothing is selected. */
  let members: Body[] = [];
  /** Jointed group, a free marquee set, or a single body. */
  let mode: "group" | "set" | "body" = "body";
  /** Last marquee / free set, used to widen after narrowing to one member. */
  let setMembers: Body[] = [];
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

    if (mode === "set" && members.includes(body)) {
      selected = body;
      members = [body];
      mode = "body";
      onSelectionUpdate(selected, members);
      if (jointChanged) onJointSelectionUpdate(null);
      return;
    }

    if (mode === "body" && body === selected && setMembers.length > 1 && setMembers.includes(body)) {
      members = setMembers.slice();
      mode = "set";
      onSelectionUpdate(selected, members);
      if (jointChanged) onJointSelectionUpdate(null);
      return;
    }

    const group = connectedBodies(body);
    if (group.length <= 1) {
      // Unjointed shape: click again to clear the selection.
      if (body === selected && mode === "body" && !jointChanged) {
        deselect();
        return;
      }
      selected = body;
      members = [body];
      mode = "body";
      setMembers = [];
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
      setMembers = [];
    }
    onSelectionUpdate(selected, members);
    if (jointChanged) onJointSelectionUpdate(null);
  }

  function selectMembers(bodies: readonly Body[]): void {
    if (!isPaused()) return;
    const unique: Body[] = [];
    const seen = new Set<Body>();
    for (const body of bodies) {
      if (!isPickable(body) || seen.has(body)) continue;
      seen.add(body);
      unique.push(body);
    }
    if (unique.length === 0) {
      deselect();
      return;
    }

    const jointChanged = selectedJoint !== null;
    selectedJoint = null;
    selected = unique[0];
    members = unique;
    if (unique.length === 1) {
      setMembers = [];
      mode = "body";
    } else {
      setMembers = unique.slice();
      mode = "set";
    }
    onSelectionUpdate(selected, members);
    if (jointChanged) onJointSelectionUpdate(null);
  }

  function selectJoint(joint: Joint): void {
    if (!isPaused() || joint === selectedJoint) return;
    const bodyChanged = selected !== null;
    selected = null;
    members = [];
    setMembers = [];
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
    setMembers = [];
    mode = "body";
    selectedJoint = null;
    interaction = "none";
    canvas.style.cursor = "";
    guides.clear();
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
    const offsets = getWrapOffsets();
    for (const handle of handles()) {
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        if (handle.kind === "rotate") {
          if (Math.hypot(q.x - handle.x, q.y - handle.y) <= ROTATE_HIT_RADIUS / getZoom()) {
            return handle;
          }
        } else if (
          Math.abs(q.x - handle.x) <= HANDLE_HIT_RADIUS / getZoom() &&
          Math.abs(q.y - handle.y) <= HANDLE_HIT_RADIUS / getZoom()
        ) {
          return handle;
        }
      }
    }
    return null;
  }

  function unwrapToward(point: Point, around: Point): Point {
    return nearestWrapPoint(point, around, getWrapOffsets());
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
    if (!selected || members.length === 0 || isCut()) return;
    const r = boxRect();

    withWrapOffsets(ctx, getWrapOffsets(), () => {
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      if (mode === "group" || mode === "set") {
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
    });

    onSelectionUpdate(selected, members);
  });

  // --- Handle interaction ----------------------------------------------------------------------

  function onMove(event: MouseEvent): void {
    if (interaction === "none" || members.length === 0) return;
    const p = unwrapToward(canvasPoint(event), pivot);
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
    const extra = target - snappedApplied;
    const aligned = matchRotate(
      members,
      pivot,
      extra,
      collectTargetBounds(world, members, pivot, getWrapOffsets()),
      alignThreshold(getZoom()),
      !event.shiftKey,
    );
    const step = extra + aligned.dAngle;
    if (step !== 0) {
      rotateGroup(members, pivotM, step);
      snappedApplied += step;
    }
    guides.set(aligned.lines);
  }

  function onUp(): void {
    interaction = "none";
    canvas.style.cursor = "";
    guides.clear();
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  // Capture phase so this runs before the input module's listener.
  canvas.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || members.length === 0) return;
      if (getActiveTool().kind === "zoom" || isSpray() || isCut() || isChainOutline()) return;
      const raw = canvasPoint(event);
      const handle = hitHandle(raw);
      if (!handle) return;

      event.stopImmediatePropagation();
      event.preventDefault();

      pivot = boxCentre();
      const p = unwrapToward(raw, { x: handle.x, y: handle.y });
      if (handle.kind === "scale") {
        startDist = Math.max(Math.hypot(p.x - pivot.x, p.y - pivot.y), 1);
        const bounds = groupBoundsPx(members);
        startWidth = Math.max(bounds.max.x - bounds.min.x, 1);
        applied = 1;
        interaction = "scale";
        guides.clear();
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
    if (getActiveTool().kind === "zoom" || isSpray() || isCut() || isChainOutline()) return;
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
    selectMembers,
    selectJoint,
    deselect,
    translate,
  };
}
