import { DistanceJoint, RevoluteJoint, WeldJoint, WheelJoint, type Body, type Joint, type World } from "planck";
import type { JointUserData } from "./shapes";
import { toPixels, vecToMeters, vecToPixels, type Point } from "./units";

export type JointType = "pin" | "revolute" | "rod" | "weld" | "wheel";
export type MotorJointType = "pin" | "revolute" | "wheel";

export const JOINT_TYPES: JointType[] = ["pin", "revolute", "rod", "weld", "wheel"];

/** Click radius around a drawn motor pivot, in pixels. */
export const MOTOR_JOINT_HIT_PX = 10;

export function isMotorJoint(kind: string): kind is MotorJointType {
  return kind === "pin" || kind === "revolute" || kind === "wheel";
}

export function motorJointLabel(kind: MotorJointType): string {
  if (kind === "pin") return "Pin";
  if (kind === "wheel") return "Wheel";
  return "Revolute";
}

function asMotorJoint(joint: Joint): RevoluteJoint | WheelJoint | null {
  const type = joint.getType();
  if (type === RevoluteJoint.TYPE || type === WheelJoint.TYPE) {
    return joint as RevoluteJoint | WheelJoint;
  }
  return null;
}

/** Drawn pivot of a pin / revolute / wheel, in pixels. */
export function jointPivotPx(joint: Joint): Point | null {
  const data = joint.getUserData() as JointUserData | undefined;
  if (!data || !isMotorJoint(data.kind)) return null;
  if (data.kind === "wheel" && data.localB) {
    return vecToPixels(joint.getBodyB().getWorldPoint(data.localB));
  }
  const b = joint.getAnchorB();
  return { x: toPixels(b.x), y: toPixels(b.y) };
}

/** Current motor speed in rad/s, or 0 if the motor is off. */
export function getMotorSpeed(joint: Joint): number {
  const motor = asMotorJoint(joint);
  if (!motor || !motor.isMotorEnabled()) return 0;
  return motor.getMotorSpeed();
}

/**
 * Drive a pin / revolute / wheel. Speed 0 turns the motor off; otherwise the joint
 * spins at that angular velocity (negative reverses).
 */
export function setJointMotor(joint: Joint, speed: number): void {
  const motor = asMotorJoint(joint);
  if (!motor) return;
  if (speed === 0) {
    motor.enableMotor(false);
    motor.setMotorSpeed(0);
    return;
  }
  const mass = joint.getBodyA().getMass() + joint.getBodyB().getMass();
  motor.setMaxMotorTorque(1000 * mass);
  motor.setMotorSpeed(speed);
  motor.enableMotor(true);
}

/** Full rotation; the slider value that means "no limit". */
export const FULL_RANGE_DEG = 360;

/** Only revolute-type joints (pin, revolute) can have their angular travel limited. */
export function hasAngleLimit(joint: Joint): joint is RevoluteJoint {
  const data = joint.getUserData() as JointUserData | undefined;
  if (data?.kind === "pin" || data?.kind === "revolute") return true;
  return joint.getType() === RevoluteJoint.TYPE;
}

/** Allowed angular range in degrees, or 360 when the limit is off. */
export function getAngleRangeDeg(joint: Joint): number {
  if (!hasAngleLimit(joint) || !joint.isLimitEnabled()) return FULL_RANGE_DEG;
  const span = joint.getUpperLimit() - joint.getLowerLimit();
  return Math.round((span * 180) / Math.PI);
}

/**
 * Limit how far the joint can turn, centred on its current pose. 360 (or more) removes the
 * limit; 0 locks the joint at its current angle.
 */
export function setAngleRange(joint: Joint, degrees: number): void {
  if (!hasAngleLimit(joint)) return;
  if (degrees >= FULL_RANGE_DEG) {
    joint.enableLimit(false);
    return;
  }
  const half = ((Math.max(0, degrees) * Math.PI) / 180) / 2;
  const angle = joint.getJointAngle();
  joint.setLimits(angle - half, angle + half);
  joint.enableLimit(true);
}

/**
 * World-space sweep (radians, canvas orientation) that body B's centre can travel around the
 * pivot, or null when the limit is off. Used to draw the allowed arc.
 */
export function getAngleLimitArc(joint: Joint): { start: number; end: number } | null {
  if (!hasAngleLimit(joint) || !joint.isLimitEnabled()) return null;
  const pivot = joint.getAnchorB();
  const centre = joint.getBodyB().getWorldCenter();
  const dir = Math.atan2(centre.y - pivot.y, centre.x - pivot.x);
  const angle = joint.getJointAngle();
  return {
    start: dir + (joint.getLowerLimit() - angle),
    end: dir + (joint.getUpperLimit() - angle),
  };
}

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
