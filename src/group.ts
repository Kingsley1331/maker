import { DistanceJoint, MouseJoint, type Body, type Joint } from "planck";
import { bodyBoundsPx } from "./physics";
import { getBodyData, isPickable, scaleBody, type JointUserData } from "./shapes";
import type { Point } from "./units";

/**
 * A "group" is the set of pickable shapes reachable from one shape through joints. Ground and
 * walls are never members, but joints to them (world pins) are still carried along.
 */

/** Planck keeps joint anchors as internal fields; this is the shape we rely on. */
interface AnchoredJoint extends Joint {
  m_localAnchorA: { x: number; y: number };
  m_localAnchorB: { x: number; y: number };
}

function anchors(joint: Joint): AnchoredJoint | null {
  const j = joint as AnchoredJoint;
  if (!j.m_localAnchorA || !j.m_localAnchorB) return null;
  return j;
}

function isSceneJoint(joint: Joint): boolean {
  return joint.getType() !== MouseJoint.TYPE;
}

/** Every pickable shape connected to `body` (including itself) via non-mouse joints. */
export function connectedBodies(body: Body): Body[] {
  const seen = new Set<Body>([body]);
  const queue: Body[] = [body];
  while (queue.length > 0) {
    const current = queue.shift() as Body;
    for (let edge = current.getJointList(); edge; edge = edge.next) {
      const other = edge.other;
      const joint = edge.joint;
      if (!other || !joint || !isSceneJoint(joint)) continue;
      if (!isPickable(other) || seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return [...seen];
}

/** Every non-mouse joint that touches at least one member. */
export function groupJoints(bodies: Body[]): Joint[] {
  const joints = new Set<Joint>();
  for (const body of bodies) {
    for (let edge = body.getJointList(); edge; edge = edge.next) {
      if (edge.joint && isSceneJoint(edge.joint)) joints.add(edge.joint);
    }
  }
  return [...joints];
}

export function groupBoundsPx(bodies: Body[]): { min: Point; max: Point } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    const { min, max } = bodyBoundsPx(body);
    minX = Math.min(minX, min.x);
    minY = Math.min(minY, min.y);
    maxX = Math.max(maxX, max.x);
    maxY = Math.max(maxY, max.y);
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** World-space point transform (metres). */
type WorldTransform = (p: Point) => Point;

/**
 * After the members have been moved, keep joints consistent:
 * - anchors on static non-members (the ground a pin hangs from) get the same world transform, so
 *   the pin travels with the shapes (ground is at the origin with angle 0, so its local anchor is
 *   the world point). Anchors on dynamic non-members (another shape edited separately) are left
 *   alone; the joint pulls them back together on Play, as before;
 * - when scaling, member-side anchors, weld/wheel draw points and rod lengths scale too, so the
 *   joint stays on the same spot of each resized shape.
 */
function fixJoints(bodies: Body[], transform: WorldTransform, scale: number): void {
  const members = new Set(bodies);
  for (const joint of groupJoints(bodies)) {
    const j = anchors(joint);
    if (!j) continue;
    const bodyA = joint.getBodyA();
    const bodyB = joint.getBodyB();

    if (!members.has(bodyA)) {
      if (!bodyA.isDynamic()) {
        const moved = transform(bodyA.getWorldPoint(j.m_localAnchorA));
        const local = bodyA.getLocalPoint(moved);
        j.m_localAnchorA.x = local.x;
        j.m_localAnchorA.y = local.y;
      }
    } else if (scale !== 1) {
      j.m_localAnchorA.x *= scale;
      j.m_localAnchorA.y *= scale;
    }

    if (!members.has(bodyB)) {
      if (!bodyB.isDynamic()) {
        const moved = transform(bodyB.getWorldPoint(j.m_localAnchorB));
        const local = bodyB.getLocalPoint(moved);
        j.m_localAnchorB.x = local.x;
        j.m_localAnchorB.y = local.y;
      }
    } else if (scale !== 1) {
      j.m_localAnchorB.x *= scale;
      j.m_localAnchorB.y *= scale;
    }

    if (scale !== 1) {
      const data = joint.getUserData() as JointUserData | undefined;
      if (data?.localA && members.has(bodyA)) {
        data.localA = { x: data.localA.x * scale, y: data.localA.y * scale };
      }
      if (data?.localB && members.has(bodyB)) {
        data.localB = { x: data.localB.x * scale, y: data.localB.y * scale };
      }
      if (joint instanceof DistanceJoint || joint.getType() === DistanceJoint.TYPE) {
        const rod = joint as DistanceJoint;
        rod.setLength(rod.getLength() * scale);
      }
    }
  }
}

function finish(bodies: Body[]): void {
  for (const body of bodies) {
    body.synchronizeFixtures();
    body.setAwake(true);
  }
}

/** Move every member by `d` (metres). Velocities are untouched (freeze-frame edit). */
export function translateGroup(bodies: Body[], d: Point): void {
  if (d.x === 0 && d.y === 0) return;
  for (const body of bodies) {
    const p = body.getPosition();
    body.setPosition({ x: p.x + d.x, y: p.y + d.y });
  }
  fixJoints(bodies, (p) => ({ x: p.x + d.x, y: p.y + d.y }), 1);
  finish(bodies);
}

/** Rotate every member by `dAngle` about world point `c` (metres). */
export function rotateGroup(bodies: Body[], c: Point, dAngle: number): void {
  if (dAngle === 0) return;
  const cos = Math.cos(dAngle);
  const sin = Math.sin(dAngle);
  const rotate: WorldTransform = (p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  };
  for (const body of bodies) {
    body.setTransform(rotate(body.getPosition()), body.getAngle() + dAngle);
  }
  fixJoints(bodies, rotate, 1);
  finish(bodies);
}

/** Uniformly scale every member by `factor` about world point `c` (metres). */
export function scaleGroup(bodies: Body[], c: Point, factor: number): void {
  if (Math.abs(factor - 1) < 1e-4) return;
  const scale: WorldTransform = (p) => ({
    x: c.x + (p.x - c.x) * factor,
    y: c.y + (p.y - c.y) * factor,
  });
  for (const body of bodies) {
    scaleBody(body, factor);
    body.setPosition(scale(body.getPosition()));
  }
  fixJoints(bodies, scale, factor);
  finish(bodies);
}

/** Total mass of the members. */
export function groupMass(bodies: Body[]): number {
  let mass = 0;
  for (const body of bodies) mass += body.getMass();
  return mass;
}

/** Human label for a member, used in readouts. */
export function bodyLabel(body: Body): string {
  return (getBodyData(body)?.label ?? "Body").replace(/ Body$/, "");
}
