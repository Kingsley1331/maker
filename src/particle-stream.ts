import type { Body, World } from "planck";
import { getBodyData, type ParticleStream } from "./shapes";
import { directionOf, extentAlong, rayHit, upstreamArrow } from "./surface";
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

  const dir = directionOf(stream.angleDeg);
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
  const centreSide = centre.x * side.x + centre.y * side.y;
  const impulse = { x: dir.x * stream.intensity, y: dir.y * stream.intensity };

  for (let k = 0; k < count; k++) {
    const t = vanDerCorput(state.index++);
    const s = extent.min + t * (extent.max - extent.min);
    const p1 = {
      x: centre.x + (s - centreSide) * side.x + (startAlong - centreAlong) * dir.x,
      y: centre.y + (s - centreSide) * side.y + (startAlong - centreAlong) * dir.y,
    };
    const p2 = { x: p1.x + dir.x * reach, y: p1.y + dir.y * reach };
    const hit = rayHit(body, p1, p2);
    if (!hit) continue;
    body.applyLinearImpulse(impulse, hit.point, true);
    recordHit(hit.point);
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
  return directionOf(stream.angleDeg);
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
  return upstreamArrow(body, directionOf(stream.angleDeg), gap, length);
}
