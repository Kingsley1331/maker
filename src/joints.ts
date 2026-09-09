import {
  DistanceJoint,
  PrismaticJoint,
  RevoluteJoint,
  WeldJoint,
  WheelJoint,
  type Body,
  type Joint,
  type World,
} from "planck";
import { isPickable, type JointUserData } from "./shapes";
import { toMeters, toPixels, vecToMeters, vecToPixels, type Point } from "./units";

export type JointType = "pin" | "revolute" | "rod" | "weld" | "wheel" | "prismatic";
export type MotorJointType = "pin" | "revolute" | "wheel" | "prismatic";

export const JOINT_TYPES: JointType[] = ["pin", "revolute", "rod", "weld", "wheel", "prismatic"];

/** Click radius around a drawn motor pivot, in pixels. */
export const MOTOR_JOINT_HIT_PX = 10;

export type JointEnd = "a" | "b";

export function isMotorJoint(kind: string): kind is MotorJointType {
  return kind === "pin" || kind === "revolute" || kind === "wheel" || kind === "prismatic";
}

export function jointKindLabel(kind: JointUserData["kind"]): string {
  if (kind === "pin") return "Pin";
  if (kind === "revolute") return "Revolute";
  if (kind === "rod") return "Rod";
  if (kind === "weld") return "Weld";
  if (kind === "wheel") return "Wheel";
  return "Slider";
}

export function motorJointLabel(kind: MotorJointType): string {
  return jointKindLabel(kind);
}

type MotorJoint = RevoluteJoint | WheelJoint | PrismaticJoint;

interface AnchoredJoint extends Joint {
  m_localAnchorA: { x: number; y: number };
  m_localAnchorB: { x: number; y: number };
  m_localXAxisA?: { x: number; y: number };
  m_localYAxisA?: { x: number; y: number };
}

function asAnchored(joint: Joint): AnchoredJoint | null {
  const j = joint as AnchoredJoint;
  if (!j.m_localAnchorA || !j.m_localAnchorB) return null;
  return j;
}

function isBarKind(kind: JointUserData["kind"]): boolean {
  return kind === "rod" || kind === "weld" || kind === "wheel" || kind === "prismatic";
}

function isHubKind(kind: JointUserData["kind"]): boolean {
  return kind === "pin" || kind === "revolute";
}

function asMotorJoint(joint: Joint): MotorJoint | null {
  const type = joint.getType();
  if (type === RevoluteJoint.TYPE || type === WheelJoint.TYPE || type === PrismaticJoint.TYPE) {
    return joint as MotorJoint;
  }
  return null;
}

function isPrismatic(joint: Joint): joint is PrismaticJoint {
  return joint.getType() === PrismaticJoint.TYPE;
}

/** Drawn ends of a scene joint, in pixels. Pin / revolute use the same hub for both. */
export function jointDrawEndsPx(joint: Joint): { a: Point; b: Point } | null {
  const data = joint.getUserData() as JointUserData | undefined;
  if (!data?.kind) return null;
  if (data.localA && data.localB) {
    return {
      a: vecToPixels(joint.getBodyA().getWorldPoint(data.localA)),
      b: vecToPixels(joint.getBodyB().getWorldPoint(data.localB)),
    };
  }
  const a = joint.getAnchorA();
  const b = joint.getAnchorB();
  return {
    a: { x: toPixels(a.x), y: toPixels(a.y) },
    b: { x: toPixels(b.x), y: toPixels(b.y) },
  };
}

/** Drawn pivot of a pin / revolute / wheel / slider, in pixels. */
export function jointPivotPx(joint: Joint): Point | null {
  const ends = jointDrawEndsPx(joint);
  if (!ends) return null;
  const data = joint.getUserData() as JointUserData | undefined;
  if (data && isHubKind(data.kind)) return ends.b;
  if (data && (data.kind === "wheel" || data.kind === "prismatic")) return ends.b;
  return ends.b;
}

function distToSegmentPx(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/**
 * Distance in pixels from `point` to the selectable drawing of a scene joint, or null if the
 * joint cannot be selected. Bar joints use the whole rail; pin / revolute use the hub.
 */
export function jointSelectDistPx(joint: Joint, point: Point): number | null {
  const data = joint.getUserData() as JointUserData | undefined;
  const ends = jointDrawEndsPx(joint);
  if (!data?.kind || !ends) return null;
  if (isBarKind(data.kind)) return distToSegmentPx(point, ends.a, ends.b);
  return Math.hypot(point.x - ends.b.x, point.y - ends.b.y);
}

/**
 * Which drawn end is under `point` within `maxDistPx`, or null. Pin / revolute always report
 * `'b'` (the member hub). Prefer the nearer end when both hit.
 */
export function jointEndHit(joint: Joint, point: Point, maxDistPx: number): JointEnd | null {
  const data = joint.getUserData() as JointUserData | undefined;
  const ends = jointDrawEndsPx(joint);
  if (!data?.kind || !ends) return null;
  const da = Math.hypot(point.x - ends.a.x, point.y - ends.a.y);
  const db = Math.hypot(point.x - ends.b.x, point.y - ends.b.y);
  if (isHubKind(data.kind)) return db <= maxDistPx ? "b" : null;
  const aHit = da <= maxDistPx;
  const bHit = db <= maxDistPx;
  if (aHit && bHit) return da <= db ? "a" : "b";
  if (aHit) return "a";
  if (bHit) return "b";
  return null;
}

function writeLocalAnchor(anchor: { x: number; y: number }, body: Body, worldPx: Point): Point {
  const local = body.getLocalPoint(vecToMeters(worldPx));
  anchor.x = local.x;
  anchor.y = local.y;
  return { x: local.x, y: local.y };
}

function setDrawAxis(joint: AnchoredJoint): void {
  const data = joint.getUserData() as JointUserData | undefined;
  if (!data?.localA || !data.localB || !joint.m_localXAxisA) return;
  const wa = joint.getBodyA().getWorldPoint(data.localA);
  const wb = joint.getBodyB().getWorldPoint(data.localB);
  const worldAxis = axisBetween(wa, wb);
  const local = joint.getBodyA().getLocalVector(worldAxis);
  joint.m_localXAxisA.x = local.x;
  joint.m_localXAxisA.y = local.y;
  if (joint.m_localYAxisA) {
    joint.m_localYAxisA.x = -local.y;
    joint.m_localYAxisA.y = local.x;
  }
}

/**
 * Move a drawn joint end to `worldPx` (pixels), staying on that end's own body. `hitBody` is
 * the pickable shape under the pointer (or null). Returns false if the move was ignored.
 */
export function setJointEnd(
  joint: Joint,
  end: JointEnd,
  worldPx: Point,
  hitBody: Body | null,
): boolean {
  const data = joint.getUserData() as JointUserData | undefined;
  const anchored = asAnchored(joint);
  if (!data?.kind || !anchored) return false;
  const bodyA = joint.getBodyA();
  const bodyB = joint.getBodyB();

  if (isHubKind(data.kind)) {
    const allowed =
      data.kind === "pin" ? hitBody === bodyB : hitBody === bodyA || hitBody === bodyB;
    if (!allowed) return false;
    const localA = writeLocalAnchor(anchored.m_localAnchorA, bodyA, worldPx);
    const localB = writeLocalAnchor(anchored.m_localAnchorB, bodyB, worldPx);
    if (data.localA) data.localA = localA;
    if (data.localB) data.localB = localB;
    bodyA.setAwake(true);
    bodyB.setAwake(true);
    return true;
  }

  const body = end === "a" ? bodyA : bodyB;
  if (isPickable(body) && hitBody !== body) return false;

  if (data.kind === "wheel" || data.kind === "prismatic") {
    const local = body.getLocalPoint(vecToMeters(worldPx));
    if (end === "a") {
      data.localA = { x: local.x, y: local.y };
    } else {
      data.localB = { x: local.x, y: local.y };
      writeLocalAnchor(anchored.m_localAnchorA, bodyA, worldPx);
      writeLocalAnchor(anchored.m_localAnchorB, bodyB, worldPx);
    }
    setDrawAxis(anchored);
    bodyA.setAwake(true);
    bodyB.setAwake(true);
    return true;
  }

  const local = writeLocalAnchor(
    end === "a" ? anchored.m_localAnchorA : anchored.m_localAnchorB,
    body,
    worldPx,
  );
  if (end === "a" && data.localA) data.localA = { x: local.x, y: local.y };
  if (end === "b" && data.localB) data.localB = { x: local.x, y: local.y };

  if (data.kind === "rod") {
    const wa = bodyA.getWorldPoint(anchored.m_localAnchorA);
    const wb = bodyB.getWorldPoint(anchored.m_localAnchorB);
    (joint as DistanceJoint).setLength(Math.hypot(wb.x - wa.x, wb.y - wa.y));
  }

  bodyA.setAwake(true);
  bodyB.setAwake(true);
  return true;
}

/** Current motor speed (rad/s, or m/s for a slider), or 0 if the motor is off. */
export function getMotorSpeed(joint: Joint): number {
  const motor = asMotorJoint(joint);
  if (!motor || !motor.isMotorEnabled()) return 0;
  return motor.getMotorSpeed();
}

/**
 * Drive a pin / revolute / wheel / slider. Speed 0 turns the motor off; otherwise the joint
 * spins at that angular velocity (or slides at that linear velocity). Negative reverses.
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
  if (isPrismatic(motor)) {
    motor.setMaxMotorForce(1000 * mass);
  } else {
    motor.setMaxMotorTorque(1000 * mass);
  }
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

/** Slider travel (pixels) at which the limit is treated as "off". */
export const FULL_TRAVEL_PX = 400;

/** Only sliders (prismatic) can have their linear travel limited. */
export function hasTravelLimit(joint: Joint): joint is PrismaticJoint {
  return isPrismatic(joint);
}

/** Allowed travel in pixels, or FULL_TRAVEL_PX when the limit is off. */
export function getTravelRangePx(joint: Joint): number {
  if (!hasTravelLimit(joint) || !joint.isLimitEnabled()) return FULL_TRAVEL_PX;
  return Math.round(toPixels(joint.getUpperLimit() - joint.getLowerLimit()));
}

/**
 * Limit how far the slider can travel, centred on its current position. FULL_TRAVEL_PX (or
 * more) removes the limit; 0 locks the slider where it is.
 */
export function setTravelRange(joint: Joint, px: number): void {
  if (!hasTravelLimit(joint)) return;
  if (px >= FULL_TRAVEL_PX) {
    joint.enableLimit(false);
    return;
  }
  const half = toMeters(Math.max(0, px)) / 2;
  const translation = joint.getJointTranslation();
  joint.setLimits(translation - half, translation + half);
  joint.enableLimit(true);
}

/**
 * World segment (pixels) that the slider anchor can travel along, or null when the limit is
 * off. Used to draw the allowed travel.
 */
export function getTravelLimitSegment(joint: Joint): { from: Point; to: Point } | null {
  if (!hasTravelLimit(joint) || !joint.isLimitEnabled()) return null;
  const anchor = joint.getAnchorB();
  const axis = joint.getBodyA().getWorldVector(joint.getLocalAxisA());
  const translation = joint.getJointTranslation();
  const lower = joint.getLowerLimit() - translation;
  const upper = joint.getUpperLimit() - translation;
  return {
    from: vecToPixels({ x: anchor.x + axis.x * lower, y: anchor.y + axis.y * lower }),
    to: vecToPixels({ x: anchor.x + axis.x * upper, y: anchor.y + axis.y * upper }),
  };
}

/** Set the joint's range: degrees for a pin / revolute, pixels of travel for a slider. */
export function setJointRange(joint: Joint, value: number): void {
  if (hasTravelLimit(joint)) setTravelRange(joint, value);
  else setAngleRange(joint, value);
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

/** Unit axis from `a` to `b` (metres); straight up on the canvas when the points coincide. */
function axisBetween(a: Point, b: Point): Point {
  const axis = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(axis.x, axis.y);
  if (len < 1e-4) return { x: 0, y: -1 };
  return { x: axis.x / len, y: axis.y / len };
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
  const axis = axisBetween(a, b);
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

/**
 * Slider (prismatic): first click is the rail body, second is the slider. The slider can only
 * move along the line from the first click to the second and cannot rotate relative to the
 * rail. If the clicks coincide, the axis is straight up on the canvas. Neither body is moved.
 * `worldAxis` (metres, unit) overrides the click-derived axis when rebuilding a saved joint.
 * `collideConnected` defaults to true so the two shapes bump into each other.
 */
export function createPrismatic(
  world: World,
  bodyA: Body,
  pointA: Point,
  bodyB: Body,
  pointB: Point,
  worldAxis?: Point,
  collideConnected = true,
): Joint | null {
  const a = vecToMeters(pointA);
  const b = vecToMeters(pointB);
  const axis = worldAxis ?? axisBetween(a, b);
  return world.createJoint(
    new PrismaticJoint(
      {
        collideConnected,
        userData: {
          kind: "prismatic",
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
