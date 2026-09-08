import { MouseJoint, type Body, type Joint, type World } from "planck";
import { boxCutter, primitiveCutter, trySubtractHole } from "./cut";
import { createPin, createRevolute, createRod, createWeld, createWheel, type JointType } from "./joints";
import type { AfterRender } from "./physics";
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
  randomColor,
  setBodyMass,
  tracePreview,
  type Point,
  type PrimitiveShape,
  type ShapePreview,
} from "./shapes";
import type { ActiveTool, SpraySample } from "./ui";
import { toPixels, vecToMeters } from "./units";

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
  getSpraySample(): SpraySample;
  getSpraySize(): number;
  getWallThickness(): number;
  onSelectionUpdate(body: Body | null, members: Body[]): void;
  onJointSelectionUpdate(joint: Joint | null): void;
  onZoomChange(zoom: number): void;
  onAfterRender(cb: AfterRender): void;
  bodyAt(point: Point): Body | null;
  jointAt(point: Point): Joint | null;
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
  getSpraySample,
  getSpraySize,
  getWallThickness,
  onSelectionUpdate,
  onJointSelectionUpdate,
  onZoomChange,
  onAfterRender,
  bodyAt,
  jointAt,
}: InputOptions): Input {
  const selection = createSelection({
    canvas,
    getSize,
    getZoom,
    getActiveTool,
    isSpray,
    isCut,
    screenToWorld,
    isPaused,
    onSelectionUpdate,
    onJointSelectionUpdate,
    onAfterRender,
  });

  let grabEnabled = true;
  let mouseJoint: MouseJoint | null = null;

  // --- Gesture state ---------------------------------------------------------------------------

  let pressPoint: Point | null = null;
  /** Dynamic body under the pointer when pressed (throw while playing, select while paused). */
  let pressedBody: Body | null = null;
  /** Press point on empty space: a spawn gesture is in progress. */
  let spawnStart: Point | null = null;
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
  /** First attachment of a two-click joint (revolute / rod / weld / wheel). */
  let jointAnchor: { body: Body; point: Point } | null = null;
  /** Right / middle mouse camera pan. */
  let panning = false;
  let panLast: Point | null = null;
  /** Spray trail: last stamped world-pixel position. */
  let sprayLast: Point | null = null;
  /** Cut press landed on a new body: this gesture only selects, it must not punch a hole. */
  let cutSelectOnly = false;

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
    return type === "revolute" || type === "rod" || type === "weld" || type === "wheel";
  }

  function hasSelection(): boolean {
    return selection.selected !== null || selection.selectedJoint !== null;
  }

  function applyCursor(): void {
    if (panning || moveOffset) canvas.style.cursor = "grabbing";
    else if (isZoomTool()) canvas.style.cursor = "grab";
    else if (
      isSpray() ||
      isCut() ||
      isDraftTool() ||
      isCornerDragTool() ||
      isEdgeTool() ||
      (jointType() && isPaused())
    ) {
      canvas.style.cursor = "crosshair";
    } else canvas.style.cursor = "";
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

  function startGrab(body: Body, point: Point): void {
    endGrab();
    const target = vecToMeters(point);
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
    dragged = false;
    ghost = null;
    ghostSize = 0;
    ghostColor = undefined;
    clickOnlyDeselects = false;
    moveOffset = null;
    pendingSelectToggle = false;
    sprayLast = null;
    cutSelectOnly = false;
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

  function placeJoint(type: JointType, body: Body, point: Point): void {
    if (type === "pin") {
      createPin(world, ground, body, point);
      return;
    }
    if (!jointAnchor) {
      jointAnchor = { body, point };
      setGrabEnabled(false);
      return;
    }
    if (jointAnchor.body === body) return;
    if (type === "revolute") {
      createRevolute(world, jointAnchor.body, jointAnchor.point, body, point);
    } else if (type === "weld") {
      createWeld(world, jointAnchor.body, jointAnchor.point, body, point);
    } else if (type === "wheel") {
      createWheel(world, jointAnchor.body, jointAnchor.point, body, point);
    } else {
      createRod(world, jointAnchor.body, jointAnchor.point, body, point);
    }
    clearJointAnchor();
  }

  // --- Events ----------------------------------------------------------------------------------

  canvas.addEventListener("mousemove", (event) => {
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    hover = canvasPoint(event);
    if (mouseJoint) mouseJoint.setTarget(vecToMeters(hover));
    if (!moveOffset) applyCursor();
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
    if (isPaused() && jointAnchor === null && !(isDraftTool() && draft.length > 0)) {
      const hitJoint = jointAt(p);
      if (hitJoint) {
        selection.selectJoint(hitJoint);
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
      // Click a body to choose the cut target; drag (on the target or empty space) punches a hole.
      if (pressedBody && isPaused()) {
        const wasTarget = selection.selected === pressedBody;
        if (selection.members.includes(pressedBody)) {
          pendingSelectToggle = true;
        } else {
          selection.select(pressedBody);
        }
        if (!wasTarget) cutSelectOnly = true;
        else if (!isDraftTool()) spawnStart = p;
      } else if (!pressedBody) {
        if (!isDraftTool()) {
          clickOnlyDeselects = hasSelection();
          spawnStart = p;
        }
      } else if (!isDraftTool()) {
        spawnStart = p;
      }
      setGrabEnabled(false);
    } else if (!pressedBody) {
      // Any press on empty space clears the selection. A plain click then only deselects, but a
      // drag still sizes and spawns a new shape (primitives only).
      clickOnlyDeselects = hasSelection();
      selection.deselect();
      if (!isDraftTool()) spawnStart = p;
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
      const pos = pressedBody.getPosition();
      moveOffset = { x: toPixels(pos.x) - p.x, y: toPixels(pos.y) - p.y };
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
      if (isCut()) trySubtractHole(world, draft, selection.selected);
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
    if (mouseJoint) mouseJoint.setTarget(vecToMeters(p));

    if (sprayLast) {
      stampSprayAlong(p);
      return;
    }

    if (moveOffset && pressedBody) {
      // Velocity is left untouched (freeze-frame edit): the shape resumes its prior motion on Play.
      // Everything selected (the shape, or its whole jointed group) moves by the same delta.
      const pos = pressedBody.getPosition();
      const delta = {
        x: p.x + moveOffset.x - toPixels(pos.x),
        y: p.y + moveOffset.y - toPixels(pos.y),
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

    if (type) {
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
        !cutSelectOnly &&
        (!pressedBody || isCut())
      ) {
        draft.push(p);
        hover = p;
        setGrabEnabled(false);
      } else if (isCut() && isClick && isPaused() && pendingSelectToggle && pressedBody) {
        selection.select(pressedBody);
      }
    } else if (spawnStart) {
      if (isCut()) {
        if (dragged && !cutSelectOnly) {
          const target = selection.selected;
          if (isBoxTool()) {
            trySubtractHole(world, boxCutter(spawnStart, p), target);
          } else if (ghost && ghost.type !== "box" && ghost.type !== "frame" && ghost.type !== "edge") {
            trySubtractHole(world, primitiveCutter(ghost.type, ghost.x, ghost.y, ghost.size), target);
          }
        } else if (isClick && isPaused() && pendingSelectToggle && pressedBody) {
          selection.select(pressedBody);
        } else if (isClick && clickOnlyDeselects && !pressedBody) {
          selection.deselect();
        }
      } else if (isBoxTool()) {
        if (dragged) {
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
        createBody(world, ghost.type, ghost.x, ghost.y, ghost.size, ghost.fillStyle);
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
          createBody(world, tool.shape, spawnStart.x, spawnStart.y, DEFAULT_SIZE);
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

    if (ghost) {
      ctx.save();
      tracePreview(ctx, ghost);
      const cutting = isCut();
      if (ghost.type !== "edge") {
        ctx.globalAlpha = cutting ? 0.28 : 0.45;
        ctx.fillStyle = ghost.fillStyle;
        ctx.fill("evenodd");
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cutting ? CUT_FILL : ACCENT;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }

    if (jointAnchor) {
      ctx.save();
      if (hover) {
        ctx.beginPath();
        ctx.moveTo(jointAnchor.point.x, jointAnchor.point.y);
        ctx.lineTo(hover.x, hover.y);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(jointAnchor.point.x, jointAnchor.point.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (draft.length === 0) return;

    const preview = hover ? [...draft, hover] : draft;
    const cutting = isCut() && isPolygonTool();
    ctx.save();
    if (isPolygonTool() && preview.length >= 3) {
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
