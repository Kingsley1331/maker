import earcut from "earcut";
import { Polygon, type Body, type CircleShape, type PolygonShape, type World } from "planck";
import {
  boxBounds,
  FIXTURE,
  getBodyData,
  isPickable,
  regularPolygon,
  type Point,
  type PrimitiveShape,
} from "./shapes";
import { vecToMeters } from "./units";

/** Vertices used when a circle is turned into a cut contour. */
export const CIRCLE_CUT_SIDES = 24;

export interface Contour {
  outline: Point[];
  holes: Point[][];
}

/** World-pixel ring for a primitive cutter centred at `(x, y)`. */
export function primitiveCutter(type: PrimitiveShape, x: number, y: number, size: number): Point[] {
  if (type === "rectangle") {
    return [
      { x: x - size, y: y - size },
      { x: x + size, y: y - size },
      { x: x + size, y: y + size },
      { x: x - size, y: y + size },
    ];
  }
  const radius = type === "triangle" ? size * 1.2 : size;
  const sides = type === "circle" ? CIRCLE_CUT_SIDES : type === "triangle" ? 3 : type === "pentagon" ? 5 : 6;
  return regularPolygon(sides, radius).map((p) => ({ x: x + p.x, y: y + p.y }));
}

/** World-pixel ring for a box-tool cutter. */
export function boxCutter(a: Point, b: Point): Point[] {
  const { x, y, w, h } = boxBounds(a, b);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function cutterLocalOn(body: Body, cutterWorldM: Point[]): Point[] | null {
  const contour = bodyContour(body);
  if (!contour) return null;
  const local = cutterWorldM.map((p) => {
    const lp = body.getLocalPoint(p);
    return { x: lp.x, y: lp.y };
  });
  if (!cutterFitsInSolid(contour, local)) return null;
  return local;
}

/**
 * Subtract `cutterWorldPx` from a body that fully contains it. When `prefer` is set, only that
 * body is considered; otherwise the smallest pickable container wins.
 * Returns false if no valid target or triangulation fails (body left unchanged).
 */
export function trySubtractHole(world: World, cutterWorldPx: Point[], prefer?: Body | null): boolean {
  if (cutterWorldPx.length < 3) return false;
  const cutterWorldM = cutterWorldPx.map(vecToMeters);

  if (prefer) {
    if (!isPickable(prefer)) return false;
    const local = cutterLocalOn(prefer, cutterWorldM);
    return local ? subtractHole(prefer, local) : false;
  }

  let best: { body: Body; local: Point[]; area: number } | null = null;
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (!isPickable(body)) continue;
    const contour = bodyContour(body);
    if (!contour) continue;
    const local = cutterLocalOn(body, cutterWorldM);
    if (!local) continue;
    const area = Math.abs(signedArea(contour.outline));
    if (!best || area < best.area) best = { body, local, area };
  }
  if (!best) return false;
  return subtractHole(best.body, best.local);
}

export function bodyContour(body: Body): Contour | null {
  const data = getBodyData(body);
  if (!data || data.kind !== "shape") return null;

  if (data.outline && data.outline.length >= 3) {
    const holes = (data.holes ?? []).filter((ring) => ring.length >= 3);
    return { outline: data.outline, holes };
  }

  let circle: CircleShape | null = null;
  let poly: PolygonShape | null = null;
  let polyCount = 0;
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const type = f.getShape().getType();
    if (type === "edge" || type === "chain") return null;
    if (type === "circle") {
      if (circle || poly) return null;
      circle = f.getShape() as CircleShape;
    } else if (type === "polygon") {
      if (circle) return null;
      polyCount += 1;
      if (polyCount > 1) return null;
      poly = f.getShape() as PolygonShape;
    }
  }

  if (circle) {
    const c = circle.getCenter();
    const ring = regularPolygon(CIRCLE_CUT_SIDES, circle.getRadius()).map((p) => ({
      x: p.x + c.x,
      y: p.y + c.y,
    }));
    return { outline: ring, holes: [] };
  }
  if (poly && poly.m_count >= 3) {
    const ring = poly.m_vertices.slice(0, poly.m_count).map((v) => ({ x: v.x, y: v.y }));
    return { outline: ring, holes: [] };
  }
  return null;
}

export function cutterFitsInSolid(contour: Contour, cutter: Point[]): boolean {
  if (cutter.length < 3) return false;
  const { outline, holes } = contour;
  for (const p of cutter) {
    if (!pointInSolid(p, outline, holes)) return false;
  }
  const centre = ringCentroid(cutter);
  if (!pointInSolid(centre, outline, holes)) return false;
  if (ringsIntersect(cutter, outline)) return false;
  for (const hole of holes) {
    if (ringsIntersect(cutter, hole)) return false;
    for (const p of hole) {
      if (pointInRing(p, cutter)) return false;
    }
  }
  return true;
}

function subtractHole(body: Body, cutterLocal: Point[]): boolean {
  const contour = bodyContour(body);
  if (!contour) return false;
  const holes = [...contour.holes.map(copyRing), copyRing(cutterLocal)];
  return applyContour(body, copyRing(contour.outline), holes);
}

function applyContour(body: Body, outline: Point[], holes: Point[][]): boolean {
  const outer = ensureWinding(outline, true);
  const inner = holes.map((ring) => ensureWinding(ring, false));

  const verts: number[] = [];
  const holeIndices: number[] = [];
  for (const p of outer) verts.push(p.x, p.y);
  for (const hole of inner) {
    holeIndices.push(verts.length / 2);
    for (const p of hole) verts.push(p.x, p.y);
  }

  let triangles: number[];
  try {
    triangles = earcut(verts, holeIndices.length ? holeIndices : undefined, 2);
  } catch {
    return false;
  }
  if (triangles.length < 3) return false;

  const proto = body.getFixtureList();
  const density = proto ? proto.getDensity() : FIXTURE.density;
  const friction = proto ? proto.getFriction() : FIXTURE.friction;
  const restitution = proto ? proto.getRestitution() : FIXTURE.restitution;

  const pieces: Point[][] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    const tri = [
      { x: verts[a * 2], y: verts[a * 2 + 1] },
      { x: verts[b * 2], y: verts[b * 2 + 1] },
      { x: verts[c * 2], y: verts[c * 2 + 1] },
    ];
    if (Math.abs(signedArea(tri)) < 1e-12) continue;
    pieces.push(ensureWinding(tri, true));
  }
  if (pieces.length === 0) return false;

  const stale: NonNullable<ReturnType<Body["getFixtureList"]>>[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) stale.push(f);
  for (const f of stale) body.destroyFixture(f);

  for (const tri of pieces) {
    body.createFixture({
      shape: new Polygon(tri),
      density,
      friction,
      restitution,
    });
  }

  const data = getBodyData(body);
  if (data) {
    data.outline = outer;
    data.holes = inner;
  }
  body.synchronizeFixtures();
  body.setAwake(true);
  return true;
}

function copyRing(ring: Point[]): Point[] {
  return ring.map((p) => ({ x: p.x, y: p.y }));
}

function signedArea(ring: Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function ensureWinding(ring: Point[], ccw: boolean): Point[] {
  const copy = copyRing(ring);
  const isCcw = signedArea(copy) > 0;
  if (isCcw !== ccw) copy.reverse();
  return copy;
}

function ringCentroid(ring: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = ring.length;
  return { x: x / n, y: y / n };
}

function pointInSolid(p: Point, outline: Point[], holes: Point[][]): boolean {
  if (!pointInRing(p, outline)) return false;
  for (const hole of holes) {
    if (pointInRing(p, hole)) return false;
  }
  return true;
}

function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const intersect = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringsIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-12 && onSegment(a, c, b)) return true;
  if (Math.abs(o2) < 1e-12 && onSegment(a, d, b)) return true;
  if (Math.abs(o3) < 1e-12 && onSegment(c, a, d)) return true;
  if (Math.abs(o4) < 1e-12 && onSegment(c, b, d)) return true;
  return false;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, p: Point, b: Point): boolean {
  return (
    p.x <= Math.max(a.x, b.x) + 1e-12 &&
    p.x >= Math.min(a.x, b.x) - 1e-12 &&
    p.y <= Math.max(a.y, b.y) + 1e-12 &&
    p.y >= Math.min(a.y, b.y) - 1e-12
  );
}
