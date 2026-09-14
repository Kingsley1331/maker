import type { Body, World } from "planck";
import { advanceSchedule } from "./schedule";
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
  /** Second half of the current mirrored pair, waiting to be emitted; null between pairs. */
  pending: number | null;
  /** Running sum of each pair's leading offset from the centre; kept near zero. */
  lead: number;
  /** Seconds until the next randomised emission; unused when the stream is even. */
  wait: number;
}

export interface StreamHit {
  /** World position in meters. */
  point: Point;
  /** Simulated time (seconds) at which the particle struck. */
  time: number;
}

/**
 * Emission state per stream setting. Every body owns its own copy of each setting, and the UI
 * replaces the object on every change, so keying on it gives each stream its own accumulator and
 * sample sequence without an explicit reset.
 */
const states = new WeakMap<ParticleStream, StreamState>();
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

/**
 * Position of the next particle across the body's silhouette, in [0, 1).
 *
 * Samples come in mirrored pairs `0.5 ± u`, with `u` drawn from the van der Corput sequence so the
 * set of hit points stays evenly spread at every prefix length. Using the raw sequence directly
 * always put the lower half before the upper half (`vdc(2m + 1) = vdc(2m) + 0.5`), so between the
 * two hits of every pair the body carried a one-sided torque and slowly rolled in one direction.
 * Each pair now leads with whichever side brings the running sum of leading offsets back toward
 * zero, so that torque has no long-run direction.
 */
function nextSample(state: StreamState): number {
  if (state.pending !== null) {
    const s = state.pending;
    state.pending = null;
    return s;
  }
  const u = vanDerCorput(state.index++) * 0.5;
  const sign = state.lead > 0 ? -1 : 1;
  state.lead += sign * u;
  state.pending = 0.5 - sign * u;
  return 0.5 + sign * u;
}

function recordHit(point: Point): void {
  if (hits.length >= MAX_HITS) hits.shift();
  hits.push({ point, time: simTime });
}

/** Exponential waiting time with mean `1 / rate`, for a Poisson process of that rate. */
function exponentialWait(rate: number): number {
  let u = Math.random();
  while (u <= 0) u = Math.random();
  return -Math.log(u) / rate;
}

function howManyThisStep(state: StreamState, frequency: number, dt: number, random: boolean): number {
  state.acc += dt;
  if (!random) {
    const count = Math.floor(state.acc * frequency);
    if (count > 0) state.acc -= count / frequency;
    return count;
  }
  if (state.wait <= 0) state.wait = exponentialWait(frequency);
  let count = 0;
  while (state.acc >= state.wait) {
    state.acc -= state.wait;
    state.wait = exponentialWait(frequency);
    count++;
  }
  return count;
}

function stepBody(body: Body, stream: ParticleStream, dt: number): void {
  let state = states.get(stream);
  if (!state) {
    state = { acc: 0, index: 1, pending: null, lead: 0, wait: 0 };
    states.set(stream, state);
  }
  const frequency = Math.max(0, stream.frequency);
  if (frequency <= 0 || stream.intensity <= 0) return;

  const random = stream.random === true;
  const count = howManyThisStep(state, frequency, dt, random);
  if (count <= 0) return;

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

  for (let k = 0; k < count; k++) {
    const t = random ? Math.random() : nextSample(state);
    const mag = random ? Math.random() * 2 * stream.intensity : stream.intensity;
    const s = extent.min + t * (extent.max - extent.min);
    const p1 = {
      x: centre.x + (s - centreSide) * side.x + (startAlong - centreAlong) * dir.x,
      y: centre.y + (s - centreSide) * side.y + (startAlong - centreAlong) * dir.y,
    };
    const p2 = { x: p1.x + dir.x * reach, y: p1.y + dir.y * reach };
    const hit = rayHit(body, p1, p2);
    if (!hit) continue;
    body.applyLinearImpulse({ x: dir.x * mag, y: dir.y * mag }, hit.point, true);
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
    if (!data || data.kind !== "shape" || !data.streams) continue;
    for (const stream of data.streams) {
      // The schedule clock runs whether or not the body can currently be moved.
      const on = advanceSchedule(stream, dt);
      if (!on || body.getType() !== "dynamic") continue;
      stepBody(body, stream, dt);
    }
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
