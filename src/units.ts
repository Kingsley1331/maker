/** Pixels per meter. Keeps typical sandbox shapes in Box2D’s 0.1–10 m range. */
export const SCALE = 40;

/**
 * UI gravity 1.00 maps to Matter’s default ~1000 px/s².
 * In meters: 1000 / SCALE.
 */
export const GRAVITY_SCALE = 1000 / SCALE;

/** Matter used density 0.001 in pixel units; this keeps mass numbers in a similar range. */
export const DENSITY = 0.001 * SCALE * SCALE;

export const RESTITUTION = 0.4;
export const FRICTION = 0.3;
/** Stand-in for Matter’s frictionAir (0.01). Higher values bleed speed between bounces. */
export const LINEAR_DAMPING = 0.01;
export const ANGULAR_DAMPING = 0.01;

export type Point = { x: number; y: number };

export function toMeters(px: number): number {
  return px / SCALE;
}

export function toPixels(m: number): number {
  return m * SCALE;
}

export function vecToMeters(p: Point): Point {
  return { x: toMeters(p.x), y: toMeters(p.y) };
}

export function vecToPixels(p: Point): Point {
  return { x: toPixels(p.x), y: toPixels(p.y) };
}
