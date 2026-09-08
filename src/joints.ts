import { DistanceJoint, RevoluteJoint, WeldJoint, WheelJoint, type Body, type Joint, type World } from "planck";
import type { JointUserData } from "./shapes";
import { vecToMeters, type Point } from "./units";

export type JointType = "pin" | "revolute" | "rod" | "weld" | "wheel";

export const JOINT_TYPES: JointType[] = ["pin", "revolute", "rod", "weld", "wheel"];

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

/**
 * Rigid bar between two points that also locks relative rotation (a rod that cannot pivot).
 * Physics is a weld of the current pose at the midpoint so the bodies are not yanked together.
 */
export function createWeld(
  world: World,
  bodyA: Body,
  pointA: Point,
  bodyB: Body,
  pointB: Point,
): Joint | null {
  const a = vecToMeters(pointA);
  const b = vecToMeters(pointB);
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const localA = bodyA.getLocalPoint(a);
  const localB = bodyB.getLocalPoint(b);
  return world.createJoint(
    new WeldJoint(
      {
        collideConnected: true,
        frequencyHz: 0,
        userData: { kind: "weld", localA, localB } satisfies JointUserData,
      },
      bodyA,
      bodyB,
      midpoint,
    ),
  );
}

/**
 * Wheel: first click is the chassis, second is the hub. The wheel can spin and slide along
 * the line from the first click to the second (suspension). If the clicks coincide, the axis
 * is straight up on the canvas.
 */
export function createWheel(
  world: World,
  bodyA: Body,
  pointA: Point,
  bodyB: Body,
  pointB: Point,
): Joint | null {
  const a = vecToMeters(pointA);
  const b = vecToMeters(pointB);
  let axis = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(axis.x, axis.y);
  if (len < 1e-4) {
    axis = { x: 0, y: -1 };
  } else {
    axis = { x: axis.x / len, y: axis.y / len };
  }
  return world.createJoint(
    new WheelJoint(
      {
        collideConnected: false,
        frequencyHz: 4,
        dampingRatio: 0.7,
        userData: {
          kind: "wheel",
          localA: bodyA.getLocalPoint(a),
          localB: bodyB.getLocalPoint(b),
        } satisfies JointUserData,
      },
      bodyA,
      bodyB,
      b,
      axis,
    ),
  );
}
