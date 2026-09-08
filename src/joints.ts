import { DistanceJoint, RevoluteJoint, type Body, type Joint, type World } from "planck";
import type { JointUserData } from "./shapes";
import { vecToMeters, type Point } from "./units";

export type JointType = "pin" | "revolute" | "rod";

export const JOINT_TYPES: JointType[] = ["pin", "revolute", "rod"];

/** Pin a body to the world at `world` (pixels). The body can still rotate around that point. */
export function createPin(world: World, ground: Body, body: Body, worldPt: Point): Joint | null {
  const anchor = vecToMeters(worldPt);
  return world.createJoint(
    new RevoluteJoint(
      { collideConnected: false, userData: { kind: "pin" } satisfies JointUserData },
      ground,
      body,
      anchor,
    ),
  );
}

/**
 * Hinge two bodies so the two click points (pixels) become one shared pivot.
 * Body B is translated (not rotated) so its click already sits on `pointA`, then a revolute
 * is created at that world point. That is a true hinge: the clicked spots stay coincident and
 * the bodies can fold around them. They do not collide with each other through the joint.
 */
export function createRevolute(
  world: World,
  bodyA: Body,
  pointA: Point,
  bodyB: Body,
  pointB: Point,
): Joint | null {
  const hinge = vecToMeters(pointA);
  const localB = bodyB.getLocalPoint(vecToMeters(pointB));
  const current = bodyB.getWorldPoint(localB);
  const pos = bodyB.getPosition();
  bodyB.setPosition({
    x: pos.x + (hinge.x - current.x),
    y: pos.y + (hinge.y - current.y),
  });
  bodyB.synchronizeFixtures();

  return world.createJoint(
    new RevoluteJoint(
      { collideConnected: false, userData: { kind: "revolute" } satisfies JointUserData },
      bodyA,
      bodyB,
      hinge,
    ),
  );
}

/** Rigid bar between two points on two bodies. Length is taken from the initial distance. */
export function createRod(
  world: World,
  bodyA: Body,
  pointA: Point,
  bodyB: Body,
  pointB: Point,
): Joint | null {
  return world.createJoint(
    new DistanceJoint(
      { collideConnected: true, frequencyHz: 0, userData: { kind: "rod" } satisfies JointUserData },
      bodyA,
      bodyB,
      vecToMeters(pointA),
      vecToMeters(pointB),
    ),
  );
}
