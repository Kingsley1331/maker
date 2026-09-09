import {
  Box,
  MouseJoint,
  type Body,
  type ChainShape,
  type CircleShape,
  type EdgeShape,
  type Joint,
  type PolygonShape,
  type Vec2Value,
  World,
} from "planck";
import { connectedBodies, translateGroup } from "./group";
import { getAngleLimitArc, getTravelLimitSegment, jointDrawEndsPx, jointEndHit, jointSelectDistPx, MOTOR_JOINT_HIT_PX, type JointEnd } from "./joints";
import {
  FIXTURE,
  getBodyData,
  getDefaultDamping,
  getDefaultFriction,
  getDefaultRestitution,
  isPickable,
  setBodyDamping,
  setBodyFriction,
  setBodyRestitution,
  setDefaultDamping,
  setDefaultFriction,
  setDefaultRestitution,
  type BodyUserData,
  type JointUserData,
} from "./shapes";
import { GRAVITY_SCALE, toMeters, toPixels, vecToMeters, vecToPixels, type Point } from "./units";

const WALL_THICKNESS = 200;
const WALL_FILL = "#22262e";
const JOINT_ACCENT = "#3b6fe0";
/** Click distance to a drawn edge, in screen pixels. */
const EDGE_HIT_PX = 8;
/** Drawn thickness of an edge segment, in world pixels. */
const EDGE_STROKE_PX = 3;
const STEP = 1 / 60;
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;

export const DEFAULT_BACKGROUND = "#ffffff";
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export type AfterRender = (ctx: CanvasRenderingContext2D) => void;

export interface Physics {
  world: World;
  ground: Body;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  getSize(): { w: number; h: number };
  getZoom(): number;
  /**
   * View zoom. Omitting `anchorScreen` zooms about the viewport centre; zoom 1 in that case also
   * zeros the offset (identity view). With an anchor (wheel), the world point under that screen
   * pixel stays put.
   */
  setZoom(zoom: number, anchorScreen?: Point): void;
  screenToWorld(p: Point): Point;
  /** Shift the view by screen-pixel deltas. Does not change zoom. */
  panBy(dx: number, dy: number): void;
  /** Current view offset in screen pixels. */
  getOffset(): Point;
  /** Set zoom and offset directly (used when restoring a saved scene). */
  setView(zoom: number, offset: Point): void;
  setGravity(x: number, y: number): void;
  /** Gravity in toolbar units (inverse of `setGravity`). */
  getGravity(): Point;
  setBackground(color: string): void;
  getBackground(): string;
  /** When on, boundary walls are removed and shapes wrap around the canvas. */
  setWrapEnabled(on: boolean): void;
  isWrapEnabled(): boolean;
  /** World-pixel offsets used to draw / hit-test wrap copies. Identity when wrap is off. */
  getWrapOffsets(): Point[];
  /** Default bounce for walls and bodies that have not overridden elasticity. */
  setWorldRestitution(value: number): void;
  /** Surface friction for walls and user shapes. */
  setWorldFriction(value: number): void;
  /** Linear and angular damping for user shapes. */
  setWorldDamping(value: number): void;
  /** Stop stepping the simulation. Rendering continues. */
  pause(): void;
  /** Resume stepping the simulation. */
  play(): void;
  isPaused(): boolean;
  onAfterRender(cb: AfterRender): void;
  bodyAt(point: Point): Body | null;
  /** Nearest scene joint whose drawing is within ~10 screen px. */
  jointAt(point: Point): Joint | null;
  /** Nearest drawn joint end (not the rail) within ~10 screen px. */
  jointEndAt(point: Point): { joint: Joint; end: JointEnd } | null;
  /** Highlight this joint (or none). */
  setSelectedJoint(joint: Joint | null): void;
  /** Pulse this joint end on hover (or none). */
  setHoveredJoint(joint: Joint | null, end?: JointEnd | null): void;
}

function sceneSize(container: HTMLElement): { w: number; h: number } {
  return {
    w: Math.max(1, container.clientWidth),
    h: Math.max(1, container.clientHeight),
  };
}

export function bodyBoundsPx(body: Body): { min: Point; max: Point } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const children = f.getShape().getChildCount();
    for (let i = 0; i < children; i++) {
      const aabb = f.getAABB(i);
      minX = Math.min(minX, aabb.lowerBound.x);
      minY = Math.min(minY, aabb.lowerBound.y);
      maxX = Math.max(maxX, aabb.upperBound.x);
      maxY = Math.max(maxY, aabb.upperBound.y);
    }
  }
  if (!Number.isFinite(minX)) {
    const p = vecToPixels(body.getPosition());
    return { min: p, max: p };
  }
  return { min: vecToPixels({ x: minX, y: minY }), max: vecToPixels({ x: maxX, y: maxY }) };
}

/**
 * Tile offsets for wrap copies: identity when off; otherwise a 3×3 grid around the canvas plus,
 * for every extra tile index in `tiles`, the 3×3 grid that brings that tile onto the canvas.
 * Groups are wrapped by their centroid, so a member of a stretched group (a slider run far off
 * its rail) can sit several canvases away; its tile is added here so it still has a visible copy.
 */
export function wrapOffsets(
  size: { w: number; h: number },
  enabled: boolean,
  tiles: Point[] = [],
): Point[] {
  if (!enabled) return [{ x: 0, y: 0 }];
  const seen = new Set<string>();
  const out: Point[] = [];
  const add = (ti: number, tj: number): void => {
    for (let j = tj - 1; j <= tj + 1; j++) {
      for (let i = ti - 1; i <= ti + 1; i++) {
        const key = `${i},${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x: i * size.w, y: j * size.h });
      }
    }
  };
  add(0, 0);
  for (const t of tiles) add(t.x, t.y);
  return out;
}

/** Integer tile (multiples of the canvas) whose copy of world-pixel `p` lands on the canvas. */
function tileFor(p: Point, size: { w: number; h: number }): Point {
  return { x: -Math.floor(p.x / size.w), y: -Math.floor(p.y / size.h) };
}

/** Draw `fn` once per wrap offset, translating the context for copies. */
export function withWrapOffsets(
  ctx: CanvasRenderingContext2D,
  offsets: Point[],
  fn: () => void,
): void {
  for (const o of offsets) {
    if (o.x === 0 && o.y === 0) {
      fn();
      continue;
    }
    ctx.save();
    ctx.translate(o.x, o.y);
    fn();
    ctx.restore();
  }
}

/** Map `point` onto the wrap copy nearest `around` (used while dragging across a seam). */
export function nearestWrapPoint(point: Point, around: Point, offsets: Point[]): Point {
  let best = point;
  let bestDist = Infinity;
  for (const o of offsets) {
    const q = { x: point.x - o.x, y: point.y - o.y };
    const d = (q.x - around.x) ** 2 + (q.y - around.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

function wrapDelta(value: number, span: number): number {
  if (!(span > 0) || !Number.isFinite(value)) return 0;
  const wrapped = ((value % span) + span) % span;
  return wrapped - value;
}

export function createPhysics(container: HTMLElement): Physics {
  const world = new World({ gravity: { x: 0, y: 0 } });
  const ground = world.createBody({
    type: "static",
    userData: { kind: "ground", label: "Ground", fillStyle: "transparent" } satisfies BodyUserData,
  });

  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create 2D canvas context");
  const ctx: CanvasRenderingContext2D = context;

  let walls: Body[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastDpr = 0;
  let background = DEFAULT_BACKGROUND;
  let paused = false;
  let wrapEnabled = false;
  let size = { w: 1, h: 1 };
  let zoom = 1;
  let offset = { x: 0, y: 0 };
  const afterRender: AfterRender[] = [];
  let selectedJoint: Joint | null = null;
  let hoveredJoint: Joint | null = null;
  let hoveredEnd: JointEnd | null = null;

  function screenToWorld(p: Point): Point {
    return {
      x: (p.x - offset.x) / zoom,
      y: (p.y - offset.y) / zoom,
    };
  }

  function setZoom(next: number, anchorScreen?: Point): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (z === 1 && anchorScreen === undefined) {
      zoom = 1;
      offset = { x: 0, y: 0 };
      return;
    }
    const anchor = anchorScreen ?? { x: size.w / 2, y: size.h / 2 };
    const world = screenToWorld(anchor);
    zoom = z;
    offset = { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom };
  }

  function panBy(dx: number, dy: number): void {
    offset = { x: offset.x + dx, y: offset.y + dy };
  }

  function currentWrapOffsets(): Point[] {
    if (!wrapEnabled) return wrapOffsets(size, false);
    const tiles: Point[] = [];
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body)) continue;
      const t = tileFor(vecToPixels(body.getPosition()), size);
      if (t.x !== 0 || t.y !== 0) tiles.push(t);
    }
    return wrapOffsets(size, true, tiles);
  }

  /** Does the world-pixel box, shifted by wrap offset `o`, overlap the visible view? */
  function copyInView(min: Point, max: Point, o: Point, view: { min: Point; max: Point }): boolean {
    return (
      min.x + o.x <= view.max.x &&
      max.x + o.x >= view.min.x &&
      min.y + o.y <= view.max.y &&
      max.y + o.y >= view.min.y
    );
  }

  function wrapBodies(): void {
    if (!wrapEnabled) return;
    const spanX = toMeters(size.w);
    const spanY = toMeters(size.h);
    const seen = new Set<Body>();
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body) || seen.has(body)) continue;
      const group = connectedBodies(body);
      for (const member of group) seen.add(member);
      let cx = 0;
      let cy = 0;
      for (const member of group) {
        const p = member.getPosition();
        cx += p.x;
        cy += p.y;
      }
      const n = group.length;
      const dx = wrapDelta(cx / n, spanX);
      const dy = wrapDelta(cy / n, spanY);
      if (dx === 0 && dy === 0) continue;
      translateGroup(group, { x: dx, y: dy });
      // A grab (mouse joint) targets a world point; carry it along or the spring would haul the
      // group a whole screen back toward the stale target.
      for (const member of group) {
        for (let edge = member.getJointList(); edge; edge = edge.next) {
          const joint = edge.joint;
          if (!joint || joint.getType() !== MouseJoint.TYPE || joint.getBodyB() !== member) continue;
          const t = (joint as MouseJoint).getTarget();
          (joint as MouseJoint).setTarget({ x: t.x + dx, y: t.y + dy });
        }
      }
    }
  }

  function buildWalls(w: number, h: number): void {
    for (const wall of walls) world.destroyBody(wall);
    walls = [];
    if (wrapEnabled) return;

    const half = WALL_THICKNESS / 2;
    const wallData: BodyUserData = { kind: "wall", label: "Wall", fillStyle: WALL_FILL };

    function wallBox(cx: number, cy: number, hw: number, hh: number): Body {
      const body = world.createBody({
        type: "static",
        position: vecToMeters({ x: cx, y: cy }),
        userData: wallData,
      });
      body.createFixture({
        shape: new Box(vecToMeters({ x: hw, y: hh }).x, vecToMeters({ x: hw, y: hh }).y),
        ...FIXTURE,
        density: 0,
      });
      return body;
    }

    walls = [
      wallBox(w / 2, h + half, w / 2 + WALL_THICKNESS, half),
      wallBox(w / 2, -half, w / 2 + WALL_THICKNESS, half),
      wallBox(-half, h / 2, half, h / 2 + WALL_THICKNESS),
      wallBox(w + half, h / 2, half, h / 2 + WALL_THICKNESS),
    ];
  }

  function resize(): void {
    const { w, h } = sceneSize(container);
    const dpr = window.devicePixelRatio || 1;
    if (w === lastW && h === lastH && dpr === lastDpr) return;
    lastW = w;
    lastH = h;
    lastDpr = dpr;
    size = { w, h };

    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildWalls(w, h);
  }

  function drawBody(body: Body): void {
    const data = getBodyData(body);
    if (!data || data.kind === "ground") return;
    ctx.fillStyle = data.fillStyle;
    const strokeShape = data.kind === "shape";
    if (strokeShape) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = 0.5;
      ctx.lineJoin = "round";
    }

    if (data.outline && data.outline.length >= 3) {
      ctx.beginPath();
      function traceRing(ring: Point[]): void {
        const first = body.getWorldPoint(ring[0]);
        ctx.moveTo(toPixels(first.x), toPixels(first.y));
        for (let i = 1; i < ring.length; i++) {
          const p = body.getWorldPoint(ring[i]);
          ctx.lineTo(toPixels(p.x), toPixels(p.y));
        }
        ctx.closePath();
      }
      traceRing(data.outline);
      const holes = data.holes ?? [];
      if (holes.length > 0) {
        for (const hole of holes) {
          if (hole.length >= 3) traceRing(hole);
        }
        ctx.fill("evenodd");
      } else {
        ctx.fill();
      }
      if (strokeShape) ctx.stroke();
      return;
    }

    for (let f = body.getFixtureList(); f; f = f.getNext()) {
      const shape = f.getShape();
      if (shape.getType() === "circle") {
        const circle = shape as CircleShape;
        const c = body.getWorldPoint(circle.getCenter());
        ctx.beginPath();
        ctx.arc(toPixels(c.x), toPixels(c.y), toPixels(circle.getRadius()), 0, Math.PI * 2);
        ctx.fill();
        if (strokeShape) ctx.stroke();
      } else if (shape.getType() === "polygon") {
        const poly = shape as PolygonShape;
        if (poly.m_count < 3) continue;
        ctx.beginPath();
        for (let i = 0; i < poly.m_count; i++) {
          const p = body.getWorldPoint(poly.m_vertices[i]);
          const x = toPixels(p.x);
          const y = toPixels(p.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        if (strokeShape) ctx.stroke();
      } else if (shape.getType() === "edge") {
        const edge = shape as EdgeShape;
        const p1 = body.getWorldPoint(edge.m_vertex1);
        const p2 = body.getWorldPoint(edge.m_vertex2);
        ctx.beginPath();
        ctx.moveTo(toPixels(p1.x), toPixels(p1.y));
        ctx.lineTo(toPixels(p2.x), toPixels(p2.y));
        ctx.save();
        ctx.strokeStyle = data.fillStyle;
        ctx.lineWidth = EDGE_STROKE_PX;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();
      } else if (shape.getType() === "chain") {
        const chain = shape as ChainShape;
        if (chain.m_count < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < chain.m_count; i++) {
          const p = body.getWorldPoint(chain.m_vertices[i]);
          const x = toPixels(p.x);
          const y = toPixels(p.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.save();
        ctx.strokeStyle = data.fillStyle;
        ctx.lineWidth = EDGE_STROKE_PX;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawJoint(joint: Joint): void {
    if (joint.getType() === MouseJoint.TYPE) return;
    const data = joint.getUserData() as JointUserData | undefined;
    const a = joint.getAnchorA();
    const b = joint.getAnchorB();
    const ax = toPixels(a.x);
    const ay = toPixels(a.y);
    const bx = toPixels(b.x);
    const by = toPixels(b.y);
    ctx.save();
    ctx.fillStyle = JOINT_ACCENT;
    ctx.strokeStyle = JOINT_ACCENT;
    if (
      data?.kind === "rod" ||
      data?.kind === "weld" ||
      data?.kind === "wheel" ||
      data?.kind === "prismatic"
    ) {
      let x1 = ax;
      let y1 = ay;
      let x2 = bx;
      let y2 = by;
      if (data.localA && data.localB) {
        const wa = joint.getBodyA().getWorldPoint(data.localA);
        const wb = joint.getBodyB().getWorldPoint(data.localB);
        x1 = toPixels(wa.x);
        y1 = toPixels(wa.y);
        x2 = toPixels(wb.x);
        y2 = toPixels(wb.y);
      }
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x2, y2, 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (data.kind === "wheel") {
        // Chassis (non-rotating) end: a short tick so it is not confused with the hub.
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        const nx = len > 1e-6 ? -dy / len : 0;
        const ny = len > 1e-6 ? dx / len : 1;
        const tick = 5;
        ctx.beginPath();
        ctx.moveTo(x1 - nx * tick, y1 - ny * tick);
        ctx.lineTo(x1 + nx * tick, y1 + ny * tick);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x1, y1, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(bx, by, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (joint === selectedJoint) {
      const ends = jointDrawEndsPx(joint);
      if (ends) {
        ctx.lineWidth = 2;
        const same = Math.hypot(ends.a.x - ends.b.x, ends.a.y - ends.b.y) < 1;
        ctx.beginPath();
        ctx.arc(ends.b.x, ends.b.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        if (!same) {
          ctx.beginPath();
          ctx.arc(ends.a.x, ends.a.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        const hub = ends.b;
        const arc = getAngleLimitArc(joint);
        if (arc) {
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(hub.x, hub.y, 14, arc.start, arc.end);
          ctx.stroke();
        }
        const travel = getTravelLimitSegment(joint);
        if (travel) {
          const dx = travel.to.x - travel.from.x;
          const dy = travel.to.y - travel.from.y;
          const len = Math.hypot(dx, dy);
          const nx = len > 1e-6 ? -dy / len : 1;
          const ny = len > 1e-6 ? dx / len : 0;
          const tick = 6;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(travel.from.x, travel.from.y);
          ctx.lineTo(travel.to.x, travel.to.y);
          for (const end of [travel.from, travel.to]) {
            ctx.moveTo(end.x - nx * tick, end.y - ny * tick);
            ctx.lineTo(end.x + nx * tick, end.y + ny * tick);
          }
          ctx.stroke();
        }
      }
    }
    if (joint === hoveredJoint) {
      const ends = jointDrawEndsPx(joint);
      const pulseAt = hoveredEnd === "a" ? ends?.a : ends?.b;
      if (pulseAt) {
        const wave = 0.5 + 0.5 * Math.sin((performance.now() / 700) * Math.PI * 2);
        const radius = joint === selectedJoint ? 12 + 3 * wave : 9 + 2.5 * wave;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.35 + 0.5 * wave;
        ctx.beginPath();
        ctx.arc(pulseAt.x, pulseAt.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function paint(): void {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size.w, size.h);

    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(zoom, zoom);

    if (!wrapEnabled) {
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (getBodyData(body)?.kind === "wall") drawBody(body);
      }
    }
    const offsets = currentWrapOffsets();
    const cull = offsets.length > 1;
    // Visible region in world pixels; with many wrap tiles only the copies over it are drawn.
    const view = { min: screenToWorld({ x: 0, y: 0 }), max: screenToWorld({ x: size.w, y: size.h }) };
    const bodyBounds = new Map<Body, { min: Point; max: Point }>();
    const jointBounds = new Map<Joint, { min: Point; max: Point }>();
    if (cull) {
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (getBodyData(body)?.kind !== "wall") bodyBounds.set(body, bodyBoundsPx(body));
      }
      for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
        // The selected joint also draws its limit arc / travel segment; never cull it.
        if (joint === selectedJoint) continue;
        const ends = jointDrawEndsPx(joint);
        if (!ends) continue;
        const pad = 24;
        jointBounds.set(joint, {
          min: { x: Math.min(ends.a.x, ends.b.x) - pad, y: Math.min(ends.a.y, ends.b.y) - pad },
          max: { x: Math.max(ends.a.x, ends.b.x) + pad, y: Math.max(ends.a.y, ends.b.y) + pad },
        });
      }
    }
    for (const o of offsets) {
      ctx.save();
      ctx.translate(o.x, o.y);
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (getBodyData(body)?.kind === "wall") continue;
        const b = bodyBounds.get(body);
        if (b && !copyInView(b.min, b.max, o, view)) continue;
        drawBody(body);
      }
      for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
        const b = jointBounds.get(joint);
        if (b && !copyInView(b.min, b.max, o, view)) continue;
        drawJoint(joint);
      }
      ctx.restore();
    }
    for (const cb of afterRender) cb(ctx);
    ctx.restore();
  }

  let last = performance.now();
  let acc = 0;
  function tick(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!paused) {
      acc += dt;
      while (acc >= STEP) {
        world.step(STEP, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
        acc -= STEP;
      }
    }
    wrapBodies();
    paint();
    requestAnimationFrame(tick);
  }

  function distToSegmentPx(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function bodyAt(point: Point): Body | null {
    const offsets = currentWrapOffsets();
    let edgeHit: Body | null = null;
    let edgeDist = EDGE_HIT_PX / zoom;
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body)) continue;
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        const p: Vec2Value = vecToMeters(q);
        for (let f = body.getFixtureList(); f; f = f.getNext()) {
          const shape = f.getShape();
          if (shape.getType() === "edge") {
            const edge = shape as EdgeShape;
            const a = body.getWorldPoint(edge.m_vertex1);
            const b = body.getWorldPoint(edge.m_vertex2);
            const dist = distToSegmentPx(q, { x: toPixels(a.x), y: toPixels(a.y) }, { x: toPixels(b.x), y: toPixels(b.y) });
            if (dist <= edgeDist) {
              edgeHit = body;
              edgeDist = dist;
            }
          } else if (shape.getType() === "chain") {
            const chain = shape as ChainShape;
            for (let i = 0; i < chain.m_count - 1; i++) {
              const a = body.getWorldPoint(chain.m_vertices[i]);
              const b = body.getWorldPoint(chain.m_vertices[i + 1]);
              const dist = distToSegmentPx(
                q,
                { x: toPixels(a.x), y: toPixels(a.y) },
                { x: toPixels(b.x), y: toPixels(b.y) },
              );
              if (dist <= edgeDist) {
                edgeHit = body;
                edgeDist = dist;
              }
            }
          } else if (f.testPoint(p)) {
            return body;
          }
        }
      }
    }
    return edgeHit;
  }

  function nearestMotorJoint(
    point: Point,
    distOf: (joint: Joint, q: Point) => number | null,
  ): Joint | null {
    const offsets = currentWrapOffsets();
    let best: Joint | null = null;
    let bestDist = MOTOR_JOINT_HIT_PX / zoom;
    for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
      if (joint.getType() === MouseJoint.TYPE) continue;
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        const dist = distOf(joint, q);
        if (dist !== null && dist <= bestDist) {
          best = joint;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  function jointAt(point: Point): Joint | null {
    return nearestMotorJoint(point, jointSelectDistPx);
  }

  function jointEndAt(point: Point): { joint: Joint; end: JointEnd } | null {
    const offsets = currentWrapOffsets();
    let best: { joint: Joint; end: JointEnd } | null = null;
    let bestDist = MOTOR_JOINT_HIT_PX / zoom;
    for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
      if (joint.getType() === MouseJoint.TYPE) continue;
      for (const o of offsets) {
        const q = { x: point.x - o.x, y: point.y - o.y };
        const end = jointEndHit(joint, q, bestDist);
        if (!end) continue;
        const ends = jointDrawEndsPx(joint);
        if (!ends) continue;
        const pt = end === "a" ? ends.a : ends.b;
        const dist = Math.hypot(q.x - pt.x, q.y - pt.y);
        if (dist <= bestDist) {
          best = { joint, end };
          bestDist = dist;
        }
      }
    }
    return best;
  }

  new ResizeObserver(resize).observe(container);
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(tick);

  return {
    world,
    ground,
    canvas,
    ctx,
    getSize: () => size,
    getZoom: () => zoom,
    setZoom,
    screenToWorld,
    panBy,
    getOffset: () => ({ x: offset.x, y: offset.y }),
    setView(nextZoom: number, nextOffset: Point): void {
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      offset = { x: nextOffset.x, y: nextOffset.y };
    },
    setGravity(x: number, y: number): void {
      world.setGravity({ x: x * GRAVITY_SCALE, y: y * GRAVITY_SCALE });
    },
    getGravity(): Point {
      const g = world.getGravity();
      return { x: g.x / GRAVITY_SCALE, y: g.y / GRAVITY_SCALE };
    },
    setWorldRestitution(value: number): void {
      setDefaultRestitution(value);
      const r = getDefaultRestitution();
      for (const wall of walls) {
        for (let f = wall.getFixtureList(); f; f = f.getNext()) f.setRestitution(r);
      }
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (!isPickable(body)) continue;
        if (getBodyData(body)?.restitutionOverride !== undefined) continue;
        setBodyRestitution(body, r, false);
      }
    },
    setWorldFriction(value: number): void {
      setDefaultFriction(value);
      const mu = getDefaultFriction();
      for (const wall of walls) {
        for (let f = wall.getFixtureList(); f; f = f.getNext()) f.setFriction(mu);
      }
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (!isPickable(body)) continue;
        setBodyFriction(body, mu);
      }
    },
    setWorldDamping(value: number): void {
      setDefaultDamping(value);
      const d = getDefaultDamping();
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (!isPickable(body)) continue;
        setBodyDamping(body, d);
      }
    },
    setBackground(color: string): void {
      background = color;
    },
    getBackground: () => background,
    setWrapEnabled(on: boolean): void {
      if (wrapEnabled === on) return;
      wrapEnabled = on;
      buildWalls(size.w, size.h);
      if (wrapEnabled) wrapBodies();
    },
    isWrapEnabled: () => wrapEnabled,
    getWrapOffsets: currentWrapOffsets,
    pause(): void {
      if (paused) return;
      paused = true;
      acc = 0;
    },
    play(): void {
      if (!paused) return;
      paused = false;
      last = performance.now();
      acc = 0;
    },
    isPaused: () => paused,
    onAfterRender(cb: AfterRender): void {
      afterRender.push(cb);
    },
    bodyAt,
    jointAt,
    jointEndAt,
    setSelectedJoint(joint: Joint | null): void {
      selectedJoint = joint;
    },
    setHoveredJoint(joint: Joint | null, end: JointEnd | null = null): void {
      hoveredJoint = joint;
      hoveredEnd = joint ? end : null;
    },
  };
}
