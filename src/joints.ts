import { Constraint, type Body } from "matter-js";
import type { Point } from "./shapes";

export type JointType = "pin" | "revolute" | "rod";

export const JOINT_TYPES: JointType[] = ["pin", "revolute", "rod"];

const ACCENT = "#3b6fe0";

function localOffset(body: Body, world: Point): { x: number; y: number } {
  return { x: world.x - body.position.x, y: world.y - body.position.y };
}

/** Pin a body to the world at `world`. The body can still rotate around that point. */
export function createPin(body: Body, world: Point): Constraint {
  return Constraint.create({
    pointA: { x: world.x, y: world.y },
    bodyB: body,
    pointB: localOffset(body, world),
    length: 0,
    stiffness: 0.7,
    label: "Pin",
    render: {
      strokeStyle: ACCENT,
      type: "pin",
      anchors: false,
    },
  });
}

/** Hinge two bodies together so the given world points become coincident. */
export function createRevolute(bodyA: Body, pointA: Point, bodyB: Body, pointB: Point): Constraint {
  return Constraint.create({
    bodyA,
    bodyB,
    pointA: localOffset(bodyA, pointA),
    pointB: localOffset(bodyB, pointB),
    length: 0,
    stiffness: 0.7,
    label: "Revolute",
    render: {
      strokeStyle: ACCENT,
      type: "pin",
      anchors: false,
    },
  });
}

/** Rigid bar between two points on two bodies. Length is taken from the initial distance. */
export function createRod(bodyA: Body, pointA: Point, bodyB: Body, pointB: Point): Constraint {
  return Constraint.create({
    bodyA,
    bodyB,
    pointA: localOffset(bodyA, pointA),
    pointB: localOffset(bodyB, pointB),
    stiffness: 1,
    label: "Rod",
    render: {
      strokeStyle: ACCENT,
      type: "line",
      anchors: true,
      lineWidth: 3,
    },
  });
}
