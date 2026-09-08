import {
  Box,
  MouseJoint,
  type Body,
  type CircleShape,
  type Joint,
  type PolygonShape,
  type Vec2Value,
  World,
} from "planck";
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
import { GRAVITY_SCALE, toPixels, vecToMeters, vecToPixels, type Point } from "./units";

const WALL_THICKNESS = 200;
const WALL_FILL = "#22262e";
const JOINT_ACCENT = "#3b6fe0";
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
  setGravity(x: number, y: number): void;
  setBackground(color: string): void;
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
    const aabb = f.getAABB(0);
    minX = Math.min(minX, aabb.lowerBound.x);
    minY = Math.min(minY, aabb.lowerBound.y);
    maxX = Math.max(maxX, aabb.upperBound.x);
    maxY = Math.max(maxY, aabb.upperBound.y);
  }
  if (!Number.isFinite(minX)) {
    const p = vecToPixels(body.getPosition());
    return { min: p, max: p };
  }
  return { min: vecToPixels({ x: minX, y: minY }), max: vecToPixels({ x: maxX, y: maxY }) };
}

export function createPhysics(container: HTMLElement): Physics {
  const world = new World({ gravity: { x: 0, y: GRAVITY_SCALE } });
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

  function buildWalls(w: number, h: number): void {
    for (const wall of walls) world.destroyBody(wall);

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
      if (data.hole && data.hole.length >= 3) {
        traceRing(data.hole);
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

    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (getBodyData(body)?.kind === "wall") drawBody(body);
    }
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (getBodyData(body)?.kind !== "wall") drawBody(body);
    }
    for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
      drawJoint(joint);
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
    paint();
    requestAnimationFrame(tick);
  }

  function bodyAt(point: Point): Body | null {
    const p: Vec2Value = vecToMeters(point);
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body)) continue;
      for (let f = body.getFixtureList(); f; f = f.getNext()) {
        if (f.testPoint(p)) return body;
      }
    }
    return null;
  }

  function jointAt(point: Point): Joint | null {
    let best: Joint | null = null;
    let bestDist = MOTOR_JOINT_HIT_PX / zoom;
    for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
      if (joint.getType() === MouseJoint.TYPE) continue;
      const pivot = jointPivotPx(joint);
      if (!pivot) continue;
      const dist = Math.hypot(point.x - pivot.x, point.y - pivot.y);
      if (dist <= bestDist) {
        best = joint;
        bestDist = dist;
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
    setGravity(x: number, y: number): void {
      world.setGravity({ x: x * GRAVITY_SCALE, y: y * GRAVITY_SCALE });
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
