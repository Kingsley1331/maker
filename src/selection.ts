import type { Body, Joint, World } from "planck";
import {
  alignThreshold,
  collectHoleAlignTargets,
  collectTargetBounds,
  matchBounds,
  matchRotate,
  matchRotateHole,
  snapScaleBounds,
  type AlignGuides,
} from "./align-guides";
import {
  connectedBodies,
  groupBoundsPx,
  mirrorGroupHorizontal,
  rotateGroup,
  scaleGroup,
  translateGroup,
} from "./group";
import {
  bodyBoundsPx,
  nearestWrapPoint,
  withWrapOffsets,
  type AfterRender,
} from "./physics";
import {
  holeBoundsPx,
  holeRingPx,
  listVertices,
  moveVertex,
  refsEqual,
  rotateHole,
  scaleHole,
  startVertexDrag,
  translateHole,
  verticesOfDrag,
  type VertexDrag,
  type VertexHandle,
  type VertexRef,
} from "./reshape";
import { isPickable } from "./shapes";
import type { ActiveTool } from "./ui";
import { vecToMeters, type Point } from "./units";

/** Screen pixels; divided by zoom so overlay chrome stays a constant size. */
const BOX_PADDING = 10;
const HANDLE_SIZE = 10;
const HANDLE_HIT_RADIUS = 9;
const MIN_WIDTH = 12;

/** Distance of the rotation knob above the top edge of the box (screen px). */
const ROTATE_OFFSET = 24;
const ROTATE_KNOB_RADIUS = 6;
const ROTATE_HIT_RADIUS = 10;
/** Shift-drag rotation snaps to this step (15 degrees). */
const ROTATE_SNAP = Math.PI / 12;

const ACCENT = "#3b6fe0";
const VERTEX_FILL = "#1c08b5";
const VERTEX_STROKE = "#ffffff";
/** Idle / hover radius in screen pixels (divided by zoom when drawing). */
const VERTEX_RADIUS = 3;
const VERTEX_HOVER_RADIUS = 4.5;
const VERTEX_HIT_RADIUS = 7;

type Handle =
  | { kind: "scale"; x: number; y: number; cursor: string }
  | { kind: "stretch"; axis: "x" | "y"; x: number; y: number; cursor: string }
  | { kind: "rotate"; x: number; y: number; cursor: string }
  | { kind: "mirror"; x: number; y: number; cursor: string };

type Control =
  | { kind: "vertex"; vertex: VertexHandle }
  | { kind: "handle"; handle: Handle };

type Interaction = "none" | "scale" | "stretch" | "rotate" | "vertex" | "move";

export interface SelectionOptions {
  canvas: HTMLCanvasElement;
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
  /**
   * Select one hole on a filled body. Ignored unless paused. The parent body stays in `members`
   * so the property readout still works; gizmos wrap the hole instead of the body.
   */
  selectHole(body: Body, holeIndex: number): void;
  deselect(): void;
  /** Move everything selected by `dPx` pixels. False if a hole move was rejected. */
  translate(dPx: Point): boolean;
  /** Index of the selected hole, or null when the selection is a body / group. */
  readonly selectedHoleIndex: number | null;
  /** True while a handle drag (scale, stretch, rotate, vertex, or hole move) is in progress. */
  readonly isInteracting: boolean;
}

export function createSelection({
  canvas,
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
  /** When set, gizmos wrap this hole on `selected` instead of the body AABB. */
  let selectedHoleIndex: number | null = null;

  // Handle drag state
  let interaction: Interaction = "none";
  /** Pivot (px) for the current scale / stretch / rotate drag: the box centre at press time. */
  let pivot: Point = { x: 0, y: 0 };
  // scale / stretch
  let startDist = 0;
  let startWidth = 0;
  let applied = 1;
  let stretchAxis: "x" | "y" = "x";
  // rotate
  let lastPointerAngle = 0;
  let accumulated = 0;
  let snappedApplied = 0;
  // vertex
  let vertexDrag: VertexDrag | null = null;
  let vertexAround: Point = { x: 0, y: 0 };
  let hoveredVertex: VertexRef | null = null;

  function select(body: Body): void {
    if (!isPaused()) return;
    const jointChanged = selectedJoint !== null;
    selectedJoint = null;

    if (selectedHoleIndex !== null && body === selected && mode === "body") {
      selectedHoleIndex = null;
      onSelectionUpdate(selected, members);
      if (jointChanged) onJointSelectionUpdate(null);
      return;
    }
    selectedHoleIndex = null;

    if (mode === "set" && members.includes(body)) {
      selected = body;
      members = [body];
      mode = "body";
      onSelectionUpdate(selected, members);
      if (jointChanged) onJointSelectionUpdate(null);
      return;
    }

    if (
      mode === "body" &&
      body === selected &&
      setMembers.length > 1 &&
      setMembers.includes(body)
    ) {
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
    selectedHoleIndex = null;
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
    vertexDrag = null;
    hoveredVertex = null;
    selectedHoleIndex = null;
    canvas.style.cursor = "";
    selectedJoint = joint;
    if (bodyChanged) onSelectionUpdate(null, []);
    onJointSelectionUpdate(joint);
  }

  function selectHole(body: Body, holeIndex: number): void {
    if (!isPaused() || !isPickable(body)) return;
    if (holeBoundsPx(body, holeIndex) === null) return;
    const jointChanged = selectedJoint !== null;
    selectedJoint = null;
    selected = body;
    members = [body];
    mode = "body";
    setMembers = [];
    selectedHoleIndex = holeIndex;
    interaction = "none";
    vertexDrag = null;
    hoveredVertex = null;
    onSelectionUpdate(selected, members);
    if (jointChanged) onJointSelectionUpdate(null);
  }

  function deselect(): void {
    if (!selected && !selectedJoint) return;
    selected = null;
    members = [];
    setMembers = [];
    mode = "body";
    selectedJoint = null;
    selectedHoleIndex = null;
    interaction = "none";
    vertexDrag = null;
    hoveredVertex = null;
    canvas.style.cursor = "";
    guides.clear();
    onSelectionUpdate(null, []);
    onJointSelectionUpdate(null);
  }

  function screenPx(px: number): number {
    return px / getZoom();
  }

  function rectOf(bounds: { min: Point; max: Point }): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const { min, max } = bounds;
    const pad = screenPx(BOX_PADDING);
    return {
      x: min.x - pad,
      y: min.y - pad,
      w: max.x - min.x + pad * 2,
      h: max.y - min.y + pad * 2,
    };
  }

  /** Box around the selected hole, or around every selected body. */
  function boxRect(): { x: number; y: number; w: number; h: number } {
    if (selectedHoleIndex !== null && members.length === 1) {
      const bounds = holeBoundsPx(members[0], selectedHoleIndex);
      if (bounds) return rectOf(bounds);
    }
    return rectOf(groupBoundsPx(members));
  }

  function selectedBounds(): { min: Point; max: Point } {
    if (selectedHoleIndex !== null && members.length === 1) {
      const bounds = holeBoundsPx(members[0], selectedHoleIndex);
      if (bounds) return bounds;
    }
    return groupBoundsPx(members);
  }

  function boxCentre(): Point {
    const r = boxRect();
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function handles(): Handle[] {
    const r = boxRect();
    const rotateOffset = screenPx(ROTATE_OFFSET);
    const out: Handle[] = [
      { kind: "scale", x: r.x, y: r.y, cursor: "nwse-resize" },
      { kind: "stretch", axis: "y", x: r.x + r.w / 2, y: r.y, cursor: "ns-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y, cursor: "nesw-resize" },
      { kind: "stretch", axis: "x", x: r.x + r.w, y: r.y + r.h / 2, cursor: "ew-resize" },
      { kind: "scale", x: r.x + r.w, y: r.y + r.h, cursor: "nwse-resize" },
      { kind: "stretch", axis: "y", x: r.x + r.w / 2, y: r.y + r.h, cursor: "ns-resize" },
      { kind: "scale", x: r.x, y: r.y + r.h, cursor: "nesw-resize" },
      { kind: "stretch", axis: "x", x: r.x, y: r.y + r.h / 2, cursor: "ew-resize" },
      {
        kind: "rotate",
        x: r.x + r.w / 2,
        y: r.y - rotateOffset,
        cursor: "grab",
      },
    ];
    if (selectedHoleIndex === null) {
      out.push({
        kind: "mirror",
        x: r.x + r.w / 2,
        y: r.y + r.h + rotateOffset,
        cursor: "pointer",
      });
    }
    return out;
  }

  function hitHandle(point: Point): Handle | null {
    if (members.length === 0 || !isPaused()) return null;
    const offsets = getWrapOffsets();
    for (const handle of handles()) {
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        if (handle.kind === "rotate" || handle.kind === "mirror") {
          if (
            Math.hypot(q.x - handle.x, q.y - handle.y) <=
            ROTATE_HIT_RADIUS / getZoom()
          ) {
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

  function vertexHandles(): VertexHandle[] {
    if (members.length !== 1 || !isPaused()) return [];
    const verts = listVertices(members[0]);
    if (selectedHoleIndex === null) return verts;
    return verts.filter(
      (vertex) => vertex.ref.kind === "hole" && vertex.ref.holeIndex === selectedHoleIndex,
    );
  }

  function hitVertex(point: Point): VertexHandle | null {
    const verts = vertexHandles();
    if (verts.length === 0) return null;
    const radius = VERTEX_HIT_RADIUS / getZoom();
    const offsets = getWrapOffsets();
    let best: VertexHandle | null = null;
    let bestDist = radius;
    for (const vertex of verts) {
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        const dist = Math.hypot(q.x - vertex.worldPx.x, q.y - vertex.worldPx.y);
        if (dist <= bestDist) {
          best = vertex;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  /**
   * When a vertex and a transform handle both contain the pointer, pick the closer
   * centre. Exact ties prefer the handle so resize stays reachable at AABB extremes.
   */
  function hitControl(point: Point): Control | null {
    const vertex = hitVertex(point);
    const handle = hitHandle(point);
    if (vertex && handle) {
      const towardVertex = unwrapToward(point, vertex.worldPx);
      const towardHandle = unwrapToward(point, { x: handle.x, y: handle.y });
      const vertexDist = Math.hypot(
        towardVertex.x - vertex.worldPx.x,
        towardVertex.y - vertex.worldPx.y,
      );
      const handleDist = Math.hypot(
        towardHandle.x - handle.x,
        towardHandle.y - handle.y,
      );
      if (vertexDist < handleDist) return { kind: "vertex", vertex };
      return { kind: "handle", handle };
    }
    if (vertex) return { kind: "vertex", vertex };
    if (handle) return { kind: "handle", handle };
    return null;
  }

  function applyHover(point: Point): void {
    const hit = hitControl(point);
    if (hit?.kind === "vertex") {
      hoveredVertex = hit.vertex.ref;
      canvas.style.cursor = "grab";
      return;
    }
    hoveredVertex = null;
    if (hit) {
      canvas.style.cursor = hit.handle.cursor;
      return;
    }
    if (selectedHoleIndex !== null && hitHoleBox(point)) {
      canvas.style.cursor = "grab";
      return;
    }
    canvas.style.cursor = "";
  }

  function hitHoleBox(point: Point): boolean {
    if (selectedHoleIndex === null || members.length === 0 || !isPaused()) return false;
    const r = boxRect();
    const offsets = getWrapOffsets();
    for (const o of offsets) {
      const q = { x: point.x - o.x, y: point.y - o.y };
      if (q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h) return true;
    }
    return false;
  }

  function holePivotLocal(): Point {
    const lp = members[0].getLocalPoint(vecToMeters(pivot));
    return { x: lp.x, y: lp.y };
  }

  function alignmentOn(): boolean {
    return !isCut() && !isSpray() && getActiveTool().kind !== "zoom";
  }

  function holeTargets(around: Point) {
    if (selectedHoleIndex === null || members.length !== 1) return [];
    return collectHoleAlignTargets(world, members[0], selectedHoleIndex, around, getWrapOffsets());
  }

  function tryTranslateHole(holeIndex: number, dPx: Point): boolean {
    if (dPx.x === 0 && dPx.y === 0) return true;
    if (alignmentOn()) {
      const current = holeBoundsPx(members[0], holeIndex);
      if (current) {
        const tentative = {
          min: { x: current.min.x + dPx.x, y: current.min.y + dPx.y },
          max: { x: current.max.x + dPx.x, y: current.max.y + dPx.y },
        };
        const center = {
          x: (tentative.min.x + tentative.max.x) / 2,
          y: (tentative.min.y + tentative.max.y) / 2,
        };
        const result = matchBounds(tentative, holeTargets(center), alignThreshold(getZoom()));
        const snapped = { x: dPx.x + result.dx, y: dPx.y + result.dy };
        if (translateHole(members[0], holeIndex, vecToMeters(snapped))) {
          guides.set(result.lines);
          return true;
        }
      }
    }
    const ok = translateHole(members[0], holeIndex, vecToMeters(dPx));
    if (ok) guides.clear();
    return ok;
  }

  function applyHoleScale(holeIndex: number, sx: number, sy: number): void {
    const axisOf = (ax: number, ay: number) => (Math.abs(ax - 1) >= Math.abs(ay - 1) ? ax : ay);

    if (alignmentOn()) {
      const snapped = snapScaleBounds(
        pivot,
        selectedBounds(),
        sx,
        sy,
        holeTargets(pivot),
        alignThreshold(getZoom()),
        MIN_WIDTH,
      );
      if (scaleHole(members[0], holeIndex, holePivotLocal(), snapped.sx, snapped.sy)) {
        applied *= axisOf(snapped.sx, snapped.sy);
        guides.set(snapped.lines);
        return;
      }
    }
    if (scaleHole(members[0], holeIndex, holePivotLocal(), sx, sy)) {
      applied *= axisOf(sx, sy);
      guides.clear();
    }
  }

  function applyHoleRotate(holeIndex: number, extra: number, snapAxis: boolean): void {
    if (alignmentOn()) {
      const ring = holeRingPx(members[0], holeIndex);
      if (ring && ring.length >= 3) {
        const aligned = matchRotateHole(
          ring,
          pivot,
          extra,
          holeTargets(pivot),
          alignThreshold(getZoom()),
          snapAxis,
        );
        const step = extra + aligned.dAngle;
        if (step === 0 || rotateHole(members[0], holeIndex, holePivotLocal(), step)) {
          if (step !== 0) snappedApplied += step;
          guides.set(aligned.lines);
          return;
        }
      }
    }
    if (extra !== 0 && rotateHole(members[0], holeIndex, holePivotLocal(), extra)) {
      snappedApplied += extra;
    }
    guides.clear();
  }

  function unwrapToward(point: Point, around: Point): Point {
    return nearestWrapPoint(point, around, getWrapOffsets());
  }

  function canvasPoint(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  function pointerAngle(p: Point): number {
    return Math.atan2(p.y - pivot.y, p.x - pivot.x);
  }

  function translate(dPx: Point): boolean {
    if (members.length === 0) return false;
    if (selectedHoleIndex !== null) return tryTranslateHole(selectedHoleIndex, dPx);
    translateGroup(members, vecToMeters(dPx));
    return true;
  }

  // --- Rendering -------------------------------------------------------------------------------

  onAfterRender((ctx) => {
    if (!selected || members.length === 0 || isCut()) return;
    const r = boxRect();
    const zoom = getZoom();
    const handleSize = screenPx(HANDLE_SIZE);
    const rotateKnob = screenPx(ROTATE_KNOB_RADIUS);

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
        const inset = screenPx(3);
        for (const body of members) {
          const m = rectOf(bodyBoundsPx(body));
          ctx.strokeRect(m.x + inset, m.y + inset, m.w - inset * 2, m.h - inset * 2);
        }
        ctx.restore();
      }
      ctx.setLineDash([]);

      const verts = vertexDrag ? verticesOfDrag(vertexDrag) : vertexHandles();
      const stroke = 1 / zoom;
      for (const vertex of verts) {
        const hover = refsEqual(hoveredVertex, vertex.ref);
        const radius = (hover ? VERTEX_HOVER_RADIUS : VERTEX_RADIUS) / zoom;
        ctx.beginPath();
        ctx.arc(vertex.worldPx.x, vertex.worldPx.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = VERTEX_FILL;
        ctx.fill();
        ctx.lineWidth = stroke;
        ctx.strokeStyle = VERTEX_STROKE;
        ctx.stroke();
      }

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ACCENT;
      ctx.fillStyle = "#ffffff";
      for (const h of handles()) {
        if (h.kind === "rotate" || h.kind === "mirror") {
          ctx.beginPath();
          if (h.kind === "mirror") {
            ctx.moveTo(h.x, r.y + r.h);
            ctx.lineTo(h.x, h.y - rotateKnob);
          } else {
            ctx.moveTo(h.x, r.y);
            ctx.lineTo(h.x, h.y + rotateKnob);
          }
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, rotateKnob, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if (h.kind === "mirror") {
            const s = rotateKnob * 0.45;
            ctx.beginPath();
            ctx.moveTo(h.x, h.y - s);
            ctx.lineTo(h.x, h.y + s);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(h.x - s * 0.3, h.y);
            ctx.lineTo(h.x - s, h.y - s * 0.55);
            ctx.lineTo(h.x - s, h.y + s * 0.55);
            ctx.closePath();
            ctx.fillStyle = ACCENT;
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(h.x + s * 0.3, h.y);
            ctx.lineTo(h.x + s, h.y - s * 0.55);
            ctx.lineTo(h.x + s, h.y + s * 0.55);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#ffffff";
          }
        } else {
          ctx.fillRect(
            h.x - handleSize / 2,
            h.y - handleSize / 2,
            handleSize,
            handleSize,
          );
          ctx.strokeRect(
            h.x - handleSize / 2,
            h.y - handleSize / 2,
            handleSize,
            handleSize,
          );
        }
      }
      ctx.restore();
    });

    onSelectionUpdate(selected, members);
  });

  // --- Handle interaction ----------------------------------------------------------------------

  function onMove(event: MouseEvent): void {
    if (interaction === "none" || members.length === 0) return;

    if (interaction === "vertex") {
      if (!vertexDrag) return;
      const p = unwrapToward(canvasPoint(event), vertexAround);
      if (moveVertex(vertexDrag, p)) vertexAround = p;
      canvas.style.cursor = "grabbing";
      return;
    }

    if (interaction === "move") {
      const raw = canvasPoint(event);
      const p = unwrapToward(raw, pivot);
      const d = { x: p.x - pivot.x, y: p.y - pivot.y };
      if ((d.x !== 0 || d.y !== 0) && translate(d)) pivot = p;
      canvas.style.cursor = "grabbing";
      return;
    }

    const p = unwrapToward(canvasPoint(event), pivot);
    const pivotM = vecToMeters(pivot);
    const holeIndex = selectedHoleIndex;
    const editingHole = holeIndex !== null;

    if (interaction === "scale") {
      const dist = Math.hypot(p.x - pivot.x, p.y - pivot.y);
      const desiredWidth = Math.max(startWidth * (dist / startDist), MIN_WIDTH);
      const total = desiredWidth / startWidth;
      const factor = total / applied;

      if (Math.abs(factor - 1) > 1e-4) {
        if (editingHole) {
          applyHoleScale(holeIndex, factor, factor);
        } else {
          scaleGroup(members, pivotM, factor);
          applied = total;
        }
      }
      return;
    }

    if (interaction === "stretch") {
      const dist =
        stretchAxis === "x" ? Math.abs(p.x - pivot.x) : Math.abs(p.y - pivot.y);
      const desired = Math.max(startWidth * (dist / startDist), MIN_WIDTH);
      const total = desired / startWidth;
      const factor = total / applied;

      if (Math.abs(factor - 1) > 1e-4) {
        if (editingHole) {
          applyHoleScale(
            holeIndex,
            stretchAxis === "x" ? factor : 1,
            stretchAxis === "y" ? factor : 1,
          );
        } else if (stretchAxis === "x") {
          scaleGroup(members, pivotM, factor, 1);
          applied = total;
        } else {
          scaleGroup(members, pivotM, 1, factor);
          applied = total;
        }
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

    const target = event.shiftKey
      ? Math.round(accumulated / ROTATE_SNAP) * ROTATE_SNAP
      : accumulated;
    const extra = target - snappedApplied;

    if (editingHole) {
      applyHoleRotate(holeIndex, extra, !event.shiftKey);
      return;
    }

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

  function onUp(event: MouseEvent): void {
    interaction = "none";
    vertexDrag = null;
    guides.clear();
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    applyHover(canvasPoint(event));
  }

  // Capture phase so this runs before the input module's listener.
  canvas.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || members.length === 0) return;
      if (
        getActiveTool().kind === "zoom" ||
        isSpray() ||
        isCut() ||
        isChainOutline()
      )
        return;
      const raw = canvasPoint(event);
      const hit = hitControl(raw);
      if (hit?.kind === "vertex") {
        const drag = startVertexDrag(members[0], hit.vertex.ref);
        if (drag) {
          event.stopImmediatePropagation();
          event.preventDefault();
          vertexDrag = drag;
          vertexAround = hit.vertex.worldPx;
          hoveredVertex = hit.vertex.ref;
          interaction = "vertex";
          canvas.style.cursor = "grabbing";
          guides.clear();
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          return;
        }
      }

      const handle = hit?.kind === "handle" ? hit.handle : hitHandle(raw);
      if (!handle) {
        if (selectedHoleIndex !== null && hitHoleBox(raw)) {
          event.stopImmediatePropagation();
          event.preventDefault();
          pivot = raw;
          interaction = "move";
          canvas.style.cursor = "grabbing";
          guides.clear();
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }
        return;
      }

      event.stopImmediatePropagation();
      event.preventDefault();

      if (handle.kind === "mirror") {
        mirrorGroupHorizontal(members, vecToMeters(boxCentre()));
        guides.clear();
        return;
      }

      pivot = boxCentre();
      const p = unwrapToward(raw, { x: handle.x, y: handle.y });
      if (handle.kind === "scale") {
        startDist = Math.max(Math.hypot(p.x - pivot.x, p.y - pivot.y), 1);
        const bounds = selectedBounds();
        startWidth = Math.max(bounds.max.x - bounds.min.x, 1);
        applied = 1;
        interaction = "scale";
        guides.clear();
      } else if (handle.kind === "stretch") {
        stretchAxis = handle.axis;
        const bounds = selectedBounds();
        if (stretchAxis === "x") {
          startDist = Math.max(Math.abs(p.x - pivot.x), 1);
          startWidth = Math.max(bounds.max.x - bounds.min.x, 1);
        } else {
          startDist = Math.max(Math.abs(p.y - pivot.y), 1);
          startWidth = Math.max(bounds.max.y - bounds.min.y, 1);
        }
        applied = 1;
        interaction = "stretch";
        canvas.style.cursor = handle.cursor;
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
    if (
      getActiveTool().kind === "zoom" ||
      isSpray() ||
      isCut() ||
      isChainOutline()
    ) {
      hoveredVertex = null;
      return;
    }
    applyHover(canvasPoint(event));
  });

  canvas.addEventListener("mouseleave", () => {
    if (interaction !== "none") return;
    hoveredVertex = null;
    canvas.style.cursor = "";
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
    get selectedHoleIndex() {
      return selectedHoleIndex;
    },
    get isInteracting() {
      return interaction !== "none";
    },
    select,
    selectMembers,
    selectJoint,
    selectHole,
    deselect,
    translate,
  };
}
