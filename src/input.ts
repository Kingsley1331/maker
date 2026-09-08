import { Body, Composite, Engine, Events, Mouse, MouseConstraint, Query, Render } from "matter-js";
import { createPin, createRevolute, createRod, type JointType } from "./joints";
import { createSelection, type Selection } from "./selection";
import { createBody, createPolygon, DEFAULT_SIZE, type Point } from "./shapes";
import type { ActiveTool } from "./ui";

/** Max pointer travel (px) between mousedown and mouseup for it to count as a click. */
const CLICK_THRESHOLD = 6;
/** Smallest nominal radius a drag can produce. */
const MIN_SIZE = 8;
const ACCENT = "#3b6fe0";

export interface InputOptions {
  engine: Engine;
  render: Render;
  isPaused(): boolean;
  getActiveTool(): ActiveTool;
  onSelectionUpdate(body: Body | null): void;
}

export interface Input {
  mouseConstraint: MouseConstraint;
  selection: Selection;
}

/**
 * Pointer handling. All click / select / spawn logic runs on native DOM events so it keeps working
 * while the simulation is paused (Matter's MouseConstraint events only fire on engine ticks). The
 * MouseConstraint itself is kept purely for grab-and-throw while playing.
 */
export function setupInput({ engine, render, isPaused, getActiveTool, onSelectionUpdate }: InputOptions): Input {
  const mouse = Mouse.create(render.canvas);

  // Matter reads the canvas pixel ratio with parseInt, so fractional ratios (1.25, 1.5 on
  // Windows display scaling) collapse to 1 and pointer positions end up scaled. Use the real value.
  const syncPixelRatio = (): void => {
    mouse.pixelRatio = render.options.pixelRatio ?? window.devicePixelRatio ?? 1;
  };
  syncPixelRatio();
  window.addEventListener("resize", syncPixelRatio);

  const mouseConstraint = MouseConstraint.create(engine, {
    mouse,
    constraint: {
      stiffness: 0.2,
      render: { visible: false },
    },
  });
  const grabMask = mouseConstraint.collisionFilter.mask ?? 0xffffffff;

  Composite.add(engine.world, mouseConstraint);
  render.mouse = mouse;

  const selection = createSelection({ render, isPaused, onSelectionUpdate });

  // --- Helpers ---------------------------------------------------------------------------------

  function canvasPoint(event: MouseEvent): Point {
    const rect = render.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function bodyAt(point: Point): Body | null {
    const hits = Query.point(Composite.allBodies(engine.world), point).filter((b) => !b.isStatic);
    return hits[hits.length - 1] ?? null;
  }

  function maxSize(): number {
    const w = render.options.width ?? render.canvas.clientWidth;
    const h = render.options.height ?? render.canvas.clientHeight;
    return Math.min(w, h) * 0.3;
  }

  function isShapeTool(): boolean {
    return getActiveTool().kind === "shape";
  }

  function isPolygonTool(): boolean {
    const tool = getActiveTool();
    return tool.kind === "shape" && tool.shape === "polygon";
  }

  function jointType(): JointType | null {
    const tool = getActiveTool();
    return tool.kind === "joint" ? tool.joint : null;
  }

  function isTwoClickJoint(type: JointType): boolean {
    return type === "revolute" || type === "rod";
  }

  // --- Gesture state ---------------------------------------------------------------------------

  let pressPoint: Point | null = null;
  /** Dynamic body under the pointer when pressed (throw while playing, select while paused). */
  let pressedBody: Body | null = null;
  /** Press point on empty space: a spawn gesture is in progress. */
  let spawnStart: Point | null = null;
  let dragged = false;
  /** Preview body for the drag-to-size gesture; becomes the real body on release. */
  let ghost: Body | null = null;
  let ghostSize = 0;
  let ghostColor: string | undefined;
  /** The press cleared a selection, so a plain click must not also spawn. */
  let clickOnlyDeselects = false;
  /** Paused move gesture: body centre relative to the pointer at press time. */
  let moveOffset: Point | null = null;
  /** Vertices of an in-progress polygon (polygon tool). */
  let draft: Point[] = [];
  /** Cursor position for rubber-band previews (polygon draft or pending joint). */
  let hover: Point | null = null;
  /** First attachment of a two-click joint (revolute / rod). */
  let jointAnchor: { body: Body; point: Point } | null = null;

  function applyCursor(): void {
    if (moveOffset) render.canvas.style.cursor = "grabbing";
    else if (isPolygonTool() || (jointType() && isPaused())) render.canvas.style.cursor = "crosshair";
    else render.canvas.style.cursor = "";
  }

  function setGrabEnabled(enabled: boolean): void {
    mouseConstraint.collisionFilter.mask = enabled ? grabMask : 0;
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

  function rebuildGhost(size: number): void {
    if (!spawnStart) return;
    const tool = getActiveTool();
    if (tool.kind !== "shape" || tool.shape === "polygon") return;
    ghost = createBody(tool.shape, spawnStart.x, spawnStart.y, size);
    // Keep one colour for the whole gesture so the preview does not flicker.
    ghostColor ??= ghost.render.fillStyle;
    ghost.render.fillStyle = ghostColor;
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
    if (grabIdle()) setGrabEnabled(true);
    applyCursor();
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  function dropDraftIfToolChanged(): void {
    if (!isPolygonTool() && draft.length > 0) clearDraft();
  }

  function dropJointAnchorIfToolChanged(): void {
    if (!jointAnchor) return;
    const type = jointType();
    if (!isPaused() || !type || !isTwoClickJoint(type)) clearJointAnchor();
  }

  function placeJoint(type: JointType, body: Body, point: Point): void {
    if (type === "pin") {
      Composite.add(engine.world, createPin(body, point));
      return;
    }
    if (!jointAnchor) {
      jointAnchor = { body, point };
      setGrabEnabled(false);
      return;
    }
    if (jointAnchor.body === body) return;
    const constraint =
      type === "revolute"
        ? createRevolute(jointAnchor.body, jointAnchor.point, body, point)
        : createRod(jointAnchor.body, jointAnchor.point, body, point);
    Composite.add(engine.world, constraint);
    clearJointAnchor();
  }

  // --- Events ----------------------------------------------------------------------------------

  render.canvas.addEventListener("mousemove", (event) => {
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    hover = canvasPoint(event);
    if (!moveOffset) applyCursor();
  });

  render.canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    // The selection module intercepts handle presses in the capture phase before we get here.
    const p = canvasPoint(event);
    pressPoint = p;

    const type = jointType();
    if (type) {
      pressedBody = bodyAt(p);
      if (isPaused()) {
        // Joint placement instead of select / move / spawn.
        if (!pressedBody) {
          clickOnlyDeselects = selection.selected !== null || jointAnchor !== null;
          selection.deselect();
        }
        setGrabEnabled(false);
      } else if (!pressedBody) {
        // Playing: no spawn; empty presses should not grab.
        selection.deselect();
        setGrabEnabled(false);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }

    if (isPolygonTool() && draft.length > 0) {
      // Mid-draw: clicks add vertices even over existing bodies.
      pressedBody = null;
      setGrabEnabled(false);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }

    pressedBody = bodyAt(p);

    if (!pressedBody) {
      // Any press on empty space clears the selection. A plain click then only deselects, but a
      // drag still sizes and spawns a new shape (primitives only).
      clickOnlyDeselects = selection.selected !== null;
      selection.deselect();
      if (!isPolygonTool()) spawnStart = p;
      setGrabEnabled(false);
    } else if (isPaused()) {
      // Paused: the press selects right away and dragging repositions the shape.
      selection.select(pressedBody);
      moveOffset = { x: pressedBody.position.x - p.x, y: pressedBody.position.y - p.y };
      applyCursor();
    }
    // Playing with a body under the pointer: the mouse constraint handles grab-and-throw.

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  render.canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (!isPolygonTool()) return;

    if (draft.length >= 2) {
      const last = draft[draft.length - 1];
      const prev = draft[draft.length - 2];
      if (Math.hypot(last.x - prev.x, last.y - prev.y) <= CLICK_THRESHOLD) {
        draft.pop();
      }
    }

    if (draft.length < 3) return;

    const body = createPolygon(draft);
    if (body) Composite.add(engine.world, body);
    clearDraft();
    applyCursor();
  });

  function onMove(event: MouseEvent): void {
    if (!pressPoint) return;
    const p = canvasPoint(event);
    hover = p;

    if (moveOffset && pressedBody) {
      // Velocity is left untouched (freeze-frame edit): the shape resumes its prior motion on Play.
      Body.setPosition(pressedBody, { x: p.x + moveOffset.x, y: p.y + moveOffset.y });
      return;
    }

    if (!spawnStart || isPolygonTool() || !isShapeTool()) return;
    const dist = Math.hypot(p.x - spawnStart.x, p.y - spawnStart.y);
    if (!dragged && dist <= CLICK_THRESHOLD) return;

    dragged = true;
    const size = Math.min(Math.max(dist, MIN_SIZE), maxSize());
    if (!ghost || Math.abs(size - ghostSize) > 0.5) {
      rebuildGhost(size);
    }
  }

  function onUp(event: MouseEvent): void {
    if (!pressPoint) return;
    const p = canvasPoint(event);
    const isClick = Math.hypot(p.x - pressPoint.x, p.y - pressPoint.y) <= CLICK_THRESHOLD;
    const type = jointType();

    if (type) {
      if (isPaused() && isClick) {
        if (!pressedBody) {
          clearJointAnchor();
        } else {
          placeJoint(type, pressedBody, pressPoint);
        }
      }
    } else if (isPolygonTool()) {
      if (isClick && event.detail === 1 && !clickOnlyDeselects && !pressedBody) {
        draft.push(p);
        hover = p;
        setGrabEnabled(false);
      }
    } else if (spawnStart) {
      if (dragged && ghost) {
        Composite.add(engine.world, ghost);
      } else if (isClick && !clickOnlyDeselects) {
        const tool = getActiveTool();
        if (tool.kind === "shape" && tool.shape !== "polygon") {
          Composite.add(engine.world, createBody(tool.shape, spawnStart.x, spawnStart.y, DEFAULT_SIZE));
        }
      }
    }
    // Paused body presses were selected on mousedown (and moved on drag); nothing more to do.
    // Drags on a body while playing are throws handled by the mouse constraint.

    reset();
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    clearJointAnchor();
  });

  // --- Ghost / draft / joint preview -----------------------------------------------------------

  Events.on(render, "afterRender", () => {
    dropDraftIfToolChanged();
    dropJointAnchorIfToolChanged();
    const ctx = render.context;

    if (ghost) {
      ctx.save();
      ctx.beginPath();
      if (ghost.circleRadius) {
        ctx.arc(ghost.position.x, ghost.position.y, ghost.circleRadius, 0, Math.PI * 2);
      } else {
        const v = ghost.vertices;
        ctx.moveTo(v[0].x, v[0].y);
        for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
        ctx.closePath();
      }
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = ghost.render.fillStyle ?? "#888";
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ACCENT;
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
    ctx.save();
    if (preview.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(preview[0].x, preview[0].y);
      for (let i = 1; i < preview.length; i++) ctx.lineTo(preview[i].x, preview[i].y);
      ctx.closePath();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.moveTo(preview[0].x, preview[0].y);
    for (let i = 1; i < preview.length; i++) ctx.lineTo(preview[i].x, preview[i].y);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = ACCENT;
    for (const vertex of draft) {
      ctx.beginPath();
      ctx.arc(vertex.x, vertex.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });

  // Stop the browser from treating drags as text selection / scroll gestures.
  render.canvas.style.touchAction = "none";
  applyCursor();

  return { mouseConstraint, selection };
}
