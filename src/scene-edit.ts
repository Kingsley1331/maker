import {
  DistanceJoint,
  MouseJoint,
  RevoluteJoint,
  type Body,
  type Joint,
  type World,
} from "planck";
import { groupJoints } from "./group";
import {
  createPin,
  createRod,
  createWeld,
  createWheel,
  getAngleRangeDeg,
  getMotorSpeed,
  hasAngleLimit,
  setAngleRange,
  setJointMotor,
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

function isSceneJoint(joint: Joint): boolean {
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

function copyJointMotorState(from: Joint, to: Joint): void {
  const speed = getMotorSpeed(from);
  if (speed !== 0) setJointMotor(to, speed);
  if (hasAngleLimit(from) && hasAngleLimit(to)) {
    setAngleRange(to, getAngleRangeDeg(from));
  }
}

function cloneJoint(
  world: World,
  ground: Body,
  joint: Joint,
  bodyMap: Map<Body, Body>,
): Joint | null {
  const anchors = jointAnchors(joint);
  if (!anchors) return null;

  const data = joint.getUserData() as JointUserData | undefined;
  const kind = data?.kind;
  const oldA = joint.getBodyA();
  const oldB = joint.getBodyB();
  const newA = mapBody(oldA, bodyMap, ground);
  const newB = mapBody(oldB, bodyMap, ground);

  const localA = { x: anchors.m_localAnchorA.x, y: anchors.m_localAnchorA.y };
  const localB = { x: anchors.m_localAnchorB.x, y: anchors.m_localAnchorB.y };
  const pointA = vecToPixels(newA.getWorldPoint(localA));
  const pointB = vecToPixels(newB.getWorldPoint(localB));

  if (kind === "pin" || (kind === undefined && (isGround(oldA) || isGround(oldB)))) {
    const member = isGround(oldA) ? newB : newA;
    const pt = isGround(oldA) ? pointB : pointA;
    const created = createPin(world, ground, member, pt);
    if (created) copyJointMotorState(joint, created);
    return created;
  }

  if (kind === "revolute" || joint.getType() === RevoluteJoint.TYPE) {
    const created = world.createJoint(
      new RevoluteJoint(
        { collideConnected: false, userData: { kind: "revolute" } satisfies JointUserData },
        newA,
        newB,
        newA.getWorldPoint(localA),
      ),
    );
    if (created) copyJointMotorState(joint, created);
    return created;
  }

  if (kind === "rod" || joint.getType() === DistanceJoint.TYPE) {
    const created = createRod(world, newA, pointA, newB, pointB);
    if (created && joint.getType() === DistanceJoint.TYPE) {
      (created as DistanceJoint).setLength((joint as DistanceJoint).getLength());
    }
    return created;
  }

  if (kind === "weld" && data?.localA && data?.localB) {
    return createWeld(
      world,
      newA,
      vecToPixels(newA.getWorldPoint(data.localA)),
      newB,
      vecToPixels(newB.getWorldPoint(data.localB)),
    );
  }

  if (kind === "wheel" && data?.localA && data?.localB) {
    const created = createWheel(
      world,
      newA,
      vecToPixels(newA.getWorldPoint(data.localA)),
      newB,
      vecToPixels(newB.getWorldPoint(data.localB)),
    );
    if (created) copyJointMotorState(joint, created);
    return created;
  }

  return null;
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
