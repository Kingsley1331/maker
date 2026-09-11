import {
  Vec2,
  type Body,
  type ChainShape,
  type CircleShape,
  type EdgeShape,
  type PolygonShape,
  type RayCastInput,
  type RayCastOutput,
} from "planck";
import type { Point } from "./units";

/** Unit vector for a screen-space angle in degrees (0 = rightwards, 90 = downwards). */
export function directionOf(angleDeg: number): Point {
  const theta = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(theta), y: Math.sin(theta) };
}

/** Projection of the body's silhouette onto `axis` (world space, metres): `[min, max]`. */
export function extentAlong(body: Body, axis: Point): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const include = (p: Point): void => {
    const s = p.x * axis.x + p.y * axis.y;
    if (s < min) min = s;
    if (s > max) max = s;
  };
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === "circle") {
      const circle = shape as CircleShape;
      const c = body.getWorldPoint(circle.getCenter());
      const r = circle.getRadius();
      const s = c.x * axis.x + c.y * axis.y;
      if (s - r < min) min = s - r;
      if (s + r > max) max = s + r;
    } else if (type === "polygon") {
      const poly = shape as PolygonShape;
      for (let i = 0; i < poly.m_count; i++) include(body.getWorldPoint(poly.m_vertices[i]));
    } else if (type === "edge") {
      const edge = shape as EdgeShape;
      include(body.getWorldPoint(edge.m_vertex1));
      include(body.getWorldPoint(edge.m_vertex2));
    } else if (type === "chain") {
      const chain = shape as ChainShape;
      for (let i = 0; i < chain.m_count; i++) include(body.getWorldPoint(chain.m_vertices[i]));
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** First point where the ray `p1 -> p2` meets any fixture of `body`, or null. */
export function rayHit(body: Body, p1: Point, p2: Point): { point: Point; fraction: number } | null {
  const input: RayCastInput = { p1, p2, maxFraction: 1 };
  const output: RayCastOutput = { normal: Vec2.zero(), fraction: 0 };
  let best = Infinity;
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const children = f.getShape().getChildCount();
    for (let i = 0; i < children; i++) {
      if (f.rayCast(output, input, i) && output.fraction < best) best = output.fraction;
    }
  }
  if (!Number.isFinite(best)) return null;
  return {
    point: { x: p1.x + (p2.x - p1.x) * best, y: p1.y + (p2.y - p1.y) * best },
    fraction: best,
  };
}

/**
 * Where to draw a direction indicator: a segment (metres) sitting `gap` metres upstream of the
 * body's silhouette, `length` metres long, pointing along `dir` toward the body. `sideOffset`
 * shifts the arrow perpendicular to `dir` (metres) from the body's centre.
 */
export function upstreamArrow(
  body: Body,
  dir: Point,
  gap: number,
  length: number,
  sideOffset = 0,
): { tail: Point; head: Point } | null {
  const along = extentAlong(body, dir);
  if (!along) return null;
  const centre = body.getWorldCenter();
  const centreAlong = centre.x * dir.x + centre.y * dir.y;
  const headAlong = along.min - gap;
  const side = { x: -dir.y, y: dir.x };
  const head = {
    x: centre.x + (headAlong - centreAlong) * dir.x + side.x * sideOffset,
    y: centre.y + (headAlong - centreAlong) * dir.y + side.y * sideOffset,
  };
  return { tail: { x: head.x - dir.x * length, y: head.y - dir.y * length }, head };
}
