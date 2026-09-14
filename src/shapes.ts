import { Box, Chain, Circle, Edge, Polygon, Settings, type Body, type World } from "planck";
import decomp from "poly-decomp";
import {
  DENSITY,
  FRICTION,
  LINEAR_DAMPING,
  RESTITUTION,
  type Point,
  toMeters,
  vecToMeters,
} from "./units";

Settings.maxPolygonVertices = 16;
/** Restitution is applied at all impact speeds; the default 1 m/s cutoff made high-bounce feel inelastic. */
Settings.velocityThreshold = 0;

export type PrimitiveShape = "circle" | "rectangle" | "triangle" | "pentagon" | "hexagon";
export type ShapeType = PrimitiveShape | "polygon" | "box" | "frame" | "edge" | "chain";

export const PRIMITIVE_SHAPES: PrimitiveShape[] = [
  "circle",
  "rectangle",
  "triangle",
  "pentagon",
  "hexagon",
];

export const SHAPE_TYPES: ShapeType[] = [...PRIMITIVE_SHAPES, "box", "frame", "edge", "chain", "polygon"];

export function isPrimitiveShape(value: ShapeType): value is PrimitiveShape {
  return (PRIMITIVE_SHAPES as readonly ShapeType[]).includes(value);
}

/** Pale blue-leaning duck egg; used for newly spawned shapes. */
export const DEFAULT_FILL = "#b8d8e4";

export const DEFAULT_SIZE = 28;

/** Default wall thickness for four-sided frames (px). */
export const DEFAULT_WALL_THICKNESS = 12;
/** Smallest wall thickness the toolbar / spawn path will use (px). */
export const MIN_WALL_THICKNESS = 2;
/** Inner opening kept when clamping a frame so the hole never collapses (px). */
const FRAME_INNER_GAP = 4;

export type { Point };

/** `ghost`: invisible wrap-mode mirror of a shape (see wrap-ghosts.ts); never pickable or drawn. */
export type BodyKind = "shape" | "wall" | "ground" | "ghost";

export type PhaseKind = "on" | "off";

/** One step of a stream / force timer. */
export interface SchedulePhase {
  kind: PhaseKind;
  /** Duration in simulated seconds. */
  seconds: number;
}

/**
 * Timing for a stream / force. Phases run in order from the moment the setting was applied;
 * absent schedule = always on.
 */
export interface Schedule {
  phases: SchedulePhase[];
  /** Repeat the whole list; otherwise stay off after the last phase. */
  loop: boolean;
}

export const DEFAULT_SCHEDULE: Readonly<Schedule> = { phases: [], loop: false };

/** Duration given to a freshly added row. */
export const DEFAULT_PHASE_SECONDS = 1;

/** Shape of the schedule before phases were a list; still found in older saved scenes. */
interface LegacySchedule {
  offSeconds?: unknown;
  onSeconds?: unknown;
  loop?: unknown;
}

function finiteSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Deep-copy a schedule, converting the older `{ offSeconds, onSeconds, loop }` form to rows. */
export function normalizeSchedule(schedule: Schedule | LegacySchedule): Schedule {
  const loop = (schedule as LegacySchedule).loop === true;
  const phases = (schedule as Partial<Schedule>).phases;
  if (Array.isArray(phases)) {
    const rows: SchedulePhase[] = [];
    for (const phase of phases) {
      if (!phase || typeof phase !== "object") continue;
      const kind = (phase as SchedulePhase).kind === "on" ? "on" : "off";
      rows.push({ kind, seconds: finiteSeconds((phase as SchedulePhase).seconds) });
    }
    return { phases: rows, loop };
  }
  const legacy = schedule as LegacySchedule;
  return {
    phases: [
      { kind: "off", seconds: finiteSeconds(legacy.offSeconds) },
      { kind: "on", seconds: finiteSeconds(legacy.onSeconds) },
    ],
    loop,
  };
}

/** Settings that can carry a schedule. */
export interface Scheduled {
  schedule?: Schedule;
}

/**
 * A stream of tiny particles hitting the shape from one direction. Each particle is a linear
 * impulse applied at the point where a ray travelling in `angleDeg` first meets the shape.
 */
export interface ParticleStream extends Scheduled {
  /** Direction the particles travel, degrees (0 = rightwards, 90 = downwards on screen). */
  angleDeg: number;
  /** Impulse per particle, N·s. */
  intensity: number;
  /**
   * Particles per second per metre of exposed width (the silhouette facing the stream), so hits
   * per unit length do not depend on the body's size.
   */
  frequency: number;
  /**
   * When true, timing, impulse, and hit position vary while keeping the same mean rate and
   * intensity; direction is unchanged. Absent / false is the even stream.
   */
  random?: boolean;
}

export const DEFAULT_STREAM: Readonly<ParticleStream> = {
  angleDeg: 0,
  intensity: 0.1,
  frequency: 60,
};

/**
 * A steady wind-like pressure from one direction. Every outline edge facing the flow is pushed
 * along the flow by `force x length x cos(A)`, where A is the angle of incidence on that edge.
 */
export interface DirectionalForce extends Scheduled {
  /** Direction the force pushes, degrees (0 = rightwards, 90 = downwards on screen). */
  angleDeg: number;
  /** Pressure: newtons per metre of exposed edge, before the cos(A) factor. */
  force: number;
}

export const DEFAULT_WIND: Readonly<DirectionalForce> = {
  angleDeg: 0,
  force: 5,
};

export interface BodyUserData {
  kind: BodyKind;
  label: string;
  fillStyle: string;
  /** Local-space outline in meters, used to fill concave compounds without seams. */
  outline?: Point[];
  /** Local-space inner rings in meters; filled as holes against `outline`. */
  holes?: Point[][];
  /** When set, this body ignores the global elasticity slider. */
  restitutionOverride?: number;
  /** Particle streams peppering the shape with impulses while the sim runs (absent = none). */
  streams?: ParticleStream[];
  /** Steady pressures pushing the shape's facing edges while the sim runs (absent = none). */
  winds?: DirectionalForce[];
  /**
   * When true, fixtures only collide with canvas boundary walls (`kind: "wall"`), not other
   * shapes or wrap ghosts. Omitted means collide with everything (the default).
   */
  wallsOnly?: boolean;
}

/** Body data as written by older saves, which carried at most one stream and one force. */
export type LegacyBodyUserData = BodyUserData & {
  stream?: ParticleStream;
  wind?: DirectionalForce;
};

export interface ShapePreview {
  type: PrimitiveShape | "box" | "frame" | "edge";
  x: number;
  y: number;
  fillStyle: string;
  /** Nominal radius in px; unused when `type` is `"box"`, `"frame"`, or `"edge"`. */
  size: number;
  /** Top-left width/height in px when `type` is `"box"` or `"frame"`. */
  w?: number;
  h?: number;
  /** Wall thickness in px when `type` is `"frame"`. */
  thickness?: number;
  /** Segment end in px when `type` is `"edge"` (`x`/`y` are the start). */
  x2?: number;
  y2?: number;
}

export interface JointUserData {
  kind: "pin" | "revolute" | "rod" | "weld" | "wheel" | "prismatic";
  /** Body-local click points (metres), used to draw weld/wheel/prismatic bars. */
  localA?: Point;
  localB?: Point;
}

export const FIXTURE = {
  density: DENSITY,
  get friction() {
    return defaultFriction;
  },
  get restitution() {
    return defaultRestitution;
  },
};

/** Planck filter bit for user shapes (the engine default). */
export const SHAPE_CATEGORY = 0x0001;
/** Wrap-mode ghost fixtures; they never collide with each other. */
export const GHOST_CATEGORY = 0x0002;
/** Canvas boundary walls. Walls-only shapes mask to this bit alone. */
export const WALL_CATEGORY = 0x0004;

let defaultRestitution = RESTITUTION;
let defaultFriction = FRICTION;
let defaultDamping = LINEAR_DAMPING;

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampRestitution(value: number): number {
  return clampUnit(value);
}

export function getDefaultRestitution(): number {
  return defaultRestitution;
}

export function setDefaultRestitution(value: number): void {
  defaultRestitution = clampRestitution(value);
}

export function getDefaultFriction(): number {
  return defaultFriction;
}

export function setDefaultFriction(value: number): void {
  defaultFriction = clampUnit(value);
}

export function getDefaultDamping(): number {
  return defaultDamping;
}

export function setDefaultDamping(value: number): void {
  defaultDamping = clampUnit(value);
}

function dampingProps(): { linearDamping: number; angularDamping: number } {
  const d = defaultDamping;
  return { linearDamping: d, angularDamping: d };
}

export function getBodyRestitution(body: Body): number {
  const fixture = body.getFixtureList();
  return fixture ? fixture.getRestitution() : defaultRestitution;
}

/** Write restitution on every fixture. `override` true pins the body against later global changes. */
export function setBodyRestitution(body: Body, value: number, override: boolean): void {
  const r = clampRestitution(value);
  for (let f = body.getFixtureList(); f; f = f.getNext()) f.setRestitution(r);
  const data = getBodyData(body);
  if (!data) return;
  if (override) data.restitutionOverride = r;
  else delete data.restitutionOverride;
}

export function setBodyFriction(body: Body, value: number): void {
  const mu = clampUnit(value);
  for (let f = body.getFixtureList(); f; f = f.getNext()) f.setFriction(mu);
}

export function setBodyDamping(body: Body, value: number): void {
  const d = clampUnit(value);
  body.setLinearDamping(d);
  body.setAngularDamping(d);
}

export function randomColor(): string {
  return DEFAULT_FILL;
}

export function getBodyData(body: Body): BodyUserData | undefined {
  const data = body.getUserData();
  if (!data || typeof data !== "object") return undefined;
  return data as BodyUserData;
}

export function isPickable(body: Body): boolean {
  return getBodyData(body)?.kind === "shape";
}

/**
 * Apply category/mask bits from `kind` and `wallsOnly`. Call after creating fixtures or
 * toggling the flag; `setFilterData` refilters so overlapping pairs update without a shove.
 * Wrap ghosts set their own bits in `copyFixtures` and are left alone here.
 */
export function applyCollisionFilter(body: Body): void {
  const data = getBodyData(body);
  if (data?.kind === "ghost") return;
  const wall = data?.kind === "wall";
  const categoryBits = wall ? WALL_CATEGORY : SHAPE_CATEGORY;
  const maskBits = !wall && data?.wallsOnly ? WALL_CATEGORY : 0xffff;
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    f.setFilterData({
      groupIndex: f.getFilterGroupIndex(),
      categoryBits,
      maskBits,
    });
  }
}

/** Override a dynamic body's mass, scaling inertia so spin stays consistent with density. */
export function setBodyMass(body: Body, mass: number): void {
  if (body.getType() !== "dynamic") return;
  const data = { mass: 0, center: { x: 0, y: 0 }, I: 0 };
  body.getMassData(data);
  const old = data.mass;
  data.mass = Math.max(0.01, mass);
  if (old > 0) data.I *= data.mass / old;
  body.setMassData(data);
}

function primitiveLabel(type: PrimitiveShape): string {
  switch (type) {
    case "circle":
      return "Circle Body";
    case "rectangle":
      return "Rectangle Body";
    default:
      return "Polygon Body";
  }
}

export function regularPolygon(n: number, radius: number): Point[] {
  const verts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    verts.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return verts;
}

function polygonCentroid(points: Point[]): Point {
  const n = points.length;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-8) {
    let x = 0;
    let y = 0;
    for (const p of points) {
      x += p.x;
      y += p.y;
    }
    return { x: x / n, y: y / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function addConvexFixture(body: Body, verts: Point[]): boolean {
  if (verts.length < 3) return false;
  const max = Settings.maxPolygonVertices;
  if (verts.length > max) {
    let added = false;
    for (let i = 1; i < verts.length - 1; i += max - 2) {
      const slice = [verts[0], ...verts.slice(i, Math.min(i + max - 1, verts.length))];
      if (slice.length >= 3) {
        body.createFixture({ shape: new Polygon(slice), ...FIXTURE });
        added = true;
      }
    }
    return added;
  }
  body.createFixture({ shape: new Polygon(verts), ...FIXTURE });
  return true;
}

/**
 * Create a body of the given type centred at (x, y) in pixels. `size` is the nominal radius in px.
 * Mass is derived from area and density, so larger shapes are heavier.
 */
export function createBody(
  world: World,
  type: PrimitiveShape,
  x: number,
  y: number,
  size: number = DEFAULT_SIZE,
  fillStyle: string = randomColor(),
): Body {
  const body = world.createDynamicBody({
    position: vecToMeters({ x, y }),
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: primitiveLabel(type),
      fillStyle,
    } satisfies BodyUserData,
  });

  const radiusM = toMeters(size);

  switch (type) {
    case "circle":
      body.createFixture({ shape: new Circle(radiusM), ...FIXTURE });
      break;
    case "rectangle":
      body.createFixture({ shape: new Box(radiusM, radiusM), ...FIXTURE });
      break;
    case "triangle":
      body.createFixture({ shape: new Polygon(regularPolygon(3, radiusM * 1.2)), ...FIXTURE });
      break;
    case "pentagon":
      body.createFixture({ shape: new Polygon(regularPolygon(5, radiusM)), ...FIXTURE });
      break;
    case "hexagon":
      body.createFixture({ shape: new Polygon(regularPolygon(6, radiusM)), ...FIXTURE });
      break;
  }

  return body;
}

/** Smallest side length a dragged box can have (px). Matches the radial-spawn minimum. */
const MIN_BOX = 8;
/** Smallest length a dragged edge can have (px). Matches the radial-spawn minimum. */
const MIN_EDGE = 8;

function aabbFromCorners(
  a: Point,
  b: Point,
  minSide: number,
): { x: number; y: number; w: number; h: number } {
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (w < minSide) {
    x = (a.x + b.x) / 2 - minSide / 2;
    w = minSide;
  }
  if (h < minSide) {
    y = (a.y + b.y) / 2 - minSide / 2;
    h = minSide;
  }
  return { x, y, w, h };
}

/** Axis-aligned pixel bounds from two corners, each side at least `MIN_BOX`. */
export function boxBounds(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return aabbFromCorners(a, b, MIN_BOX);
}

/** Segment endpoints in px, stretched to at least `MIN_EDGE` about the midpoint. */
export function edgeEndpoints(a: Point, b: Point): { a: Point; b: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len >= MIN_EDGE) return { a, b };
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (len < 1e-6) {
    const half = MIN_EDGE / 2;
    return { a: { x: mx - half, y: my }, b: { x: mx + half, y: my } };
  }
  const half = MIN_EDGE / (2 * len);
  return {
    a: { x: mx - dx * half, y: my - dy * half },
    b: { x: mx + dx * half, y: my + dy * half },
  };
}

/** Clamp wall thickness so a frame of size `w`×`h` keeps an inner opening. */
export function clampWallThickness(thickness: number, w: number, h: number): number {
  const maxT = (Math.min(w, h) - FRAME_INNER_GAP) / 2;
  return Math.min(Math.max(thickness, MIN_WALL_THICKNESS), Math.max(MIN_WALL_THICKNESS, maxT));
}

/** Axis-aligned frame bounds from two corners; outer size fits `thickness` plus a hole. */
export function frameBounds(
  a: Point,
  b: Point,
  thickness: number,
): { x: number; y: number; w: number; h: number; thickness: number } {
  const requested = Math.max(MIN_WALL_THICKNESS, thickness);
  const minSide = 2 * requested + FRAME_INNER_GAP;
  const bounds = aabbFromCorners(a, b, minSide);
  return { ...bounds, thickness: clampWallThickness(requested, bounds.w, bounds.h) };
}

/**
 * Axis-aligned rectangle whose opposite corners are `a` and `b` (pixels).
 * Each side is clamped to at least 8 px. The body is centred on the rectangle.
 */
export function createBox(
  world: World,
  a: Point,
  b: Point,
  fillStyle: string = randomColor(),
): Body {
  const { x, y, w, h } = boxBounds(a, b);
  const body = world.createDynamicBody({
    position: vecToMeters({ x: x + w / 2, y: y + h / 2 }),
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: "Rectangle Body",
      fillStyle,
    } satisfies BodyUserData,
  });
  body.createFixture({
    shape: new Box(toMeters(w / 2), toMeters(h / 2)),
    ...FIXTURE,
  });
  return body;
}

/**
 * Hollow rectangle of four overlapping wall strips. Opposite corners are `a` and `b` (pixels).
 * Outer size is at least `2 * thickness + 4` px so the interior stays open.
 */
export function createFrame(
  world: World,
  a: Point,
  b: Point,
  thickness: number = DEFAULT_WALL_THICKNESS,
  fillStyle: string = randomColor(),
): Body {
  const { x, y, w, h, thickness: t } = frameBounds(a, b, thickness);
  const hw = w / 2;
  const hh = h / 2;
  const halfT = t / 2;
  const body = world.createDynamicBody({
    position: vecToMeters({ x: x + w / 2, y: y + h / 2 }),
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: "Frame Body",
      fillStyle,
      outline: [
        { x: toMeters(-hw), y: toMeters(-hh) },
        { x: toMeters(hw), y: toMeters(-hh) },
        { x: toMeters(hw), y: toMeters(hh) },
        { x: toMeters(-hw), y: toMeters(hh) },
      ],
      holes: [
        [
          { x: toMeters(-hw + t), y: toMeters(-hh + t) },
          { x: toMeters(hw - t), y: toMeters(-hh + t) },
          { x: toMeters(hw - t), y: toMeters(hh - t) },
          { x: toMeters(-hw + t), y: toMeters(hh - t) },
        ],
      ],
    } satisfies BodyUserData,
  });

  function wall(hx: number, hy: number, cx: number, cy: number): void {
    body.createFixture({
      shape: new Box(toMeters(hx), toMeters(hy), vecToMeters({ x: cx, y: cy })),
      ...FIXTURE,
    });
  }
  wall(hw, halfT, 0, -hh + halfT);
  wall(hw, halfT, 0, hh - halfT);
  wall(halfT, hh, -hw + halfT, 0);
  wall(halfT, hh, hw - halfT, 0);
  return body;
}

/**
 * Static line segment whose ends are `a` and `b` (pixels). Length is clamped to at least 8 px.
 * The body is centred on the segment midpoint.
 */
export function createEdge(
  world: World,
  a: Point,
  b: Point,
  fillStyle: string = randomColor(),
): Body {
  const ends = edgeEndpoints(a, b);
  const mx = (ends.a.x + ends.b.x) / 2;
  const my = (ends.a.y + ends.b.y) / 2;
  const body = world.createBody({
    type: "static",
    position: vecToMeters({ x: mx, y: my }),
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: "Edge Body",
      fillStyle,
    } satisfies BodyUserData,
  });
  body.createFixture({
    shape: new Edge(
      vecToMeters({ x: ends.a.x - mx, y: ends.a.y - my }),
      vecToMeters({ x: ends.b.x - mx, y: ends.b.y - my }),
    ),
    ...FIXTURE,
    density: 0,
  });
  return body;
}

function chainVertices(points: Point[]): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= MIN_EDGE) out.push(p);
  }
  return out;
}

function averagePoint(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = points.length;
  return { x: x / n, y: y / n };
}

/**
 * Static polyline of connected edge segments. Consecutive vertices closer than 8 px are
 * dropped. Returns null if fewer than two vertices remain (three when `loop` is true). The body
 * is centred on the vertex average. When `loop` is true the last vertex joins the first.
 */
export function createChain(world: World, points: Point[], loop = false): Body | null {
  const verts = chainVertices(points);
  if (verts.length < (loop ? 3 : 2)) return null;

  const metres = verts.map(vecToMeters);
  const centre = averagePoint(metres);
  const local = metres.map((p) => ({ x: p.x - centre.x, y: p.y - centre.y }));

  const body = world.createBody({
    type: "static",
    position: centre,
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: "Chain Body",
      fillStyle: randomColor(),
    } satisfies BodyUserData,
  });
  body.createFixture({
    shape: new Chain(local, loop),
    ...FIXTURE,
    density: 0,
  });
  return body;
}

/**
 * Create a rigid body from user-drawn vertices (pixels). Returns null if a body cannot be formed
 * (degenerate or empty decomposition). The body is placed on the drawn centroid.
 */
export function createPolygon(world: World, points: Point[]): Body | null {
  if (points.length < 3) return null;

  const metres = points.map(vecToMeters);
  const centre = polygonCentroid(metres);
  const local = metres.map((p) => ({ x: p.x - centre.x, y: p.y - centre.y }));
  const decompVerts = local.map((p) => [p.x, p.y]);

  try {
    decomp.makeCCW(decompVerts);
    decomp.removeDuplicatePoints(decompVerts, 0.0001);
    decomp.removeCollinearPoints(decompVerts, 0.01);
  } catch {
    return null;
  }

  if (decompVerts.length < 3) return null;

  let pieces: number[][][];
  try {
    pieces = decomp.quickDecomp(decompVerts);
  } catch {
    return null;
  }

  if (!pieces.length) return null;

  const body = world.createDynamicBody({
    position: centre,
    ...dampingProps(),
    userData: {
      kind: "shape",
      label: "Polygon Body",
      fillStyle: randomColor(),
      outline: local,
    } satisfies BodyUserData,
  });

  let added = 0;
  for (const piece of pieces) {
    if (piece.length < 3) continue;
    const verts = piece.map(([px, py]) => ({ x: px, y: py }));
    if (addConvexFixture(body, verts)) added += 1;
  }

  if (added === 0) {
    world.destroyBody(body);
    return null;
  }

  return body;
}

/** Trace a primitive (pixel space) for ghost previews. */
export function tracePreview(ctx: CanvasRenderingContext2D, preview: ShapePreview): void {
  const { type, x, y } = preview;
  ctx.beginPath();
  if (type === "box") {
    ctx.rect(x, y, preview.w ?? 0, preview.h ?? 0);
    return;
  }
  if (type === "frame") {
    const w = preview.w ?? 0;
    const h = preview.h ?? 0;
    const t = clampWallThickness(preview.thickness ?? DEFAULT_WALL_THICKNESS, w, h);
    ctx.rect(x, y, w, h);
    const innerW = w - 2 * t;
    const innerH = h - 2 * t;
    if (innerW > 0 && innerH > 0) ctx.rect(x + t, y + t, innerW, innerH);
    return;
  }
  if (type === "edge") {
    ctx.moveTo(x, y);
    ctx.lineTo(preview.x2 ?? x, preview.y2 ?? y);
    return;
  }
  const size = preview.size;
  if (type === "circle") {
    ctx.arc(x, y, size, 0, Math.PI * 2);
    return;
  }
  if (type === "rectangle") {
    ctx.rect(x - size, y - size, size * 2, size * 2);
    return;
  }
  const radius = type === "triangle" ? size * 1.2 : size;
  const sides = type === "triangle" ? 3 : type === "pentagon" ? 5 : 6;
  const verts = regularPolygon(sides, radius);
  ctx.moveTo(x + verts[0].x, y + verts[0].y);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(x + verts[i].x, y + verts[i].y);
  ctx.closePath();
}

type FixtureLike = NonNullable<ReturnType<Body["getFixtureList"]>>;

/** Plain-data description of a fixture's shape (body-local metres). JSON-safe. */
export type ShapeJson =
  | { type: "circle"; center: Point; radius: number }
  | { type: "polygon"; vertices: Point[] }
  | { type: "edge"; v1: Point; v2: Point }
  | { type: "chain"; vertices: Point[]; loop: boolean };

/** Plain-data description of a fixture; used for cloning, scaling and scene save/load. */
export interface FixtureJson {
  shape: ShapeJson;
  density: number;
  friction: number;
  restitution: number;
}

type LocalMap = (v: { x: number; y: number }) => Point;

/**
 * Map a body-local point by world-axis scale `sx, sy`: `R^T * diag(sx, sy) * R`. Uniform scale
 * (`sx === sy`) is just a multiply, so it commutes with the body's rotation.
 */
export function scaleLocalAboutWorldAxes(
  angle: number,
  p: { x: number; y: number },
  sx: number,
  sy: number,
): Point {
  if (Math.abs(sx - sy) < 1e-4) return { x: p.x * sx, y: p.y * sx };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const wx = c * p.x - s * p.y;
  const wy = s * p.x + c * p.y;
  const tx = wx * sx;
  const ty = wy * sy;
  return { x: c * tx + s * ty, y: -s * tx + c * ty };
}

function reverseRing(points: Point[]): Point[] {
  const copy = points.slice();
  copy.reverse();
  return copy;
}

/** Reflection (`det < 0`) reverses winding; Planck polygons must stay CCW. */
function withWinding(json: ShapeJson, reverse: boolean): ShapeJson {
  if (!reverse) return json;
  if (json.type === "polygon") return { type: "polygon", vertices: reverseRing(json.vertices) };
  if (json.type === "chain") {
    return { type: "chain", vertices: reverseRing(json.vertices), loop: json.loop };
  }
  if (json.type === "edge") return { type: "edge", v1: json.v2, v2: json.v1 };
  return json;
}

/**
 * Read a body's fixtures as plain data. `map` transforms each local point; when
 * `circleRadiusScale` is null, circles become polygons (Planck has no ellipse).
 */
function mapFixtureSpecs(
  body: Body,
  map: LocalMap,
  circleRadiusScale: number | null,
  reverseWinding = false,
): FixtureJson[] {
  const specs: FixtureJson[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    let json: ShapeJson | null = null;
    if (type === "circle") {
      const circle = shape as import("planck").CircleShape;
      const center = circle.getCenter();
      if (circleRadiusScale !== null) {
        json = {
          type: "circle",
          center: map(center),
          radius: circle.getRadius() * circleRadiusScale,
        };
      } else {
        json = {
          type: "polygon",
          vertices: regularPolygon(Settings.maxPolygonVertices, circle.getRadius()).map((p) =>
            map({ x: p.x + center.x, y: p.y + center.y }),
          ),
        };
      }
    } else if (type === "polygon") {
      const poly = shape as import("planck").PolygonShape;
      json = { type: "polygon", vertices: poly.m_vertices.slice(0, poly.m_count).map(map) };
    } else if (type === "edge") {
      const edge = shape as import("planck").EdgeShape;
      json = { type: "edge", v1: map(edge.m_vertex1), v2: map(edge.m_vertex2) };
    } else if (type === "chain") {
      const chain = shape as import("planck").ChainShape;
      const raw = chain.m_isLoop
        ? chain.m_vertices.slice(0, chain.m_count - 1)
        : chain.m_vertices.slice(0, chain.m_count);
      json = { type: "chain", vertices: raw.map(map), loop: chain.m_isLoop };
    }
    if (!json) continue;
    json = withWinding(json, reverseWinding);
    specs.push({
      shape: json,
      density: f.getDensity(),
      friction: f.getFriction(),
      restitution: f.getRestitution(),
    });
  }
  // Planck prepends new fixtures, so the list is newest-first; return creation order instead so
  // re-applying the specs reproduces the same list.
  return specs.reverse();
}

/** Read a body's fixtures as plain data, scaling geometry about the body origin by `factor`. */
export function fixtureSpecs(body: Body, factor = 1): FixtureJson[] {
  return mapFixtureSpecs(body, (v) => ({ x: v.x * factor, y: v.y * factor }), factor);
}

function shapeFromJson(json: ShapeJson): Circle | Polygon | Edge | Chain {
  switch (json.type) {
    case "circle":
      return new Circle(json.center, json.radius);
    case "polygon":
      return new Polygon(json.vertices);
    case "edge":
      return new Edge(json.v1, json.v2);
    case "chain":
      return new Chain(json.vertices, json.loop);
  }
}

/** Create fixtures on `body` from plain data produced by `fixtureSpecs`. */
export function applyFixtureSpecs(body: Body, specs: FixtureJson[]): void {
  for (const spec of specs) {
    body.createFixture({
      shape: shapeFromJson(spec.shape),
      density: spec.density,
      friction: spec.friction,
      restitution: spec.restitution,
    });
  }
  applyCollisionFilter(body);
}

/**
 * Scale about the body origin. Isotropic (`|sx| === |sy|`) keeps circles as circles; otherwise
 * a world-axis stretch (`R^T * diag(sx, sy) * R`) turns them into polygons. A negative determinant
 * (reflection) reverses winding so Planck polygons stay CCW. Recreates fixtures; Planck has no
 * Body.scale.
 */
export function scaleBody(body: Body, sx: number, sy = sx): void {
  if (Math.abs(sx - 1) < 1e-4 && Math.abs(sy - 1) < 1e-4) return;

  const fixtures: FixtureLike[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) fixtures.push(f);

  const angle = body.getAngle();
  const isotropic = Math.abs(Math.abs(sx) - Math.abs(sy)) < 1e-4;
  const reverseWinding = sx * sy < 0;
  const map = (v: { x: number; y: number }): Point => scaleLocalAboutWorldAxes(angle, v, sx, sy);
  const rebuilt = mapFixtureSpecs(
    body,
    map,
    isotropic ? Math.abs(sx) : null,
    reverseWinding,
  );

  for (const f of fixtures) body.destroyFixture(f);
  applyFixtureSpecs(body, rebuilt);

  const data = getBodyData(body);
  if (data?.outline) {
    data.outline = data.outline.map(map);
    if (reverseWinding) data.outline.reverse();
  }
  if (data?.holes) {
    data.holes = data.holes.map((ring) => {
      const mapped = ring.map(map);
      if (reverseWinding) mapped.reverse();
      return mapped;
    });
  }
  body.synchronizeFixtures();
  body.setAwake(true);
}

/**
 * Copy a stream / force setting together with its nested schedule. The schedule is deep-copied
 * and normalised, so a scene saved in the older off / on form loads as two rows.
 */
export function cloneScheduled<T extends Scheduled>(settings: T): T {
  const copy = { ...settings };
  if (settings.schedule) copy.schedule = normalizeSchedule(settings.schedule);
  else delete copy.schedule;
  return copy;
}

/** Deep-copy a list of scheduled settings, appending an older single-value form if present. */
function cloneScheduledList<T extends Scheduled>(list: T[] | undefined, legacy: T | undefined): T[] | undefined {
  const out: T[] = [];
  if (Array.isArray(list)) for (const item of list) if (item) out.push(cloneScheduled(item));
  if (legacy) out.push(cloneScheduled(legacy));
  return out.length > 0 ? out : undefined;
}

/**
 * Deep-copy body user data so clones / saves do not share outline arrays. Older saves with a
 * single `stream` / `wind` are folded into the `streams` / `winds` lists.
 */
export function cloneBodyData(data: LegacyBodyUserData | undefined): BodyUserData {
  if (!data) return { kind: "shape", label: "Body", fillStyle: DEFAULT_FILL };
  const copy: BodyUserData = { kind: data.kind, label: data.label, fillStyle: data.fillStyle };
  if (data.outline) copy.outline = data.outline.map((p) => ({ x: p.x, y: p.y }));
  if (data.holes) copy.holes = data.holes.map((ring) => ring.map((p) => ({ x: p.x, y: p.y })));
  if (data.restitutionOverride !== undefined) copy.restitutionOverride = data.restitutionOverride;
  if (data.wallsOnly) copy.wallsOnly = true;
  const streams = cloneScheduledList(data.streams, data.stream);
  if (streams) copy.streams = streams;
  const winds = cloneScheduledList(data.winds, data.wind);
  if (winds) copy.winds = winds;
  return copy;
}

/** Deep-copy a pickable body, offset in world space (metres). */
export function cloneBody(world: World, source: Body, offsetM: Point): Body {
  const userData = cloneBodyData(getBodyData(source));

  const pos = source.getPosition();
  const body = world.createBody({
    type: source.getType(),
    position: { x: pos.x + offsetM.x, y: pos.y + offsetM.y },
    angle: source.getAngle(),
    linearDamping: source.getLinearDamping(),
    angularDamping: source.getAngularDamping(),
    userData,
  });

  applyFixtureSpecs(body, fixtureSpecs(source, 1));

  if (source.getType() === "dynamic") {
    const massData = { mass: 0, center: { x: 0, y: 0 }, I: 0 };
    source.getMassData(massData);
    body.setMassData(massData);
  }

  body.setLinearVelocity(source.getLinearVelocity());
  body.setAngularVelocity(source.getAngularVelocity());
  body.synchronizeFixtures();
  body.setAwake(true);
  return body;
}
