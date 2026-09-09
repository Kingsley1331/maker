import { MouseJoint, type Body, type Joint, type World } from "planck";
import { boxCutter, primitiveCutter, trySubtractHole } from "./cut";
import { connectedBodies, translateGroup } from "./group";
import {
  createPin,
  createPrismatic,
  createRevolute,
  createRod,
  createWeld,
  createWheel,
  jointEndHit,
  MOTOR_JOINT_HIT_PX,
  setJointEnd,
  type JointEnd,
  type JointType,
} from "./joints";
import { bodyBoundsPx, nearestWrapPoint, withWrapOffsets, type AfterRender } from "./physics";
import { createSelection, type Selection } from "./selection";
import {
  boxBounds,
  createBody,
  createBox,
  createChain,
  createEdge,
  createFrame,
  createPolygon,
  DEFAULT_SIZE,
  edgeEndpoints,
  frameBounds,
  isPickable,
  randomColor,
  setBodyMass,
  tracePreview,
  type JointUserData,
  type Point,
  type PrimitiveShape,
  type ShapePreview,
} from "./shapes";
import type { ActiveTool, SpraySample } from "./ui";
import { vecToMeters, vecToPixels } from "./units";

/** Max pointer travel (px) between mousedown and mouseup for it to count as a click. */
const CLICK_THRESHOLD = 6;
/** Smallest nominal radius a drag can produce. */
const MIN_SIZE = 8;
/** Minimum distance between sprayed bodies (px). */
const SPRAY_SPACING = 10;
const ACCENT = "#3b6fe0";
const CUT_FILL = "#c44646";

export interface InputOptions {
  world: World;
  ground: Body;
  canvas: HTMLCanvasElement;
  getSize(): { w: number; h: number };
  getZoom(): number;
  setZoom(zoom: number, anchorScreen?: Point): void;
  screenToWorld(p: Point): Point;
  panBy(dx: number, dy: number): void;
  isPaused(): boolean;
  getActiveTool(): ActiveTool;
  isSpray(): boolean;
  isCut(): boolean;
  isChainOutline(): boolean;
  getSpraySample(): SpraySample;
  getSpraySize(): number;
  getWallThickness(): number;
  onSelectionUpdate(body: Body | null, members: Body[]): void;
  onJointSelectionUpdate(joint: Joint | null): void;
  onZoomChange(zoom: number): void;
  onAfterRender(cb: AfterRender): void;
  bodyAt(point: Point): Body | null;
  jointAt(point: Point): Joint | null;
  jointEndAt(point: Point): { joint: Joint; end: JointEnd } | null;
  setHoveredJoint(joint: Joint | null, end?: JointEnd | null): void;
  /** World-pixel offsets for wrap copies (identity when wrap is off). */
  getWrapOffsets(): Point[];
}

export interface Input {
  selection: Selection;
}

/**
 * Pointer handling. All click / select / spawn logic runs on native DOM events so it keeps working
 * while the simulation is paused. A MouseJoint is used only for grab-and-throw while playing.
 */
export function setupInput({
  world,
  ground,
  canvas,
  getSize,
  getZoom,
  setZoom,
  screenToWorld,
  panBy,
  isPaused,
  getActiveTool,
  isSpray,
  isCut,
  isChainOutline,
  getSpraySample,
  getSpraySize,
  getWallThickness,
  onSelectionUpdate,
  onJointSelectionUpdate,
  onZoomChange,
  onAfterRender,
  bodyAt,
  jointAt,
  jointEndAt,
  setHoveredJoint,
  getWrapOffsets,
}: InputOptions): Input {
  const selection = createSelection({
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
  });

  let grabEnabled = true;
  let mouseJoint: MouseJoint | null = null;

  // --- Gesture state ---------------------------------------------------------------------------

  let pressPoint: Point | null = null;
  /** Dynamic body under the pointer when pressed (throw while playing, select while paused). */
  let pressedBody: Body | null = null;
  /** Press point on empty space: a spawn gesture is in progress. */
  let spawnStart: Point | null = null;
  /** Press point on empty space: a marquee-select gesture is in progress. */
  let marqueeStart: Point | null = null;
  let dragged = false;
  /** Preview for the drag-to-size gesture; becomes the real body on release. */
  let ghost: ShapePreview | null = null;
  let ghostSize = 0;
  let ghostColor: string | undefined;
  /** The press cleared a selection, so a plain click must not also spawn. */
  let clickOnlyDeselects = false;
  /** Paused move gesture: body centre (px) relative to the pointer at press time. */
  let moveOffset: Point | null = null;
  /** Pressed a body already in the selection; toggle group/solo on click-up, not press. */
  let pendingSelectToggle = false;
  /** Vertices of an in-progress polygon or chain. */
  let draft: Point[] = [];
  /** Cursor position for rubber-band previews (polygon/chain draft or pending joint). */
  let hover: Point | null = null;
  /** Motor hub currently under the pointer (paused); drives the pulse ring. */
  let hoveredHub: Joint | null = null;
  /** Paused drag of a joint draw end. */
  let anchorDrag: { joint: Joint; end: JointEnd } | null = null;
  /** First attachment of a two-click joint (revolute / rod / weld / wheel / slider). */
  let jointAnchor: { body: Body; point: Point } | null = null;
  /** Right / middle mouse camera pan. */
  let panning = false;
  let panLast: Point | null = null;
  /** Spray trail: last stamped world-pixel position. */
  let sprayLast: Point | null = null;

  function screenPoint(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function canvasPoint(event: MouseEvent): Point {
    return screenToWorld(screenPoint(event));
  }

  function clickSlop(): number {
    return CLICK_THRESHOLD / getZoom();
  }

  function maxSize(): number {
    const { w, h } = getSize();
    return Math.min(w, h) * 0.3;
  }

  function isZoomTool(): boolean {
    return getActiveTool().kind === "zoom";
  }

  function isShapeTool(): boolean {
    return getActiveTool().kind === "shape";
  }

  function isPolygonTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "polygon";
  }

  function isChainTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "chain";
  }

  function isDraftTool(): boolean {
    return isPolygonTool() || isChainTool();
  }

  function isBoxTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "box";
  }

  function isFrameTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "frame";
  }

  function isEdgeTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "edge";
  }

  function isCornerDragTool(): boolean {
    return isBoxTool() || isFrameTool();
  }

  function sprayShape(): PrimitiveShape | null {
    if (!isSpray()) return null;
    const tool = getActiveTool();
    if (
      tool.kind !== "shape" ||
      tool.shape === "polygon" ||
      tool.shape === "box" ||
      tool.shape === "frame" ||
      tool.shape === "edge" ||
      tool.shape === "chain"
    ) {
      return null;
    }
    return tool.shape;
  }

  function stampSpray(x: number, y: number): void {
    const shape = sprayShape();
    if (!shape) return;
    const sample = getSpraySample();
    const body = createBody(world, shape, x, y, sample.size, sample.fillStyle);
    body.setTransform(body.getPosition(), (sample.angleDeg * Math.PI) / 180);
    setBodyMass(body, sample.mass);
    body.setLinearVelocity(vecToMeters({ x: sample.vxPx, y: sample.vyPx }));
    body.setAngularVelocity((sample.spinDeg * Math.PI) / 180);
  }

  function spraySpacing(): number {
    return Math.max(SPRAY_SPACING, getSpraySize() * 1.5);
  }

  function stampSprayAlong(to: Point): void {
    if (!sprayLast) return;
    const spacing = spraySpacing();
    const dx = to.x - sprayLast.x;
    const dy = to.y - sprayLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist < spacing) return;
    const ux = dx / dist;
    const uy = dy / dist;
    const steps = Math.floor(dist / spacing);
    const from = sprayLast;
    for (let i = 1; i <= steps; i++) {
      stampSpray(from.x + ux * spacing * i, from.y + uy * spacing * i);
    }
    sprayLast = {
      x: from.x + ux * spacing * steps,
      y: from.y + uy * spacing * steps,
    };
  }

  function jointType(): JointType | null {
    const tool = getActiveTool();
    return tool.kind === "joint" ? tool.joint : null;
  }

  function isTwoClickJoint(type: JointType): boolean {
    return (
      type === "revolute" ||
      type === "rod" ||
      type === "weld" ||
      type === "wheel" ||
      type === "prismatic"
    );
  }

  function hasSelection(): boolean {
    return selection.selected !== null || selection.selectedJoint !== null;
  }

  function applyCursor(): void {
    if (panning || moveOffset || anchorDrag) canvas.style.cursor = "grabbing";
    else if (isZoomTool()) canvas.style.cursor = "grab";
    else if (hoveredHub) canvas.style.cursor = "pointer";
    else if (
      isSpray() ||
      isCut() ||
      isChainOutline() ||
      isDraftTool() ||
      isCornerDragTool() ||
      isEdgeTool() ||
      (jointType() && isPaused())
    ) {
      canvas.style.cursor = "crosshair";
    } else canvas.style.cursor = "";
  }

  function updateHubHover(point: Point | null): void {
    let next: Joint | null = null;
    let end: JointEnd | null = null;
    if (
      point &&
      isPaused() &&
      !isSpray() &&
      !isCut() &&
      !panning &&
      !moveOffset &&
      !anchorDrag &&
      jointAnchor === null
    ) {
      const hit = jointEndAt(point);
      if (hit) {
        next = hit.joint;
        end = hit.end;
      }
    }
    hoveredHub = next;
    setHoveredJoint(next, end);
  }

  function startPan(event: MouseEvent): void {
    event.preventDefault();
    panning = true;
    panLast = screenPoint(event);
    applyCursor();
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", onPanUp);
  }

  function setGrabEnabled(enabled: boolean): void {
    grabEnabled = enabled;
    if (!enabled) endGrab();
  }

  function grabIdle(): boolean {
    return draft.length === 0 && jointAnchor === null;
  }

  function clearDraft(): void {
    draft = [];
    hover = null;
    if (grabIdle()) setGrabEnabled(true);
  }

  function clearJointAnchor(): void {
    jointAnchor = null;
    if (grabIdle()) setGrabEnabled(true);
  }

  function unwrapTowardBody(point: Point, body: Body): Point {
    return nearestWrapPoint(point, vecToPixels(body.getPosition()), getWrapOffsets());
  }

  function setGrabTarget(point: Point): void {
    if (!mouseJoint) return;
    const body = mouseJoint.getBodyB();
    mouseJoint.setTarget(vecToMeters(body ? unwrapTowardBody(point, body) : point));
  }

  function startGrab(body: Body, point: Point): void {
    endGrab();
    const target = vecToMeters(unwrapTowardBody(point, body));
    const joint = world.createJoint(
      new MouseJoint(
        {
          maxForce: 1000 * body.getMass(),
          frequencyHz: 5,
          dampingRatio: 0.7,
        },
        ground,
        body,
        target,
      ),
    );
    if (joint) mouseJoint = joint;
  }

  function endGrab(): void {
    if (!mouseJoint) return;
    world.destroyJoint(mouseJoint);
    mouseJoint = null;
  }

  function rebuildGhost(size: number): void {
    if (!spawnStart) return;
    const tool = getActiveTool();
    if (
      tool.kind !== "shape" ||
      tool.shape === "polygon" ||
      tool.shape === "box" ||
      tool.shape === "frame" ||
      tool.shape === "edge" ||
      tool.shape === "chain"
    ) {
      return;
    }
    ghostColor ??= isCut() ? CUT_FILL : randomColor();
    ghost = { type: tool.shape, x: spawnStart.x, y: spawnStart.y, size, fillStyle: ghostColor };
    ghostSize = size;
  }

  function reset(): void {
    pressPoint = null;
    pressedBody = null;
    spawnStart = null;
    marqueeStart = null;
    dragged = false;
    ghost = null;
    ghostSize = 0;
    ghostColor = undefined;
    clickOnlyDeselects = false;
    moveOffset = null;
    pendingSelectToggle = false;
    sprayLast = null;
    anchorDrag = null;
    if (grabIdle()) setGrabEnabled(true);
    applyCursor();
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  function onPanMove(event: MouseEvent): void {
    if (!panning || !panLast) return;
    const p = screenPoint(event);
    panBy(p.x - panLast.x, p.y - panLast.y);
    panLast = p;
  }

  function onPanUp(): void {
    panning = false;
    panLast = null;
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", onPanUp);
    applyCursor();
  }

  function dropDraftIfToolChanged(): void {
    if (!isDraftTool() && draft.length > 0) clearDraft();
  }

  function dropJointAnchorIfToolChanged(): void {
    if (!jointAnchor) return;
    const type = jointType();
    if (!isPaused() || !type || !isTwoClickJoint(type)) clearJointAnchor();
  }

  function selectSceneJoint(joint: Joint | null): void {
    if (!joint) return;
    const data = joint.getUserData() as JointUserData | undefined;
    if (data?.kind) selection.selectJoint(joint);
  }

  function placeJoint(type: JointType, body: Body, rawPoint: Point): void {
    // The click may have landed on a wrap copy of the body; anchor on the body's real position.
    let point = unwrapTowardBody(rawPoint, body);
    if (type === "pin") {
      selectSceneJoint(createPin(world, ground, body, point));
      return;
    }
    if (!jointAnchor) {
      jointAnchor = { body, point };
      setGrabEnabled(false);
      return;
    }
    if (jointAnchor.body === body) return;
    // When wrapping, the two shapes may look adjacent on screen while sitting a whole canvas
    // apart in world space (one of them is seen through a wrap copy). Slide the second shape's
    // group onto the copy nearest the first anchor so the joint gets the geometry the user sees.
    const group = connectedBodies(body);
    if (!group.includes(jointAnchor.body)) {
      const near = nearestWrapPoint(point, jointAnchor.point, getWrapOffsets());
      const shift = { x: near.x - point.x, y: near.y - point.y };
      if (shift.x !== 0 || shift.y !== 0) {
        translateGroup(group, vecToMeters(shift));
        point = near;
      }
    }
    let created: Joint | null = null;
    if (type === "revolute") {
      created = createRevolute(world, jointAnchor.body, jointAnchor.point, body, point);
    } else if (type === "weld") {
      created = createWeld(world, jointAnchor.body, jointAnchor.point, body, point);
    } else if (type === "wheel") {
      created = createWheel(world, jointAnchor.body, jointAnchor.point, body, point);
    } else if (type === "prismatic") {
      created = createPrismatic(world, jointAnchor.body, jointAnchor.point, body, point);
    } else {
      created = createRod(world, jointAnchor.body, jointAnchor.point, body, point);
    }
    clearJointAnchor();
    selectSceneJoint(created);
  }

  // --- Events ----------------------------------------------------------------------------------

  canvas.addEventListener("mousemove", (event) => {
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    hover = canvasPoint(event);
    setGrabTarget(hover);
    updateHubHover(hover);
    if (!moveOffset) applyCursor();
  });

  canvas.addEventListener("mouseleave", () => {
    hover = null;
    updateHubHover(null);
    if (!panning && !moveOffset) applyCursor();
  });

  canvas.addEventListener("mousedown", (event) => {
    if (isZoomTool() && (event.button === 0 || event.button === 1 || event.button === 2)) {
      startPan(event);
      return;
    }
    if (event.button === 1 || event.button === 2) return;
    if (event.button !== 0) return;
    if (isSpray()) {
      event.preventDefault();
      const p = canvasPoint(event);
      pressPoint = p;
      selection.deselect();
      setGrabEnabled(false);
      stampSpray(p.x, p.y);
      sprayLast = { x: p.x, y: p.y };
      applyCursor();
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    // The selection module intercepts handle presses in the capture phase before we get here.
    const p = canvasPoint(event);
    pressPoint = p;

    // Pause-click a pin / revolute / wheel pivot to select it for the motor sliders. This wins
    // over joint placement (so you can click a pin you just made) unless a two-click joint is
    // waiting for its second body, or a polygon/chain is mid-draw.
    if (isPaused() && !isCut() && jointAnchor === null && !(isDraftTool() && draft.length > 0)) {
      const hitJoint = jointAt(p);
      if (hitJoint) {
        selection.selectJoint(hitJoint);
        const end = jointEndHit(hitJoint, p, MOTOR_JOINT_HIT_PX / getZoom());
        if (end) {
          anchorDrag = { joint: hitJoint, end };
          applyCursor();
        }
        clickOnlyDeselects = true;
        setGrabEnabled(false);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }
    }

    const type = jointType();
    if (type) {
      pressedBody = bodyAt(p);
      if (isPaused()) {
        // Joint placement instead of select / move / spawn.
        if (!pressedBody) {
          clickOnlyDeselects = hasSelection() || jointAnchor !== null;
          selection.deselect();
        }
        setGrabEnabled(false);
      } else if (!pressedBody) {
        // Playing: no spawn; empty presses should not grab.
        selection.deselect();
        setGrabEnabled(false);
      } else if (grabEnabled && pressedBody.isDynamic()) {
        startGrab(pressedBody, p);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }

    if (isDraftTool() && draft.length > 0) {
      // Mid-draw: clicks add vertices even over existing bodies.
      pressedBody = null;
      setGrabEnabled(false);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }

    pressedBody = bodyAt(p);

    if (isCut()) {
      selection.deselect();
      if (!isDraftTool()) spawnStart = p;
      setGrabEnabled(false);
    } else if (!pressedBody) {
      // Empty space: click-away deselects. With a shape tool, drag still sizes a new body.
      // With no tool (paused), drag draws a marquee and selects everything it overlaps.
      if (isPaused() && getActiveTool().kind === "none") {
        marqueeStart = p;
      } else {
        clickOnlyDeselects = hasSelection();
        selection.deselect();
        if (isShapeTool() && !isDraftTool()) spawnStart = p;
      }
      setGrabEnabled(false);
    } else if (isPaused()) {
      // Paused: select a new body on press so a drag can move it. If this body is already in the
      // selection (a group member, or the solo shape), keep that selection for dragging and
      // toggle group/solo only on a click-up.
      if (selection.members.includes(pressedBody)) {
        pendingSelectToggle = true;
      } else {
        selection.select(pressedBody);
      }
      const posPx = vecToPixels(pressedBody.getPosition());
      const local = nearestWrapPoint(p, posPx, getWrapOffsets());
      moveOffset = { x: posPx.x - local.x, y: posPx.y - local.y };
      applyCursor();
    } else if (grabEnabled && pressedBody.isDynamic()) {
      startGrab(pressedBody, p);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (!isDraftTool()) return;

    if (draft.length >= 2) {
      const last = draft[draft.length - 1];
      const prev = draft[draft.length - 2];
      if (Math.hypot(last.x - prev.x, last.y - prev.y) <= clickSlop()) {
        draft.pop();
      }
    }

    if (isPolygonTool()) {
      if (draft.length < 3) return;
      if (isCut()) trySubtractHole(world, draft);
      else if (isChainOutline()) createChain(world, draft, true);
      else createPolygon(world, draft);
    } else if (isChainTool()) {
      if (draft.length < 2) return;
      createChain(world, draft);
    }
    clearDraft();
    applyCursor();
  });

  function onMove(event: MouseEvent): void {
    if (!pressPoint) return;
    if (eventOnToolbar(event)) return;
    const p = canvasPoint(event);
    hover = p;
    setGrabTarget(p);

    if (sprayLast) {
      stampSprayAlong(p);
      return;
    }

    if (anchorDrag) {
      dragged = true;
      const endBody =
        anchorDrag.end === "a" ? anchorDrag.joint.getBodyA() : anchorDrag.joint.getBodyB();
      setJointEnd(anchorDrag.joint, anchorDrag.end, unwrapTowardBody(p, endBody), bodyAt(p));
      setHoveredJoint(anchorDrag.joint, anchorDrag.end);
      return;
    }

    if (marqueeStart) {
      const dist = Math.hypot(p.x - marqueeStart.x, p.y - marqueeStart.y);
      if (dist > clickSlop()) dragged = true;
      return;
    }

    if (moveOffset && pressedBody) {
      // Velocity is left untouched (freeze-frame edit): the shape resumes its prior motion on Play.
      // Everything selected (the shape, or its whole jointed group) moves by the same delta.
      const posPx = vecToPixels(pressedBody.getPosition());
      const around = { x: posPx.x - moveOffset.x, y: posPx.y - moveOffset.y };
      const local = nearestWrapPoint(p, around, getWrapOffsets());
      const delta = {
        x: local.x + moveOffset.x - posPx.x,
        y: local.y + moveOffset.y - posPx.y,
      };
      selection.translate(delta);
      return;
    }

    if (!spawnStart || isDraftTool() || !isShapeTool()) return;
    const dist = Math.hypot(p.x - spawnStart.x, p.y - spawnStart.y);
    if (!dragged && dist <= clickSlop()) return;

    dragged = true;
    if (isEdgeTool()) {
      ghostColor ??= isCut() ? CUT_FILL : randomColor();
      const ends = edgeEndpoints(spawnStart, p);
      ghost = {
        type: "edge",
        x: ends.a.x,
        y: ends.a.y,
        x2: ends.b.x,
        y2: ends.b.y,
        size: 0,
        fillStyle: ghostColor,
      };
      return;
    }
    if (isCornerDragTool()) {
      ghostColor ??= isCut() ? CUT_FILL : randomColor();
      if (isFrameTool()) {
        const bounds = frameBounds(spawnStart, p, getWallThickness());
        ghost = {
          type: "frame",
          x: bounds.x,
          y: bounds.y,
          w: bounds.w,
          h: bounds.h,
          size: 0,
          fillStyle: ghostColor,
          thickness: bounds.thickness,
        };
      } else {
        const bounds = boxBounds(spawnStart, p);
        ghost = {
          type: "box",
          x: bounds.x,
          y: bounds.y,
          w: bounds.w,
          h: bounds.h,
          size: 0,
          fillStyle: ghostColor,
        };
      }
      return;
    }

    const size = Math.min(Math.max(dist, MIN_SIZE), maxSize());
    if (!ghost || Math.abs(size - ghostSize) > 0.5) {
      rebuildGhost(size);
    }
  }

  function marqueeRect(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function boundsOverlap(
    min: Point,
    max: Point,
    box: { x: number; y: number; w: number; h: number },
  ): boolean {
    return min.x <= box.x + box.w && max.x >= box.x && min.y <= box.y + box.h && max.y >= box.y;
  }

  function bodiesInMarquee(a: Point, b: Point): Body[] {
    const box = marqueeRect(a, b);
    const offsets = getWrapOffsets();
    const hits: Body[] = [];
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body)) continue;
      const { min, max } = bodyBoundsPx(body);
      for (const o of offsets) {
        if (
          boundsOverlap({ x: min.x + o.x, y: min.y + o.y }, { x: max.x + o.x, y: max.y + o.y }, box)
        ) {
          hits.push(body);
          break;
        }
      }
    }
    return hits;
  }

  function eventOnToolbar(event: Event): boolean {
    const t = event.target;
    if (!(t instanceof Node)) return false;
    return !!document.getElementById("toolbar")?.contains(t);
  }

  function onUp(event: MouseEvent): void {
    if (!pressPoint) return;
    try {
      if (eventOnToolbar(event)) return;
      const p = canvasPoint(event);
      const isClick = Math.hypot(p.x - pressPoint.x, p.y - pressPoint.y) <= clickSlop();
      const type = jointType();

      endGrab();

    if (type && !clickOnlyDeselects) {
      if (isPaused() && isClick) {
        if (!pressedBody) {
          clearJointAnchor();
        } else {
          placeJoint(type, pressedBody, pressPoint);
        }
      }
    } else if (isDraftTool()) {
      if (
        isClick &&
        event.detail === 1 &&
        !clickOnlyDeselects &&
        (!pressedBody || isCut())
      ) {
        draft.push(p);
        hover = p;
        setGrabEnabled(false);
      }
    } else if (marqueeStart) {
      if (isClick) {
        selection.deselect();
      } else {
        const hits = bodiesInMarquee(marqueeStart, p);
        if (hits.length === 0) selection.deselect();
        else selection.selectMembers(hits);
      }
    } else if (spawnStart) {
      if (isCut()) {
        if (dragged) {
          if (isBoxTool()) {
            trySubtractHole(world, boxCutter(spawnStart, p));
          } else if (ghost && ghost.type !== "box" && ghost.type !== "frame" && ghost.type !== "edge") {
            trySubtractHole(world, primitiveCutter(ghost.type, ghost.x, ghost.y, ghost.size));
          }
        }
      } else if (isBoxTool()) {
        if (isChainOutline()) {
          if (dragged) {
            createChain(world, boxCutter(spawnStart, p), true);
          } else if (isClick && !clickOnlyDeselects) {
            createChain(
              world,
              boxCutter(
                { x: spawnStart.x - DEFAULT_SIZE, y: spawnStart.y - DEFAULT_SIZE },
                { x: spawnStart.x + DEFAULT_SIZE, y: spawnStart.y + DEFAULT_SIZE },
              ),
              true,
            );
          }
        } else if (dragged) {
          createBox(world, spawnStart, p, ghostColor ?? randomColor());
        } else if (isClick && !clickOnlyDeselects) {
          createBox(
            world,
            { x: spawnStart.x - DEFAULT_SIZE, y: spawnStart.y - DEFAULT_SIZE },
            { x: spawnStart.x + DEFAULT_SIZE, y: spawnStart.y + DEFAULT_SIZE },
          );
        }
      } else if (isFrameTool()) {
        const color = ghostColor ?? randomColor();
        const thickness = getWallThickness();
        if (dragged) {
          createFrame(world, spawnStart, p, thickness, color);
        } else if (isClick && !clickOnlyDeselects) {
          createFrame(
            world,
            { x: spawnStart.x - DEFAULT_SIZE, y: spawnStart.y - DEFAULT_SIZE },
            { x: spawnStart.x + DEFAULT_SIZE, y: spawnStart.y + DEFAULT_SIZE },
            thickness,
          );
        }
      } else if (isEdgeTool()) {
        if (dragged) {
          createEdge(world, spawnStart, p, ghostColor ?? randomColor());
        } else if (isClick && !clickOnlyDeselects) {
          createEdge(
            world,
            { x: spawnStart.x - DEFAULT_SIZE, y: spawnStart.y },
            { x: spawnStart.x + DEFAULT_SIZE, y: spawnStart.y },
          );
        }
      } else if (dragged && ghost && ghost.type !== "box" && ghost.type !== "frame" && ghost.type !== "edge") {
        if (isChainOutline()) {
          createChain(world, primitiveCutter(ghost.type, ghost.x, ghost.y, ghost.size), true);
        } else {
          createBody(world, ghost.type, ghost.x, ghost.y, ghost.size, ghost.fillStyle);
        }
      } else if (isClick && !clickOnlyDeselects) {
        const tool = getActiveTool();
        if (
          tool.kind === "shape" &&
          tool.shape !== "polygon" &&
          tool.shape !== "box" &&
          tool.shape !== "frame" &&
          tool.shape !== "edge" &&
          tool.shape !== "chain"
        ) {
          if (isChainOutline()) {
            createChain(world, primitiveCutter(tool.shape, spawnStart.x, spawnStart.y, DEFAULT_SIZE), true);
          } else {
            createBody(world, tool.shape, spawnStart.x, spawnStart.y, DEFAULT_SIZE);
          }
        }
      }
    } else if (isPaused() && isClick && pendingSelectToggle && pressedBody) {
      selection.select(pressedBody);
    }
    } finally {
      reset();
    }
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    clearJointAnchor();
  });

  // --- Ghost / draft / joint preview -----------------------------------------------------------

  onAfterRender((ctx) => {
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    updateHubHover(hover);
    if (isCut() && hasSelection()) selection.deselect();

    if (marqueeStart && hover && dragged) {
      const box = marqueeRect(marqueeStart, hover);
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }

    if (ghost) {
      const preview = ghost;
      withWrapOffsets(ctx, getWrapOffsets(), () => {
        ctx.save();
        tracePreview(ctx, preview);
        const cutting = isCut();
        const outlining = isChainOutline();
        if (preview.type !== "edge" && !outlining) {
          ctx.globalAlpha = cutting ? 0.28 : 0.45;
          ctx.fillStyle = preview.fillStyle;
          ctx.fill("evenodd");
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = cutting ? CUT_FILL : ACCENT;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();
      });
    }

    if (jointAnchor) {
      const anchor = jointAnchor;
      // The anchor sits at the body's real position, which may be off-canvas when wrapping, so
      // draw it (and the rubber band to the pointer's nearest copy) once per wrap offset.
      const to = hover ? nearestWrapPoint(hover, anchor.point, getWrapOffsets()) : null;
      withWrapOffsets(ctx, getWrapOffsets(), () => {
        ctx.save();
        if (to) {
          ctx.beginPath();
          ctx.moveTo(anchor.point.x, anchor.point.y);
          ctx.lineTo(to.x, to.y);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.arc(anchor.point.x, anchor.point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    if (draft.length === 0) return;

    const preview = hover ? [...draft, hover] : draft;
    const cutting = isCut() && isPolygonTool();
    const outlining = isChainOutline() && isPolygonTool();
    ctx.save();
    if (isPolygonTool() && preview.length >= 3 && !outlining) {
      ctx.beginPath();
      ctx.moveTo(preview[0].x, preview[0].y);
      for (let i = 1; i < preview.length; i++) ctx.lineTo(preview[i].x, preview[i].y);
      ctx.closePath();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = cutting ? CUT_FILL : ACCENT;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.moveTo(preview[0].x, preview[0].y);
    for (let i = 1; i < preview.length; i++) ctx.lineTo(preview[i].x, preview[i].y);
    if (outlining && preview.length >= 3) ctx.closePath();
    ctx.strokeStyle = cutting ? CUT_FILL : ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = cutting ? CUT_FILL : ACCENT;
    for (const vertex of draft) {
      ctx.beginPath();
      ctx.arc(vertex.x, vertex.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });

  // Stop the browser from treating drags as text selection / scroll gestures.
  canvas.style.touchAction = "none";
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("auxclick", (event) => event.preventDefault());
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!isZoomTool()) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(getZoom() * factor, screenPoint(event));
      onZoomChange(getZoom());
    },
    { passive: false },
  );
  applyCursor();

  return { selection };
}
