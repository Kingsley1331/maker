import {
  Vec2,
  type Body,
  type ChainShape,
  type CircleShape,
  type EdgeShape,
  type PolygonShape,
  type RayCastInput,
  type RayCastOutput,
  type World,
} from "planck";
import { getBodyData, type ParticleStream } from "./shapes";
import type { Point } from "./units";

/** Extra reach past the body's bounds for the incoming ray (meters). */
const RAY_MARGIN = 0.5;
/** How long an impact dot stays visible (seconds of simulated time). */
export const HIT_FADE_SECONDS = 0.15;
/** Most recent hits kept for drawing. */
const MAX_HITS = 256;

interface StreamState {
  /** Simulated seconds accumulated since the last emitted particle. */
  acc: number;
  /** Next index into the low-discrepancy sequence. */
  index: number;
}

export interface StreamHit {
  /** World position in meters. */
  point: Point;
  /** Simulated time (seconds) at which the particle struck. */
  time: number;
}

const states = new WeakMap<Body, StreamState>();
const hits: StreamHit[] = [];
let simTime = 0;

/** Base-2 van der Corput sequence: evenly spread in [0, 1) at every prefix length. */
function vanDerCorput(index: number): number {
  let result = 0;
  let denom = 1;
  let n = index;
  while (n > 0) {
    denom *= 2;
    result += (n & 1) / denom;
    n >>>= 1;
  }
  return result;
}

/** Projection of the body's silhouette onto `axis` (world space): `[min, max]`. */
function extentAlong(body: Body, axis: Point): { min: number; max: number } | null {
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
function rayHit(body: Body, p1: Point, p2: Point): Point | null {
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
  return { x: p1.x + (p2.x - p1.x) * best, y: p1.y + (p2.y - p1.y) * best };
}

function recordHit(point: Point): void {
  if (hits.length >= MAX_HITS) hits.shift();
  hits.push({ point, time: simTime });
}

function stepBody(body: Body, stream: ParticleStream, dt: number): void {
  let state = states.get(body);
  if (!state) {
    state = { acc: 0, index: 1 };
    states.set(body, state);
  }
  const frequency = Math.max(0, stream.frequency);
  if (frequency <= 0 || stream.intensity <= 0) return;

  state.acc += dt;
  const count = Math.floor(state.acc * frequency);
  if (count <= 0) return;
  state.acc -= count / frequency;

  const theta = (stream.angleDeg * Math.PI) / 180;
  const dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const side = { x: -dir.y, y: dir.x };

  const extent = extentAlong(body, side);
  if (!extent) return;
  const along = extentAlong(body, dir);
  if (!along) return;
  const reach = along.max - along.min + RAY_MARGIN * 2;

  const centre = body.getWorldCenter();
  // Start every ray on a line upstream of the body, perpendicular to the direction of travel.
  const startAlong = along.min - RAY_MARGIN;
  const centreAlong = centre.x * dir.x + centre.y * dir.y;
  const impulse = { x: dir.x * stream.intensity, y: dir.y * stream.intensity };

  for (let k = 0; k < count; k++) {
    const t = vanDerCorput(state.index++);
    const s = extent.min + t * (extent.max - extent.min);
    const centreSide = centre.x * side.x + centre.y * side.y;
    const p1 = {
      x: centre.x + (s - centreSide) * side.x + (startAlong - centreAlong) * dir.x,
      y: centre.y + (s - centreSide) * side.y + (startAlong - centreAlong) * dir.y,
    };
    const p2 = { x: p1.x + dir.x * reach, y: p1.y + dir.y * reach };
    const hit = rayHit(body, p1, p2);
    if (!hit) continue;
    body.applyLinearImpulse(impulse, hit, true);
    recordHit(hit);
  }
}

/**
 * Fire this step's particles at every dynamic shape with a stream. Call once per fixed step,
 * before `world.step`.
 */
export function stepParticleStreams(world: World, dt: number): void {
  simTime += dt;
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    const data = getBodyData(body);
    if (!data || data.kind !== "shape" || !data.stream) continue;
    if (body.getType() !== "dynamic") continue;
    stepBody(body, data.stream, dt);
  }
  // Drop hits that have already faded so the buffer stays small when streams stop.
  while (hits.length > 0 && simTime - hits[0].time > HIT_FADE_SECONDS) hits.shift();
}

/** Recent impacts with their age in seconds (0 = this step), oldest first. */
export function recentHits(): { point: Point; age: number }[] {
  return hits.map((h) => ({ point: h.point, age: simTime - h.time }));
}

/** Unit vector of the stream's direction of travel. */
export function streamDirection(stream: ParticleStream): Point {
  const theta = (stream.angleDeg * Math.PI) / 180;
  return { x: Math.cos(theta), y: Math.sin(theta) };
}

/**
 * Where to draw the direction indicator: a segment (meters) sitting `gap` metres upstream of the
 * body's silhouette, `length` metres long, pointing along the stream toward the body.
 */
export function streamArrow(
  body: Body,
  stream: ParticleStream,
  gap: number,
  length: number,
): { tail: Point; head: Point } | null {
  const dir = streamDirection(stream);
  const along = extentAlong(body, dir);
  if (!along) return null;
  const centre = body.getWorldCenter();
  const centreAlong = centre.x * dir.x + centre.y * dir.y;
  const headAlong = along.min - gap;
  const head = {
    x: centre.x + (headAlong - centreAlong) * dir.x,
    y: centre.y + (headAlong - centreAlong) * dir.y,
  };
  return { tail: { x: head.x - dir.x * length, y: head.y - dir.y * length }, head };
}
