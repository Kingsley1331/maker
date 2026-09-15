import { type Body, type World } from "planck";
import {
  applyContour,
  bodyContour,
  contourInBody,
  solidsOverlap,
  unionContours,
} from "./cut";
import { groupJoints } from "./group";
import { bodyBoundsPx } from "./physics";
import { buildJoint, isSceneJoint, jointBlueprint } from "./scene-edit";
import { getBodyData, isPickable } from "./shapes";
import type { Point } from "./units";

/** Pixel pad so barely-touching AABBs still go to the exact contour test. */
const AABB_PAD = 1;

function aabbTouches(a: Body, b: Body): boolean {
  const A = bodyBoundsPx(a);
  const B = bodyBoundsPx(b);
  return (
    A.min.x <= B.max.x + AABB_PAD &&
    A.max.x >= B.min.x - AABB_PAD &&
    A.min.y <= B.max.y + AABB_PAD &&
    A.max.y >= B.min.y - AABB_PAD
  );
}

function findGround(world: World): Body | null {
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (getBodyData(body)?.kind === "ground") return body;
  }
  return null;
}

/** True when two filled pickable bodies overlap or touch in world space. */
export function bodiesOverlapOrTouch(a: Body, b: Body): boolean {
  if (a === b) return false;
  const ca = bodyContour(a);
  const cb = bodyContour(b);
  if (!ca || !cb) return false;
  if (!aabbTouches(a, b)) return false;
  return solidsOverlap(ca, contourInBody(a, b, cb));
}

function mergeableBodies(world: World): Body[] {
  const out: Body[] = [];
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (!isPickable(body) || !bodyContour(body)) continue;
    out.push(body);
  }
  return out;
}

/**
 * Every mergeable body in the overlap/touch cluster reachable from `seeds` (including the seeds
 * that themselves have a contour).
 */
export function mergeCluster(world: World, seeds: readonly Body[]): Body[] {
  const pool = mergeableBodies(world);
  const seen = new Set<Body>();
  const queue: Body[] = [];
  for (const seed of seeds) {
    if (!pool.includes(seed) || seen.has(seed)) continue;
    seen.add(seed);
    queue.push(seed);
  }
  while (queue.length > 0) {
    const current = queue.shift() as Body;
    for (const other of pool) {
      if (seen.has(other)) continue;
      if (!bodiesOverlapOrTouch(current, other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return [...seen];
}

/** Bodies that would be absorbed into `selected` (the overlap cluster minus `selected`). */
export function mergeTargets(world: World, selected: Body, members: readonly Body[]): Body[] {
  const seeds = members.length > 0 ? members : [selected];
  return mergeCluster(world, seeds).filter((body) => body !== selected);
}

function mapAnchor(body: Body, local: Point, keep: Body, absorb: Set<Body>): { body: Body; local: Point } {
  if (!absorb.has(body)) return { body, local: { x: local.x, y: local.y } };
  const world = body.getWorldPoint(local);
  const mapped = keep.getLocalPoint(world);
  return { body: keep, local: { x: mapped.x, y: mapped.y } };
}

function mapDraw(owner: Body, local: Point | undefined, keep: Body, absorb: Set<Body>): Point | undefined {
  if (!local) return local;
  return mapAnchor(owner, local, keep, absorb).local;
}

/**
 * Union every overlapping/touching neighbour into `selected`. Returns the absorbed bodies, or
 * null when merge is not possible. `selected` keeps its color, type, material, streams, and winds.
 */
export function tryMergeSelection(world: World, selected: Body, members: readonly Body[]): Body[] | null {
  const absorb = mergeTargets(world, selected, members);
  if (absorb.length === 0) return null;

  let contour = bodyContour(selected);
  if (!contour) return null;
  for (const other of absorb) {
    const otherContour = bodyContour(other);
    if (!otherContour) return null;
    const next = unionContours(contour, contourInBody(selected, other, otherContour));
    if (!next) return null;
    contour = next;
  }
  if (!applyContour(selected, contour.outline, contour.holes)) return null;

  const absorbSet = new Set(absorb);
  const ground = findGround(world);
  if (ground) {
    const snapshots = groupJoints([selected, ...absorb])
      .filter(isSceneJoint)
      .map((joint) => {
        const bp = jointBlueprint(joint);
        if (!bp) return null;
        return { bp, bodyA: joint.getBodyA(), bodyB: joint.getBodyB() };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    for (const snap of snapshots) {
      const aAbsorbed = absorbSet.has(snap.bodyA);
      const bAbsorbed = absorbSet.has(snap.bodyB);
      if (!aAbsorbed && !bAbsorbed) continue;
      const mappedA = mapAnchor(snap.bodyA, snap.bp.localAnchorA, selected, absorbSet);
      const mappedB = mapAnchor(snap.bodyB, snap.bp.localAnchorB, selected, absorbSet);
      if (mappedA.body === mappedB.body) continue;
      const localA = mapDraw(snap.bodyA, snap.bp.localA, selected, absorbSet);
      const localB = mapDraw(snap.bodyB, snap.bp.localB, selected, absorbSet);
      buildJoint(
        world,
        ground,
        { ...snap.bp, localAnchorA: mappedA.local, localAnchorB: mappedB.local, localA, localB },
        mappedA.body,
        mappedB.body,
      );
    }
  }

  for (const body of absorb) world.destroyBody(body);
  selected.setAwake(true);
  return absorb;
}
