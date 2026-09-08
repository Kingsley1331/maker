import { Box, Circle, Polygon, Settings, type Body, type World } from "planck";
import decomp from "poly-decomp";
import {
  ANGULAR_DAMPING,
  DENSITY,
  FRICTION,
  LINEAR_DAMPING,
  RESTITUTION,
  type Point,
  toMeters,
  vecToMeters,
} from "./units";

Settings.maxPolygonVertices = 16;

export type PrimitiveShape = "circle" | "rectangle" | "triangle" | "pentagon" | "hexagon";
export type ShapeType = PrimitiveShape | "polygon" | "box";

export const PRIMITIVE_SHAPES: PrimitiveShape[] = [
  "circle",
  "rectangle",
  "triangle",
  "pentagon",
  "hexagon",
];

export const SHAPE_TYPES: ShapeType[] = [...PRIMITIVE_SHAPES, "box", "polygon"];

/** Pale blue-leaning duck egg; used for newly spawned shapes. */
export const DEFAULT_FILL = "#b8d8e4";

export const DEFAULT_SIZE = 28;

export type { Point };

export type BodyKind = "shape" | "wall" | "ground";

export interface BodyUserData {
  kind: BodyKind;
  label: string;
  fillStyle: string;
  /** Local-space outline in meters, used to fill concave compounds without seams. */
  outline?: Point[];
}

export interface ShapePreview {
  type: PrimitiveShape | "box";
  x: number;
  y: number;
  fillStyle: string;
  /** Nominal radius in px; unused when `type` is `"box"`. */
  size: number;
  /** Top-left width/height in px when `type` is `"box"`. */
  w?: number;
  h?: number;
}

export interface JointUserData {
  kind: "pin" | "revolute" | "rod" | "weld" | "wheel";
  /** Body-local click points (metres), used to draw weld/wheel bars. */
  localA?: Point;
  localB?: Point;
}

export const FIXTURE = {
  density: DENSITY,
  friction: FRICTION,
  restitution: RESTITUTION,
};

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
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
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

/** Axis-aligned pixel bounds from two corners, each side at least `MIN_BOX`. */
export function boxBounds(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (w < MIN_BOX) {
    x = (a.x + b.x) / 2 - MIN_BOX / 2;
    w = MIN_BOX;
  }
  if (h < MIN_BOX) {
    y = (a.y + b.y) / 2 - MIN_BOX / 2;
    h = MIN_BOX;
  }
  return { x, y, w, h };
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
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
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
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
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

/** Uniform scale about the body origin. Recreates fixtures; Planck has no Body.scale. */
export function scaleBody(body: Body, factor: number): void {
  if (Math.abs(factor - 1) < 1e-4) return;

  const fixtures: FixtureLike[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) fixtures.push(f);

  const rebuilt: { shape: Circle | Polygon; density: number; friction: number; restitution: number }[] = [];
  for (const f of fixtures) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === "circle") {
      const circle = shape as import("planck").CircleShape;
      const center = circle.getCenter();
      rebuilt.push({
        shape: new Circle({ x: center.x * factor, y: center.y * factor }, circle.getRadius() * factor),
        density: f.getDensity(),
        friction: f.getFriction(),
        restitution: f.getRestitution(),
      });
    } else if (type === "polygon") {
      const poly = shape as import("planck").PolygonShape;
      const verts = poly.m_vertices.slice(0, poly.m_count).map((v) => ({ x: v.x * factor, y: v.y * factor }));
      rebuilt.push({
        shape: new Polygon(verts),
        density: f.getDensity(),
        friction: f.getFriction(),
        restitution: f.getRestitution(),
      });
    }
  }

  for (const f of fixtures) body.destroyFixture(f);
  for (const spec of rebuilt) {
    body.createFixture({
      shape: spec.shape,
      density: spec.density,
      friction: spec.friction,
      restitution: spec.restitution,
    });
  }

  const data = getBodyData(body);
  if (data?.outline) {
    data.outline = data.outline.map((p) => ({ x: p.x * factor, y: p.y * factor }));
  }
  body.synchronizeFixtures();
  body.setAwake(true);
}

type FixtureLike = NonNullable<ReturnType<Body["getFixtureList"]>>;
