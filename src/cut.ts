import earcut from "earcut";
import decomp from "poly-decomp";
import { Polygon, type Body, type CircleShape, type PolygonShape, type World } from "planck";
import { groupJoints } from "./group";
import { buildJoint, isSceneJoint, jointBlueprint } from "./scene-edit";
import {
  applyCollisionFilter,
  boxBounds,
  circularSectorContour,
  cloneBodyData,
  DEFAULT_INNER_RADIUS,
  DEFAULT_SECTOR_DEG,
  FIXTURE,
  getBodyData,
  isPickable,
  regularPolygon,
  type Point,
  type PrimitiveShape,
  type SectorParams,
} from "./shapes";
import { toMeters, vecToMeters } from "./units";

/** Vertices used when a circle is turned into a cut contour. */
export const CIRCLE_CUT_SIDES = 24;

const AREA_EPS = 1e-12;
const LINE_EPS = 1e-10;
const POINT_EPS = 1e-7;

export interface Contour {
  outline: Point[];
  holes: Point[][];
}

/** World-pixel ring for a primitive cutter centred at `(x, y)`. */
export function primitiveCutter(
  type: PrimitiveShape,
  x: number,
  y: number,
  size: number,
  sector?: SectorParams,
): Point[] {
  if (type === "rectangle") {
    return [
      { x: x - size, y: y - size },
      { x: x + size, y: y - size },
      { x: x + size, y: y + size },
      { x: x - size, y: y + size },
    ];
  }
  if (type === "sector") {
    const { outline } = circularSectorContour(
      size,
      sector?.sectorDeg ?? DEFAULT_SECTOR_DEG,
      sector?.innerRatio ?? DEFAULT_INNER_RADIUS,
    );
    return outline.map((p) => ({ x: x + p.x, y: y + p.y }));
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

function cutterLocal(body: Body, cutterWorldM: Point[]): Point[] | null {
  if (!bodyContour(body)) return null;
  return cutterWorldM.map((p) => {
    const lp = body.getLocalPoint(p);
    return { x: lp.x, y: lp.y };
  });
}

/** A hole punched by a fully-inside cutter, ready to select for move / rotate / scale. */
export interface PunchedHole {
  body: Body;
  holeIndex: number;
}

/**
 * Subtract `cutterWorldPx` from every overlapping pickable body. A cutter fully inside punches a
 * hole; a cutter that crosses the outline bites or splits the solid into separate bodies.
 * Targets are snapshotted first so splits and deletes cannot skip or recut neighbors.
 * Returns the holes that were punched (not edge bites or splits).
 */
export function trySubtractHole(world: World, cutterWorldPx: Point[]): PunchedHole[] {
  if (cutterWorldPx.length < 3) return [];
  const cutterWorldM = cutterWorldPx.map(vecToMeters);

  const targets: { body: Body; local: Point[] }[] = [];
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (!isPickable(body)) continue;
    const contour = bodyContour(body);
    if (!contour) continue;
    const local = cutterLocal(body, cutterWorldM);
    if (!local || !cutterOverlapsSolid(contour, local)) continue;
    targets.push({ body, local });
  }

  const punched: PunchedHole[] = [];
  for (const { body, local } of targets) {
    const holeIndex = cutBody(world, body, local);
    if (holeIndex !== null) punched.push({ body, holeIndex });
  }
  return punched;
}

/** Hairline gap (px) so split pieces do not spawn with coincident faces. */
const SLICE_SEPARATION_PX = 0.75;

/**
 * Split every filled pickable body the segment `aWorldPx`–`bWorldPx` actually crosses. The cut
 * is the infinite line through those points; pieces become separate bodies. Returns the new
 * bodies (originals are destroyed). Edges and chains are skipped.
 */
export function trySplitByLine(world: World, aWorldPx: Point, bWorldPx: Point): Body[] {
  if (Math.hypot(bWorldPx.x - aWorldPx.x, bWorldPx.y - aWorldPx.y) < 1) return [];
  const aWorldM = vecToMeters(aWorldPx);
  const bWorldM = vecToMeters(bWorldPx);

  const targets: Body[] = [];
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (!isPickable(body)) continue;
    const contour = bodyContour(body);
    if (!contour) continue;
    const a = pointLocal(body, aWorldM);
    const b = pointLocal(body, bWorldM);
    if (!segmentHitsSolid(contour, a, b)) continue;
    targets.push(body);
  }

  const created: Body[] = [];
  for (const body of targets) {
    const a = pointLocal(body, aWorldM);
    const b = pointLocal(body, bWorldM);
    const pieces = splitBodyByLine(world, body, a, b);
    nudgePiecesApart(pieces, aWorldM, bWorldM);
    created.push(...pieces);
  }
  return created;
}

function pointLocal(body: Body, worldM: Point): Point {
  const lp = body.getLocalPoint(worldM);
  return { x: lp.x, y: lp.y };
}

function segmentHitsSolid(contour: Contour, a: Point, b: Point): boolean {
  if (segmentHitsRing(a, b, contour.outline)) return true;
  for (const hole of contour.holes) {
    if (segmentHitsRing(a, b, hole)) return true;
  }
  return pointInSolid(a, contour.outline, contour.holes) || pointInSolid(b, contour.outline, contour.holes);
}

function segmentHitsRing(a: Point, b: Point, ring: Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (segmentsIntersect(a, b, ring[i], ring[(i + 1) % ring.length])) return true;
  }
  return false;
}

function splitBodyByLine(world: World, body: Body, a: Point, b: Point): Body[] {
  const tris = subjectTriangles(body);
  if (tris.length === 0) return [];

  const pos: Point[][] = [];
  const neg: Point[][] = [];
  for (const tri of tris) {
    for (const frag of splitPolyByLine(tri, a, b)) {
      if (Math.abs(signedArea(frag)) <= AREA_EPS) continue;
      if (orient(a, b, ringCentroid(frag)) >= 0) pos.push(frag);
      else neg.push(frag);
    }
  }
  if (pos.length === 0 || neg.length === 0) return [];

  const prepare = (side: Point[][]): Point[][][] => {
    const mesh = conformMesh(side.map((tri) => tri.map(snapPoint))).filter(
      (tri) => Math.abs(signedArea(tri)) > AREA_EPS,
    );
    return mesh.length === 0 ? [] : connectedComponents(mesh);
  };

  const components = [...prepare(pos), ...prepare(neg)];
  if (components.length < 2) return [];
  return splitBody(world, body, components);
}

function nudgePiecesApart(pieces: Body[], aWorldM: Point, bWorldM: Point): void {
  const dx = bWorldM.x - aWorldM.x;
  const dy = bWorldM.y - aWorldM.y;
  const len = Math.hypot(dx, dy);
  if (len < LINE_EPS || pieces.length === 0) return;
  const nx = -dy / len;
  const ny = dx / len;
  const delta = toMeters(SLICE_SEPARATION_PX);
  for (const piece of pieces) {
    const p = piece.getPosition();
    const sign = orient(aWorldM, bWorldM, { x: p.x, y: p.y }) >= 0 ? 1 : -1;
    piece.setPosition({ x: p.x + nx * sign * delta, y: p.y + ny * sign * delta });
  }
}

/** Punch a hole and return its index, or `null` for an edge bite / split / miss. */
function cutBody(world: World, body: Body, local: Point[]): number | null {
  const contour = bodyContour(body);
  if (!contour || !cutterOverlapsSolid(contour, local)) return null;
  if (cutterFitsInSolid(contour, local)) return subtractHole(body, local);
  subtractOverlap(world, body, local);
  return null;
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

export function cutterOverlapsSolid(contour: Contour, cutter: Point[]): boolean {
  if (cutter.length < 3) return false;
  const { outline, holes } = contour;
  for (const p of cutter) {
    if (pointInSolid(p, outline, holes)) return true;
  }
  for (const p of outline) {
    if (pointInRing(p, cutter)) return true;
  }
  if (ringsIntersect(cutter, outline)) return true;
  for (const hole of holes) {
    if (ringsIntersect(cutter, hole)) return true;
    for (const p of hole) {
      if (pointInRing(p, cutter)) return true;
    }
  }
  return false;
}

/** Map `source`'s local contour into `target`'s local frame. */
export function contourInBody(target: Body, source: Body, contour: Contour): Contour {
  const map = (p: Point): Point => {
    const world = source.getWorldPoint(p);
    const local = target.getLocalPoint(world);
    return { x: local.x, y: local.y };
  };
  return {
    outline: contour.outline.map(map),
    holes: contour.holes.map((ring) => ring.map(map)),
  };
}

/**
 * True when two solids overlap or touch, including shared edges. Holes are empty space, so a
 * shape sitting in another body's hole does not count.
 */
export function solidsOverlap(a: Contour, b: Contour): boolean {
  if (a.outline.length < 3 || b.outline.length < 3) return false;
  for (const p of a.outline) {
    if (pointInSolid(p, b.outline, b.holes)) return true;
  }
  for (const p of b.outline) {
    if (pointInSolid(p, a.outline, a.holes)) return true;
  }
  for (const hole of a.holes) {
    for (const p of hole) {
      if (pointInSolid(p, b.outline, b.holes)) return true;
    }
    if (ringsIntersect(hole, b.outline)) return true;
  }
  for (const hole of b.holes) {
    for (const p of hole) {
      if (pointInSolid(p, a.outline, a.holes)) return true;
    }
    if (ringsIntersect(hole, a.outline)) return true;
  }
  return ringsIntersect(a.outline, b.outline);
}

/**
 * Boolean union of two contours in the same local frame. Null when the result is not a single
 * connected solid (a vertex-only kiss, or a degenerate clip).
 */
export function unionContours(a: Contour, b: Contour): Contour | null {
  const ta = earcutContour(a);
  const tb = earcutContour(b);
  if (ta.length === 0 || tb.length === 0) return null;
  const extra = subtractSolid(tb, ta);
  const combined = conformMesh([...ta, ...extra].map((tri) => tri.map(snapPoint)));
  if (combined.length === 0) return null;
  const components = connectedComponents(combined);
  if (components.length !== 1) return null;
  const raw = meshContours(components[0]);
  const outline = simplifyRing(raw.outline);
  if (outline.length < 3) return null;
  return {
    outline,
    holes: raw.holes.map(simplifyRing).filter((ring) => ring.length >= 3),
  };
}

/** Perpendicular distance (metres) under which a vertex counts as lying on the line through its neighbours. */
const COLLINEAR_DIST = 1e-5;

/**
 * Drop near-duplicate points and vertices that sit on the straight line between their neighbours.
 * The triangle union leaves such points wherever an internal slice met the outline.
 */
function simplifyRing(ring: Point[]): Point[] {
  let pts = copyRing(ring);
  if (pts.length < 3) return pts;

  // Consecutive near-duplicates.
  const deduped: Point[] = [];
  for (const p of pts) {
    const last = deduped[deduped.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= MERGE_SNAP) continue;
    deduped.push(p);
  }
  while (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > MERGE_SNAP) break;
    deduped.pop();
  }
  pts = deduped;

  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (isBetweenOnLine(prev, cur, next)) {
        pts.splice(i, 1);
        changed = true;
        i -= 1;
      }
    }
  }
  return pts.length >= 3 ? pts : copyRing(ring);
}

/** True when `p` lies on segment `a`-`b` (within tolerance), not just on the infinite line. */
function isBetweenOnLine(a: Point, p: Point, b: Point): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len <= MERGE_SNAP) return true;
  const dist = Math.abs(orient(a, b, p)) / len;
  if (dist > COLLINEAR_DIST) return false;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / (len * len);
  return t >= -1e-9 && t <= 1 + 1e-9;
}

function subtractHole(body: Body, cutterLocal: Point[]): number | null {
  const contour = bodyContour(body);
  if (!contour) return null;
  const holeIndex = contour.holes.length;
  const holes = [...contour.holes.map(copyRing), copyRing(cutterLocal)];
  if (!applyContour(body, copyRing(contour.outline), holes)) return null;
  return holeIndex;
}

function subtractOverlap(world: World, body: Body, cutterLocal: Point[]): boolean {
  const cutters = convexPieces(cutterLocal);
  if (cutters.length === 0) return false;

  let tris = subjectTriangles(body);
  if (tris.length === 0) return false;

  for (const cutter of cutters) {
    const next: Point[][] = [];
    for (const tri of tris) next.push(...subtractConvexFromPoly(tri, cutter));
    tris = next;
  }
  tris = tris.filter((tri) => Math.abs(signedArea(tri)) > AREA_EPS);
  if (tris.length === 0) {
    world.destroyBody(body);
    return true;
  }

  const components = connectedComponents(tris);
  if (components.length === 1) return rebuildBodyFromTris(body, components[0]);
  return splitBody(world, body, components).length > 0;
}

function subjectTriangles(body: Body): Point[][] {
  const fromFixtures: Point[][] = [];
  let sawCircle = false;
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === "circle") {
      sawCircle = true;
      continue;
    }
    if (type !== "polygon") continue;
    const poly = shape as PolygonShape;
    const verts = poly.m_vertices.slice(0, poly.m_count).map((v) => ({ x: v.x, y: v.y }));
    fromFixtures.push(...fanTriangles(verts));
  }
  if (fromFixtures.length > 0 && !sawCircle) return fromFixtures;

  const contour = bodyContour(body);
  if (!contour) return fromFixtures;
  return earcutContour(contour);
}

function earcutContour(contour: Contour): Point[][] {
  const outer = ensureWinding(contour.outline, true);
  const inner = contour.holes.map((ring) => ensureWinding(ring, false));
  const verts: number[] = [];
  const holeIndices: number[] = [];
  for (const p of outer) verts.push(p.x, p.y);
  for (const hole of inner) {
    holeIndices.push(verts.length / 2);
    for (const p of hole) verts.push(p.x, p.y);
  }
  let indices: number[];
  try {
    indices = earcut(verts, holeIndices.length ? holeIndices : undefined, 2);
  } catch {
    return [];
  }
  const tris: Point[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]].map((idx) => ({
      x: verts[idx * 2],
      y: verts[idx * 2 + 1],
    }));
    if (Math.abs(signedArea(tri)) > AREA_EPS) tris.push(ensureWinding(tri, true));
  }
  return tris;
}

function convexPieces(ring: Point[]): Point[][] {
  if (ring.length < 3) return [];
  const wound = ensureWinding(ring, true);
  if (isConvex(wound)) return [wound];

  const verts = wound.map((p) => [p.x, p.y]);
  try {
    decomp.makeCCW(verts);
    decomp.removeDuplicatePoints(verts, 0.0001);
    decomp.removeCollinearPoints(verts, 0.01);
  } catch {
    return [wound];
  }
  if (verts.length < 3) return [];
  let pieces: number[][][];
  try {
    pieces = decomp.quickDecomp(verts);
  } catch {
    return [wound];
  }
  return pieces
    .map((piece) => piece.map(([x, y]) => ({ x, y })))
    .filter((piece) => piece.length >= 3 && Math.abs(signedArea(piece)) > AREA_EPS)
    .map((piece) => ensureWinding(piece, true));
}

function isConvex(ring: Point[]): boolean {
  if (ring.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const c = orient(ring[i], ring[(i + 1) % ring.length], ring[(i + 2) % ring.length]);
    if (Math.abs(c) < LINE_EPS) continue;
    const s = c > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Difference of a convex polygon and a convex cutter, as convex fragments. */
function subtractConvexFromPoly(poly: Point[], cutter: Point[]): Point[][] {
  if (poly.length < 3 || cutter.length < 3) return [];
  let fragments = [poly];
  for (let i = 0; i < cutter.length; i++) {
    const a = cutter[i];
    const b = cutter[(i + 1) % cutter.length];
    const next: Point[][] = [];
    for (const frag of fragments) next.push(...splitPolyByLine(frag, a, b));
    fragments = next;
  }
  return fragments.filter((frag) => {
    if (frag.length < 3 || Math.abs(signedArea(frag)) <= AREA_EPS) return false;
    return !pointInRing(ringCentroid(frag), cutter);
  });
}

/** Keep the parts of `tris` that lie outside the solid of `cutters` (each cutter triangle is convex). */
function subtractSolid(tris: Point[][], cutters: Point[][]): Point[][] {
  let out = tris;
  for (const cutter of cutters) {
    if (cutter.length < 3) continue;
    const next: Point[][] = [];
    for (const tri of out) next.push(...subtractConvexFromPoly(tri, cutter));
    out = next;
  }
  return out.filter((tri) => Math.abs(signedArea(tri)) > AREA_EPS);
}

const MERGE_SNAP = 1e-6;
/**
 * Perpendicular distance (metres) under which a snapped vertex still counts as lying on an edge.
 * Snapping moves a point by up to MERGE_SNAP * sqrt(2) / 2, so this must sit above that.
 */
const ON_EDGE_DIST = 4 * MERGE_SNAP;

function snapPoint(p: Point): Point {
  return {
    x: Math.round(p.x / MERGE_SNAP) * MERGE_SNAP,
    y: Math.round(p.y / MERGE_SNAP) * MERGE_SNAP,
  };
}

/**
 * Insert shared vertices that lie on another triangle's edges so adjacent union pieces share
 * exact endpoints (needed for connectivity and outline extraction).
 */
function conformMesh(tris: Point[][]): Point[][] {
  const points: Point[] = [];
  const seen = new Set<string>();
  for (const tri of tris) {
    for (const p of tri) {
      const key = vertexKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(p);
    }
  }
  const out: Point[][] = [];
  for (const tri of tris) {
    if (tri.length < 3) continue;
    const ring = insertEdgeVertices(tri, points);
    const pieces = ring.length === 3 ? fanTriangles(ring) : earcutContour({ outline: ring, holes: [] });
    for (const piece of pieces) {
      if (Math.abs(signedArea(piece)) > AREA_EPS) out.push(piece);
    }
  }
  return out;
}

function insertEdgeVertices(tri: Point[], points: Point[]): Point[] {
  const ring: Point[] = [];
  for (let i = 0; i < tri.length; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % tri.length];
    ring.push(a);
    const extras: { t: number; p: Point }[] = [];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const ab2 = abx * abx + aby * aby;
    if (ab2 < LINE_EPS * LINE_EPS) continue;
    for (const p of points) {
      if (nearPoint(p, a) || nearPoint(p, b)) continue;
      if (!vertexOnEdge(a, p, b)) continue;
      extras.push({ t: ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2, p });
    }
    extras.sort((u, v) => u.t - v.t);
    for (const extra of extras) ring.push(extra.p);
  }
  return ring;
}

function nearPoint(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= ON_EDGE_DIST;
}

function vertexOnEdge(a: Point, p: Point, b: Point): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len <= MERGE_SNAP) return false;
  if (Math.abs(orient(a, b, p)) / len > ON_EDGE_DIST) return false;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / (len * len);
  const slack = ON_EDGE_DIST / len;
  return t >= -slack && t <= 1 + slack;
}

function splitPolyByLine(poly: Point[], a: Point, b: Point): Point[][] {
  const pos: Point[] = [];
  const neg: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = orient(a, b, p);
    const sq = orient(a, b, q);
    if (sp >= -LINE_EPS) pos.push(p);
    if (sp <= LINE_EPS) neg.push(p);
    if (sp * sq < -LINE_EPS * LINE_EPS) {
      const hit = lineIntersect(p, q, a, b);
      if (hit) {
        pos.push(hit);
        neg.push(hit);
      }
    }
  }
  return [pos, neg].filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > AREA_EPS);
}

function lineIntersect(p: Point, q: Point, a: Point, b: Point): Point | null {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < LINE_EPS) return null;
  const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / denom;
  return { x: p.x + t * dx, y: p.y + t * dy };
}

function connectedComponents(tris: Point[][]): Point[][][] {
  const n = tris.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    let y = i;
    while (parent[y] !== y) {
      const next = parent[y];
      parent[y] = x;
      y = next;
    }
    return x;
  };
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sharesEdge(tris[i], tris[j])) union(i, j);
    }
  }
  const groups = new Map<number, Point[][]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(tris[i]);
    else groups.set(root, [tris[i]]);
  }
  return [...groups.values()];
}

function sharesEdge(a: Point[], b: Point[]): boolean {
  let matches = 0;
  for (const pa of a) {
    for (const pb of b) {
      if (pointsEqual(pa, pb)) {
        matches += 1;
        if (matches >= 2) return true;
      }
    }
  }
  return false;
}

function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= POINT_EPS && Math.abs(a.y - b.y) <= POINT_EPS;
}

function meshContours(tris: Point[][]): Contour {
  const edgeCount = new Map<string, { a: Point; b: Point; n: number }>();
  const bump = (a: Point, b: Point): void => {
    const key = edgeKey(a, b);
    const cur = edgeCount.get(key);
    if (cur) cur.n += 1;
    else edgeCount.set(key, { a, b, n: 1 });
  };
  for (const tri of tris) {
    for (let i = 0; i < tri.length; i++) bump(tri[i], tri[(i + 1) % tri.length]);
  }

  const adj = new Map<string, Point[]>();
  const addAdj = (a: Point, b: Point): void => {
    const key = vertexKey(a);
    const list = adj.get(key);
    if (list) list.push(b);
    else adj.set(key, [b]);
  };
  for (const { a, b, n } of edgeCount.values()) {
    if (n !== 1) continue;
    addAdj(a, b);
    addAdj(b, a);
  }

  const used = new Set<string>();
  const loops: Point[][] = [];
  for (const { a, b, n } of edgeCount.values()) {
    if (n !== 1 || used.has(edgeKey(a, b))) continue;
    const loop: Point[] = [];
    let prev: Point | null = null;
    let cur = a;
    for (let step = 0; step < 4096; step++) {
      loop.push(cur);
      const nbrs = adj.get(vertexKey(cur)) ?? [];
      let next: Point | null = null;
      for (const cand of nbrs) {
        if (prev && pointsEqual(cand, prev)) continue;
        const key = edgeKey(cur, cand);
        if (used.has(key)) continue;
        next = cand;
        used.add(key);
        break;
      }
      if (!next) break;
      prev = cur;
      cur = next;
      if (pointsEqual(cur, a)) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  if (loops.length === 0) {
    const fallback = largestTriRing(tris);
    return { outline: fallback, holes: [] };
  }
  loops.sort((x, y) => Math.abs(signedArea(y)) - Math.abs(signedArea(x)));
  return {
    outline: simplifyRing(ensureWinding(loops[0], true)),
    holes: loops
      .slice(1)
      .map((ring) => simplifyRing(ensureWinding(ring, false)))
      .filter((ring) => ring.length >= 3),
  };
}

function largestTriRing(tris: Point[][]): Point[] {
  let best = tris[0];
  let bestArea = 0;
  for (const tri of tris) {
    const area = Math.abs(signedArea(tri));
    if (area > bestArea) {
      best = tri;
      bestArea = area;
    }
  }
  return ensureWinding(best, true);
}

function vertexKey(p: Point): string {
  return `${Math.round(p.x / POINT_EPS)},${Math.round(p.y / POINT_EPS)}`;
}

function edgeKey(a: Point, b: Point): string {
  const ka = vertexKey(a);
  const kb = vertexKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function fanTriangles(verts: Point[]): Point[][] {
  if (verts.length < 3) return [];
  if (verts.length === 3) return [ensureWinding(verts, true)];
  const origin = verts[0];
  const tris: Point[][] = [];
  for (let i = 1; i < verts.length - 1; i++) {
    const tri = [origin, verts[i], verts[i + 1]];
    if (Math.abs(signedArea(tri)) > AREA_EPS) tris.push(ensureWinding(tri, true));
  }
  return tris;
}

function rebuildBodyFromTris(body: Body, tris: Point[][]): boolean {
  const material = fixtureMaterial(body);
  const contour = meshContours(tris);
  const pieces = earcutContour(contour);
  replaceFixtures(body, pieces.length > 0 ? pieces : tris, material);
  const data = getBodyData(body);
  if (data) {
    data.outline = contour.outline;
    data.holes = contour.holes;
  }
  body.synchronizeFixtures();
  body.setAwake(true);
  return true;
}

function splitBody(world: World, body: Body, components: Point[][][]): Body[] {
  const ground = findGround(world);
  const snapshots = groupJoints([body])
    .filter(isSceneJoint)
    .map((joint) => {
      const bp = jointBlueprint(joint);
      if (!bp) return null;
      return { bp, bodyA: joint.getBodyA(), bodyB: joint.getBodyB() };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const material = fixtureMaterial(body);
  const srcData = getBodyData(body);
  const type = body.getType();
  const angle = body.getAngle();
  const vel = body.getLinearVelocity();
  const spin = body.getAngularVelocity();
  const linDamp = body.getLinearDamping();
  const angDamp = body.getAngularDamping();

  const pieces: { body: Body; centroid: Point; tris: Point[][] }[] = [];
  for (const tris of components) {
    const centroid = meshCentroid(tris);
    const shifted = tris.map((tri) => tri.map((p) => ({ x: p.x - centroid.x, y: p.y - centroid.y })));
    const contour = meshContours(shifted);
    const piecesMesh = earcutContour(contour);
    const userData = cloneBodyData(srcData);
    userData.outline = contour.outline;
    userData.holes = contour.holes;
    const worldPos = body.getWorldPoint(centroid);
    const created = world.createBody({
      type,
      position: { x: worldPos.x, y: worldPos.y },
      angle,
      linearDamping: linDamp,
      angularDamping: angDamp,
      userData,
    });
    replaceFixtures(created, piecesMesh.length > 0 ? piecesMesh : shifted, material);
    created.setLinearVelocity(vel);
    created.setAngularVelocity(spin);
    created.synchronizeFixtures();
    created.setAwake(true);
    pieces.push({ body: created, centroid, tris });
  }

  if (ground) {
    for (const snap of snapshots) {
      const mappedA = mapCutEnd(snap.bodyA, snap.bp.localAnchorA, body, pieces);
      const mappedB = mapCutEnd(snap.bodyB, snap.bp.localAnchorB, body, pieces);
      if (!mappedA || !mappedB) continue;
      if (mappedA.body === mappedB.body) continue;
      const localA = snap.bp.localA ? shiftIfOld(snap.bp.localA, snap.bodyA, body, pieces) : snap.bp.localA;
      const localB = snap.bp.localB ? shiftIfOld(snap.bp.localB, snap.bodyB, body, pieces) : snap.bp.localB;
      if (localA === null || localB === null) continue;
      buildJoint(
        world,
        ground,
        { ...snap.bp, localAnchorA: mappedA.local, localAnchorB: mappedB.local, localA, localB },
        mappedA.body,
        mappedB.body,
      );
    }
  }

  world.destroyBody(body);
  return pieces.map((piece) => piece.body);
}

function mapCutEnd(
  old: Body,
  local: Point,
  cut: Body,
  pieces: { body: Body; centroid: Point; tris: Point[][] }[],
): { body: Body; local: Point } | null {
  if (old !== cut) return { body: old, local: { x: local.x, y: local.y } };
  const piece = pieceContaining(local, pieces);
  if (!piece) return null;
  return {
    body: piece.body,
    local: { x: local.x - piece.centroid.x, y: local.y - piece.centroid.y },
  };
}

function shiftIfOld(
  local: Point,
  owner: Body,
  cut: Body,
  pieces: { body: Body; centroid: Point; tris: Point[][] }[],
): Point | undefined | null {
  if (owner !== cut) return { x: local.x, y: local.y };
  const piece = pieceContaining(local, pieces);
  if (!piece) return null;
  return { x: local.x - piece.centroid.x, y: local.y - piece.centroid.y };
}

function pieceContaining(
  local: Point,
  pieces: { body: Body; centroid: Point; tris: Point[][] }[],
): { body: Body; centroid: Point; tris: Point[][] } | null {
  for (const piece of pieces) {
    for (const tri of piece.tris) {
      if (pointInRing(local, tri)) return piece;
    }
  }
  return null;
}

function findGround(world: World): Body | null {
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (getBodyData(body)?.kind === "ground") return body;
  }
  return null;
}

function meshCentroid(tris: Point[][]): Point {
  let x = 0;
  let y = 0;
  let area = 0;
  for (const tri of tris) {
    const a = signedArea(tri);
    const c = ringCentroid(tri);
    x += c.x * a;
    y += c.y * a;
    area += a;
  }
  if (Math.abs(area) < AREA_EPS) return ringCentroid(tris[0]);
  return { x: x / area, y: y / area };
}

function fixtureMaterial(body: Body): { density: number; friction: number; restitution: number } {
  const proto = body.getFixtureList();
  return {
    density: proto ? proto.getDensity() : FIXTURE.density,
    friction: proto ? proto.getFriction() : FIXTURE.friction,
    restitution: proto ? proto.getRestitution() : FIXTURE.restitution,
  };
}

function replaceFixtures(
  body: Body,
  tris: Point[][],
  material: { density: number; friction: number; restitution: number },
): void {
  const stale: NonNullable<ReturnType<Body["getFixtureList"]>>[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) stale.push(f);
  for (const f of stale) body.destroyFixture(f);
  for (const tri of tris) {
    for (const piece of fanTriangles(tri)) {
      body.createFixture({
        shape: new Polygon(piece),
        density: material.density,
        friction: material.friction,
        restitution: material.restitution,
      });
    }
  }
  applyCollisionFilter(body);
}

/** Rebuild a filled body's fixtures from an outline and holes. Returns false if the contour is degenerate. */
export function applyContour(body: Body, outline: Point[], holes: Point[][]): boolean {
  const pieces = earcutContour({ outline, holes });
  if (pieces.length === 0) return false;
  const material = fixtureMaterial(body);
  replaceFixtures(body, pieces, material);
  const data = getBodyData(body);
  if (data) {
    data.outline = ensureWinding(outline, true);
    data.holes = holes.map((ring) => ensureWinding(ring, false));
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

export function pointInRing(p: Point, ring: Point[]): boolean {
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
