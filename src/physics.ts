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
import { getAngleLimitArc, jointPivotPx, MOTOR_JOINT_HIT_PX } from "./joints";
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
  /** Nearest pin / revolute / wheel whose drawn pivot is within ~10 screen px. */
  jointAt(point: Point): Joint | null;
  /** Highlight this motor joint's pivot (or none). */
  setSelectedJoint(joint: Joint | null): void;
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

/** Tile offsets for wrap copies: identity, or a 3×3 grid around the canvas. */
export function wrapOffsets(size: { w: number; h: number }, enabled: boolean): Point[] {
  if (!enabled) return [{ x: 0, y: 0 }];
  const out: Point[] = [];
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      out.push({ x: i * size.w, y: j * size.h });
    }
  }
  return out;
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
    return wrapOffsets(size, wrapEnabled);
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
      if (dx !== 0 || dy !== 0) translateGroup(group, { x: dx, y: dy });
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
    if (data?.kind === "rod" || data?.kind === "weld" || data?.kind === "wheel") {
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
      ctx.arc(x1, y1, 3.5, 0, Math.PI * 2);
      ctx.arc(x2, y2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(bx, by, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (joint === selectedJoint) {
      const pivot = jointPivotPx(joint);
      if (pivot) {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pivot.x, pivot.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        // Allowed sweep of the angle limit, drawn just outside the selection ring.
        const arc = getAngleLimitArc(joint);
        if (arc) {
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(pivot.x, pivot.y, 14, arc.start, arc.end);
          ctx.stroke();
        }
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
    withWrapOffsets(ctx, currentWrapOffsets(), () => {
      for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
        if (getBodyData(body)?.kind !== "wall") drawBody(body);
      }
      for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
        drawJoint(joint);
      }
    });
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

  function jointAt(point: Point): Joint | null {
    const offsets = currentWrapOffsets();
    let best: Joint | null = null;
    let bestDist = MOTOR_JOINT_HIT_PX / zoom;
    for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
      if (joint.getType() === MouseJoint.TYPE) continue;
      const pivot = jointPivotPx(joint);
      if (!pivot) continue;
      for (const o of offsets) {
        const dist = Math.hypot(point.x - o.x - pivot.x, point.y - o.y - pivot.y);
        if (dist <= bestDist) {
          best = joint;
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
    setSelectedJoint(joint: Joint | null): void {
      selectedJoint = joint;
    },
  };
}
