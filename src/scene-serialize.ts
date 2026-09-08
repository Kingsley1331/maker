import type { Body, BodyType, Joint, World } from "planck";
import { buildJoint, isSceneJoint, jointBlueprint, type JointBlueprint } from "./scene-edit";
import {
  applyFixtureSpecs,
  cloneBodyData,
  fixtureSpecs,
  getBodyData,
  isPickable,
  type BodyUserData,
  type FixtureJson,
} from "./shapes";
import type { Point } from "./units";

export const SCENE_FORMAT_VERSION = 1;

/** Global toolbar / view settings captured with a scene. */
export interface SceneSettings {
  /** Gravity in toolbar units (the slider values, not m/s^2). */
  gravityX: number;
  gravityY: number;
  elasticity: number;
  airDrag: number;
  friction: number;
  background: string;
  zoom: number;
  /** View offset in screen pixels. */
  pan: Point;
}

export interface SerializedBody {
  type: BodyType;
  position: Point;
  angle: number;
  linearVelocity: Point;
  angularVelocity: number;
  linearDamping: number;
  angularDamping: number;
  /** Present for dynamic bodies so spray mass overrides survive a reload. */
  massData?: { mass: number; center: Point; I: number };
  userData: BodyUserData;
  fixtures: FixtureJson[];
}

/** Index into `SavedScene.bodies`, or the world ground body. */
export type BodyRef = number | "ground";

export interface SerializedJoint extends JointBlueprint {
  bodyA: BodyRef;
  bodyB: BodyRef;
}

export interface SavedScene {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Data URL of a small preview image. */
  thumbnail: string;
  version: typeof SCENE_FORMAT_VERSION;
  settings: SceneSettings;
  bodies: SerializedBody[];
  joints: SerializedJoint[];
}

/** Lightweight record for the Scenes tab; omits the scene content. */
export type SceneSummary = Pick<SavedScene, "id" | "name" | "createdAt" | "updatedAt" | "thumbnail">;

export interface SceneContent {
  bodies: SerializedBody[];
  joints: SerializedJoint[];
}

function pickableBodies(world: World): Body[] {
  const bodies: Body[] = [];
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (isPickable(body)) bodies.push(body);
  }
  // Planck prepends new bodies to its list; reverse so creation order is preserved.
  return bodies.reverse();
}

function sceneJoints(world: World): Joint[] {
  const joints: Joint[] = [];
  for (let joint: Joint | null = world.getJointList(); joint; joint = joint.getNext() as Joint | null) {
    if (isSceneJoint(joint)) joints.push(joint);
  }
  return joints.reverse();
}

function serializeBody(body: Body): SerializedBody {
  const pos = body.getPosition();
  const vel = body.getLinearVelocity();
  const out: SerializedBody = {
    type: body.getType(),
    position: { x: pos.x, y: pos.y },
    angle: body.getAngle(),
    linearVelocity: { x: vel.x, y: vel.y },
    angularVelocity: body.getAngularVelocity(),
    linearDamping: body.getLinearDamping(),
    angularDamping: body.getAngularDamping(),
    userData: cloneBodyData(getBodyData(body)),
    fixtures: fixtureSpecs(body, 1),
  };
  if (body.getType() === "dynamic") {
    const massData = { mass: 0, center: { x: 0, y: 0 }, I: 0 };
    body.getMassData(massData);
    out.massData = {
      mass: massData.mass,
      center: { x: massData.center.x, y: massData.center.y },
      I: massData.I,
    };
  }
  return out;
}

/** Capture every user body and scene joint as plain JSON. Walls and ground are not included. */
export function serializeScene(world: World, ground: Body): SceneContent {
  const bodies = pickableBodies(world);
  const index = new Map<Body, number>();
  bodies.forEach((body, i) => index.set(body, i));

  const ref = (body: Body): BodyRef | null => {
    if (body === ground) return "ground";
    const i = index.get(body);
    return i === undefined ? null : i;
  };

  const joints: SerializedJoint[] = [];
  for (const joint of sceneJoints(world)) {
    const bp = jointBlueprint(joint);
    if (!bp) continue;
    const a = ref(joint.getBodyA());
    const b = ref(joint.getBodyB());
    if (a === null || b === null) continue;
    joints.push({ ...bp, bodyA: a, bodyB: b });
  }

  return { bodies: bodies.map(serializeBody), joints };
}

/** Destroy every user body and scene joint, leaving walls and ground intact. */
export function clearScene(world: World): void {
  for (const joint of sceneJoints(world)) world.destroyJoint(joint);
  for (const body of pickableBodies(world)) world.destroyBody(body);
}

function deserializeBody(world: World, data: SerializedBody): Body {
  const body = world.createBody({
    type: data.type,
    position: data.position,
    angle: data.angle,
    linearDamping: data.linearDamping,
    angularDamping: data.angularDamping,
    userData: cloneBodyData(data.userData),
  });
  applyFixtureSpecs(body, data.fixtures);
  if (data.type === "dynamic" && data.massData) {
    body.setMassData({
      mass: data.massData.mass,
      center: { x: data.massData.center.x, y: data.massData.center.y },
      I: data.massData.I,
    });
  }
  body.setLinearVelocity(data.linearVelocity);
  body.setAngularVelocity(data.angularVelocity);
  body.synchronizeFixtures();
  body.setAwake(true);
  return body;
}

/** Replace the current scene content with `content`. Returns the created bodies in order. */
export function deserializeScene(world: World, ground: Body, content: SceneContent): Body[] {
  clearScene(world);

  const bodies = content.bodies.map((data) => deserializeBody(world, data));
  const resolve = (ref: BodyRef): Body | null => {
    if (ref === "ground") return ground;
    return bodies[ref] ?? null;
  };

  for (const joint of content.joints) {
    const a = resolve(joint.bodyA);
    const b = resolve(joint.bodyB);
    if (!a || !b) continue;
    buildJoint(world, ground, joint, a, b);
  }
  return bodies;
}
