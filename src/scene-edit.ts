import {
  DistanceJoint,
  MouseJoint,
  PrismaticJoint,
  RevoluteJoint,
  type Body,
  type Joint,
  type World,
} from "planck";
import { groupJoints } from "./group";
import {
  createPin,
  createPrismatic,
  createRod,
  createWeld,
  createWheel,
  getAngleRangeDeg,
  getJointDamping,
  getJointFrequency,
  getMotorSpeed,
  getTravelRangePx,
  hasAngleLimit,
  hasSpring,
  hasTravelLimit,
  setAngleRange,
  setJointDamping,
  setJointFrequency,
  setJointMotor,
  setTravelRange,
} from "./joints";
import { cloneBody, getBodyData, isPickable, type JointUserData } from "./shapes";
import { vecToMeters, vecToPixels, type Point } from "./units";

const DUPLICATE_OFFSET_PX: Point = { x: 24, y: 24 };

interface AnchoredJoint extends Joint {
  m_localAnchorA: { x: number; y: number };
  m_localAnchorB: { x: number; y: number };
}

function jointAnchors(joint: Joint): AnchoredJoint | null {
  const j = joint as AnchoredJoint;
  if (!j.m_localAnchorA || !j.m_localAnchorB) return null;
  return j;
}

function isGround(body: Body): boolean {
  return getBodyData(body)?.kind === "ground";
}

/** Joints that belong to the scene (everything except the temporary drag MouseJoint). */
export function isSceneJoint(joint: Joint): boolean {
  return joint.getType() !== MouseJoint.TYPE;
}

function shouldCloneJoint(joint: Joint, members: Set<Body>, ground: Body): boolean {
  const a = joint.getBodyA();
  const b = joint.getBodyB();
  const aIn = members.has(a);
  const bIn = members.has(b);
  if (aIn && bIn) return true;
  if (a === ground && bIn) return true;
  if (b === ground && aIn) return true;
  return false;
}

function mapBody(body: Body, bodyMap: Map<Body, Body>, ground: Body): Body {
  return bodyMap.get(body) ?? (isGround(body) ? ground : body);
}

/** Everything needed to rebuild a scene joint between two (possibly different) bodies. */
export interface JointBlueprint {
  kind: JointUserData["kind"];
  /** Planck local anchors (metres) on each body. */
  localAnchorA: Point;
  localAnchorB: Point;
  /** Draw anchors for weld / wheel / slider (metres, body-local). */
  localA?: Point;
  localB?: Point;
  /** Motor speed in rad/s (m/s for sliders); 0 means off. */
  motorSpeed: number;
  /** Angle range in degrees, or null when the joint has no limit / limit is off. */
  angleRangeDeg: number | null;
  /** Rest length for rods (metres). */
  length?: number;
  /** Slider axis, unit vector in body A's local frame. */
  axis?: Point;
  /** Slider travel in pixels, or null when the limit is off. */
  travelRangePx?: number | null;
  /** When false, the two slider bodies do not collide. Omitted means they do. */
  collideConnected?: boolean;
  /** Oscillator frequency in Hz for rod / weld; 0 or omitted is rigid. */
  frequencyHz?: number;
  /** Damping ratio for rod / weld (0 = none, 1 = critical). */
  dampingRatio?: number;
}

/** Read a scene joint into a plain blueprint, or null for joints we cannot rebuild. */
export function jointBlueprint(joint: Joint): JointBlueprint | null {
  const anchors = jointAnchors(joint);
  if (!anchors) return null;
  const data = joint.getUserData() as JointUserData | undefined;
  let kind = data?.kind;
  if (kind === undefined) {
    if (joint.getType() === RevoluteJoint.TYPE) {
      kind = isGround(joint.getBodyA()) || isGround(joint.getBodyB()) ? "pin" : "revolute";
    } else if (joint.getType() === DistanceJoint.TYPE) {
      kind = "rod";
    } else if (joint.getType() === PrismaticJoint.TYPE) {
      kind = "prismatic";
    } else {
      return null;
    }
  }

  const blueprint: JointBlueprint = {
    kind,
    localAnchorA: { x: anchors.m_localAnchorA.x, y: anchors.m_localAnchorA.y },
    localAnchorB: { x: anchors.m_localAnchorB.x, y: anchors.m_localAnchorB.y },
    motorSpeed: getMotorSpeed(joint),
    angleRangeDeg: hasAngleLimit(joint) && joint.isLimitEnabled() ? getAngleRangeDeg(joint) : null,
  };
  if (data?.localA) blueprint.localA = { x: data.localA.x, y: data.localA.y };
  if (data?.localB) blueprint.localB = { x: data.localB.x, y: data.localB.y };
  if (joint.getType() === DistanceJoint.TYPE) {
    blueprint.length = (joint as DistanceJoint).getLength();
  }
  if (hasTravelLimit(joint)) {
    const axis = joint.getLocalAxisA();
    blueprint.axis = { x: axis.x, y: axis.y };
    blueprint.travelRangePx = joint.isLimitEnabled() ? getTravelRangePx(joint) : null;
    blueprint.collideConnected = joint.getCollideConnected();
  }
  if (hasSpring(joint)) {
    blueprint.frequencyHz = getJointFrequency(joint);
    blueprint.dampingRatio = getJointDamping(joint);
  }
  return blueprint;
}

/**
 * Create a joint from a blueprint between `a` and `b` (either may be `ground`), applying
 * motor speed and angle limits. Returns null when the blueprint is incomplete.
 */
export function buildJoint(
  world: World,
  ground: Body,
  bp: JointBlueprint,
  a: Body,
  b: Body,
): Joint | null {
  const pointA = vecToPixels(a.getWorldPoint(bp.localAnchorA));
  const pointB = vecToPixels(b.getWorldPoint(bp.localAnchorB));

  let created: Joint | null = null;
  if (bp.kind === "pin") {
    const member = a === ground ? b : a;
    const pt = a === ground ? pointB : pointA;
    created = createPin(world, ground, member, pt);
  } else if (bp.kind === "revolute") {
    created = world.createJoint(
      new RevoluteJoint(
        { collideConnected: false, userData: { kind: "revolute" } satisfies JointUserData },
        a,
        b,
        a.getWorldPoint(bp.localAnchorA),
      ),
    );
  } else if (bp.kind === "rod") {
    created = createRod(world, a, pointA, b, pointB);
    if (created && bp.length !== undefined) {
      (created as DistanceJoint).setLength(bp.length);
    }
  } else if (bp.kind === "weld" && bp.localA && bp.localB) {
    created = createWeld(
      world,
      a,
      vecToPixels(a.getWorldPoint(bp.localA)),
      b,
      vecToPixels(b.getWorldPoint(bp.localB)),
    );
  } else if (bp.kind === "wheel" && bp.localA && bp.localB) {
    created = createWheel(
      world,
      a,
      vecToPixels(a.getWorldPoint(bp.localA)),
      b,
      vecToPixels(b.getWorldPoint(bp.localB)),
    );
  } else if (bp.kind === "prismatic" && bp.localA && bp.localB) {
    created = createPrismatic(
      world,
      a,
      vecToPixels(a.getWorldPoint(bp.localA)),
      b,
      vecToPixels(b.getWorldPoint(bp.localB)),
      bp.axis ? a.getWorldVector(bp.axis) : undefined,
      bp.collideConnected !== false,
    );
  }

  if (!created) return null;
  if (bp.motorSpeed !== 0) setJointMotor(created, bp.motorSpeed);
  if (bp.angleRangeDeg !== null && hasAngleLimit(created)) {
    setAngleRange(created, bp.angleRangeDeg);
  }
  if (bp.travelRangePx != null && hasTravelLimit(created)) {
    setTravelRange(created, bp.travelRangePx);
  }
  if (hasSpring(created)) {
    if (bp.frequencyHz !== undefined) setJointFrequency(created, bp.frequencyHz);
    if (bp.dampingRatio !== undefined) setJointDamping(created, bp.dampingRatio);
  }
  return created;
}

/**
 * Planck only honours collideConnected at creation, so this destroys the slider and rebuilds
 * it with the new flag. Returns the (possibly new) joint, or null if the slider could not be
 * restored.
 */
export function setPrismaticCollide(
  world: World,
  ground: Body,
  joint: Joint,
  collide: boolean,
): Joint | null {
  if (!hasTravelLimit(joint)) return joint;
  if (joint.getCollideConnected() === collide) return joint;
  const bp = jointBlueprint(joint);
  if (!bp) return joint;
  const a = joint.getBodyA();
  const b = joint.getBodyB();
  world.destroyJoint(joint);
  const created = buildJoint(world, ground, { ...bp, collideConnected: collide }, a, b);
  const restored = created ?? buildJoint(world, ground, bp, a, b);
  // Overlapping AABBs are not re-paired unless a proxy moves; refilter so Collide on/off
  // takes effect without shoving the bodies.
  refilterBody(a);
  refilterBody(b);
  a.setAwake(true);
  b.setAwake(true);
  return restored;
}

function refilterBody(body: Body): void {
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    f.refilter();
  }
}

function cloneJoint(
  world: World,
  ground: Body,
  joint: Joint,
  bodyMap: Map<Body, Body>,
): Joint | null {
  const bp = jointBlueprint(joint);
  if (!bp) return null;
  const newA = mapBody(joint.getBodyA(), bodyMap, ground);
  const newB = mapBody(joint.getBodyB(), bodyMap, ground);
  return buildJoint(world, ground, bp, newA, newB);
}

/** Remove a selected joint, or every member body and its scene joints. */
export function deleteSelection(
  world: World,
  members: readonly Body[],
  selectedJoint: Joint | null,
): void {
  if (selectedJoint) {
    world.destroyJoint(selectedJoint);
    return;
  }

  const toRemove = members.filter(isPickable);
  if (toRemove.length === 0) return;

  const memberSet = new Set(toRemove);
  for (const joint of groupJoints(toRemove)) {
    if (!isSceneJoint(joint)) continue;
    const a = joint.getBodyA();
    const b = joint.getBodyB();
    if (memberSet.has(a) || memberSet.has(b)) {
      world.destroyJoint(joint);
    }
  }
  for (const body of toRemove) {
    world.destroyBody(body);
  }
}

export interface DuplicateResult {
  members: Body[];
  /** The clone of the primary selected body, when it was part of the duplicate set. */
  primary: Body | null;
}

/** Duplicate selected members and internal (or ground-pin) joints, offset slightly. */
export function duplicateSelection(
  world: World,
  ground: Body,
  members: readonly Body[],
  primary: Body | null,
  offsetPx: Point = DUPLICATE_OFFSET_PX,
): DuplicateResult {
  const sources = members.filter(isPickable);
  if (sources.length === 0) return { members: [], primary: null };

  const offsetM = vecToMeters(offsetPx);
  const bodyMap = new Map<Body, Body>();
  for (const body of sources) {
    bodyMap.set(body, cloneBody(world, body, offsetM));
  }

  const memberSet = new Set(sources);
  for (const joint of groupJoints(sources)) {
    if (!isSceneJoint(joint) || !shouldCloneJoint(joint, memberSet, ground)) continue;
    cloneJoint(world, ground, joint, bodyMap);
  }

  const clones = [...bodyMap.values()];
  return {
    members: clones,
    primary: primary && bodyMap.has(primary) ? (bodyMap.get(primary) as Body) : clones[0] ?? null,
  };
}
