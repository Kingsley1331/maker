import type { Body, World } from "planck";
import { bodyContour } from "./cut";
import { getBodyData, type DirectionalForce } from "./shapes";
import { directionOf, extentAlong, rayHit } from "./surface";
import type { Point } from "./units";

/** How far upstream of the body the shadow-test rays start (metres). */
const RAY_MARGIN = 0.5;
/**
 * An edge counts as shielded when the ray toward its midpoint stops on a surface further than
 * this from the edge's line: a fixed part plus a fraction of the body's depth along the flow. The
 * relative part keeps circle contours (24-gons inscribed in the real circle fixture, sagitta
 * about 0.9% of the radius) from shadowing themselves.
 */
const SHADOW_ABS = 0.005;
const SHADOW_REL = 0.01;

export interface FacingEdge {
  /** World-space ends, metres. */
  a: Point;
  b: Point;
  /** Cosine of the angle of incidence: 1 for a face square to the flow, 0 for a grazing edge. */
  cosA: number;
}

function signedArea(ring: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

/**
 * Outline edges of `body` that face the flow direction `dir` and are not shielded by another part
 * of the same body. Empty for shapes without a filled outline (edges, chains).
 */
export function facingEdges(body: Body, dir: Point): FacingEdge[] {
  const contour = bodyContour(body);
  if (!contour) return [];
  const ring = contour.outline;
  if (ring.length < 3) return [];

  const world = ring.map((p) => {
    const w = body.getWorldPoint(p);
    return { x: w.x, y: w.y };
  });
  // Rotation preserves orientation, so the local ring's winding tells us which side is outside.
  // For a positive shoelace area the outward normal of edge a->b is (e.y, -e.x) / |e| (e.g. the
  // top edge of a box traversed left to right points up); otherwise the opposite.
  const outwardSign = signedArea(ring) > 0 ? 1 : -1;

  const along = extentAlong(body, dir);
  const startAlong = along ? along.min - RAY_MARGIN : 0;
  const shadowTol = along ? SHADOW_ABS + SHADOW_REL * (along.max - along.min) : 0;

  const out: FacingEdge[] = [];
  for (let i = 0; i < world.length; i++) {
    const a = world[i];
    const b = world[(i + 1) % world.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const nx = (outwardSign * ey) / len;
    const ny = (outwardSign * -ex) / len;
    const cosA = -(nx * dir.x + ny * dir.y);
    if (cosA <= 1e-6) continue;

    if (along) {
      // Shadow test: does the flow reach this edge's midpoint before hitting the body elsewhere?
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const midAlong = mid.x * dir.x + mid.y * dir.y;
      const back = midAlong - startAlong;
      const p1 = { x: mid.x - dir.x * back, y: mid.y - dir.y * back };
      const hit = rayHit(body, p1, mid);
      if (hit) {
        // Distance from the surface actually struck to this edge's line, measured along the
        // edge normal so grazing rays are not penalised.
        const off = Math.abs((hit.point.x - mid.x) * nx + (hit.point.y - mid.y) * ny);
        if (off > shadowTol) continue;
      }
    }
    out.push({ a, b, cosA });
  }
  return out;
}

/**
 * Push every facing outline edge along the flow by `force x length x cos(A)`, applied at the
 * edge midpoint (exact for a uniform load on a straight edge). Returns the total force applied.
 */
function applyWind(body: Body, wind: DirectionalForce): number {
  if (wind.force <= 0) return 0;
  const dir = directionOf(wind.angleDeg);
  let total = 0;
  for (const edge of facingEdges(body, dir)) {
    const len = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
    const magnitude = wind.force * len * edge.cosA;
    const mid = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
    body.applyForce({ x: dir.x * magnitude, y: dir.y * magnitude }, mid, true);
    total += magnitude;
  }
  return total;
}

/**
 * Apply this step's wind pressure to every dynamic shape with a directional force. Call once per
 * fixed step, before `world.step` (forces are cleared by the step).
 */
export function stepDirectionalForces(world: World): void {
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    const data = getBodyData(body);
    if (!data || data.kind !== "shape" || !data.wind) continue;
    if (body.getType() !== "dynamic") continue;
    applyWind(body, data.wind);
  }
}

/** Unit vector of the wind's direction. */
export function windDirection(wind: DirectionalForce): Point {
  return directionOf(wind.angleDeg);
}
