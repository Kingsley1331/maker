import { Box, Circle, Polygon, Settings, type Body, type World } from "planck";
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
export type ShapeType = PrimitiveShape | "polygon" | "box" | "frame";

export const PRIMITIVE_SHAPES: PrimitiveShape[] = [
  "circle",
  "rectangle",
  "triangle",
  "pentagon",
  "hexagon",
];

export const SHAPE_TYPES: ShapeType[] = [...PRIMITIVE_SHAPES, "box", "frame", "polygon"];

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

export type BodyKind = "shape" | "wall" | "ground";

export interface BodyUserData {
  kind: BodyKind;
  label: string;
  fillStyle: string;
  /** Local-space outline in meters, used to fill concave compounds without seams. */
  outline?: Point[];
  /** Local-space inner ring in meters; filled as a hole against `outline`. */
  hole?: Point[];
  /** When set, this body ignores the global elasticity slider. */
  restitutionOverride?: number;
}

export interface ShapePreview {
  type: PrimitiveShape | "box" | "frame";
  x: number;
  y: number;
  fillStyle: string;
  /** Nominal radius in px; unused when `type` is `"box"` or `"frame"`. */
  size: number;
  /** Top-left width/height in px when `type` is `"box"` or `"frame"`. */
  w?: number;
  h?: number;
  /** Wall thickness in px when `type` is `"frame"`. */
  thickness?: number;
}

export interface JointUserData {
  kind: "pin" | "revolute" | "rod" | "weld" | "wheel";
  /** Body-local click points (metres), used to draw weld/wheel bars. */
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
      hole: [
        { x: toMeters(-hw + t), y: toMeters(-hh + t) },
        { x: toMeters(hw - t), y: toMeters(-hh + t) },
        { x: toMeters(hw - t), y: toMeters(hh - t) },
        { x: toMeters(-hw + t), y: toMeters(hh - t) },
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

type FixtureSpec = {
  shape: Circle | Polygon;
  density: number;
  friction: number;
  restitution: number;
};

function fixtureSpecs(body: Body, factor: number): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === "circle") {
      const circle = shape as import("planck").CircleShape;
      const center = circle.getCenter();
      specs.push({
        shape: new Circle({ x: center.x * factor, y: center.y * factor }, circle.getRadius() * factor),
        density: f.getDensity(),
        friction: f.getFriction(),
        restitution: f.getRestitution(),
      });
    } else if (type === "polygon") {
      const poly = shape as import("planck").PolygonShape;
      const verts = poly.m_vertices.slice(0, poly.m_count).map((v) => ({ x: v.x * factor, y: v.y * factor }));
      specs.push({
        shape: new Polygon(verts),
        density: f.getDensity(),
        friction: f.getFriction(),
        restitution: f.getRestitution(),
      });
    }
  }
  return specs;
}

function applyFixtureSpecs(body: Body, specs: FixtureSpec[]): void {
  for (const spec of specs) {
    body.createFixture({
      shape: spec.shape,
      density: spec.density,
      friction: spec.friction,
      restitution: spec.restitution,
    });
  }
}

/** Uniform scale about the body origin. Recreates fixtures; Planck has no Body.scale. */
export function scaleBody(body: Body, factor: number): void {
  if (Math.abs(factor - 1) < 1e-4) return;

  const fixtures: FixtureLike[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) fixtures.push(f);

  const rebuilt = fixtureSpecs(body, factor);

  for (const f of fixtures) body.destroyFixture(f);
  applyFixtureSpecs(body, rebuilt);

  const data = getBodyData(body);
  if (data?.outline) {
    data.outline = data.outline.map((p) => ({ x: p.x * factor, y: p.y * factor }));
  }
  if (data?.hole) {
    data.hole = data.hole.map((p) => ({ x: p.x * factor, y: p.y * factor }));
  }
  body.synchronizeFixtures();
  body.setAwake(true);
}

/** Deep-copy a pickable body, offset in world space (metres). */
export function cloneBody(world: World, source: Body, offsetM: Point): Body {
  const srcData = getBodyData(source);
  const userData: BodyUserData = srcData
    ? {
        kind: srcData.kind,
        label: srcData.label,
        fillStyle: srcData.fillStyle,
        outline: srcData.outline?.map((p) => ({ x: p.x, y: p.y })),
        hole: srcData.hole?.map((p) => ({ x: p.x, y: p.y })),
        restitutionOverride: srcData.restitutionOverride,
      }
    : { kind: "shape", label: "Body", fillStyle: DEFAULT_FILL };

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
