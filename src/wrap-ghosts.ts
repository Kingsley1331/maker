import type { Body, Contact, Fixture, MassData, Shape, World } from "planck";
import { bodyBoundsPx } from "./physics";
import { getBodyData, isPickable, type BodyUserData } from "./shapes";
import { toMeters, toPixels, type Point } from "./units";

/**
 * Seam collisions for wrap mode.
 *
 * The world is flat; wrapping only redraws shapes at canvas offsets. So that the part of a shape
 * poking past one edge can actually hit what sits at the opposite edge, every shape near a seam
 * gets an invisible mirror body (a "ghost") one canvas away with the same fixtures. Ghosts collide
 * with real shapes; after each step the velocity change and penetration correction a ghost picked
 * up are copied back onto its real body.
 *
 * Only the four "positive" neighbour offsets are mirrored. A pair (A, B) meets across offset `o`
 * through `A vs ghost(B, o)` and across `-o` through `ghost(A, o) vs B`, so each seam contact is
 * counted exactly once. Ghost-ghost pairs are rejected by fixture filters. A shape longer than the
 * canvas meets its own ghost, so it collides with itself across the seam.
 */

/** Ghost fixtures collide with real shapes (category 1) only. */
const GHOST_CATEGORY = 0x0002;
const GHOST_MASK = 0x0001;

/** Neighbour tiles mirrored, as multiples of the canvas size. */
const TILES: Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
];

interface Ghost {
  body: Body;
  tile: Point;
  /** Shapes the ghost's fixtures were cloned from, to detect rebuilt originals. */
  shapes: Shape[];
  /** World offset (metres) applied at the last sync. */
  offset: Point;
  /** Pose and velocity copied from the original at the last sync. */
  start: { x: number; y: number; angle: number };
  v: { x: number; y: number };
  w: number;
}

export interface WrapGhosts {
  /** Before a step: create / drop ghosts as needed and mirror pose, velocity and material. */
  sync(sizePx: { w: number; h: number }): void;
  /** After a step of `dt` seconds: feed ghost contact responses back to the real bodies. */
  apply(dt: number): void;
  /** Remove every ghost (wrap turned off). */
  clear(): void;
}

/** Slack (px) added around a shifted body when deciding whether its ghost could reach anything. */
const REACH_PX = 40;
/** Seam speed (m/s) below which a shape's contact with its own copy is ignored (~2 px/s). */
const SELF_CONTACT_MIN_SPEED = toMeters(2);

/** Does box `a`, shifted by `shift` and grown by `pad`, overlap box `b`? */
function overlaps(
  a: { min: Point; max: Point },
  shift: Point,
  pad: number,
  b: { min: Point; max: Point },
): boolean {
  return (
    a.min.x + shift.x - pad <= b.max.x &&
    a.max.x + shift.x + pad >= b.min.x &&
    a.min.y + shift.y - pad <= b.max.y &&
    a.max.y + shift.y + pad >= b.min.y
  );
}

/** Reach slack for a body: fixed margin plus the distance it covers in a frame. */
function reachPx(body: Body): number {
  const v = body.getLinearVelocity();
  return REACH_PX + toPixels(Math.hypot(v.x, v.y)) / 60;
}

function fixtureShapes(body: Body): Shape[] {
  const out: Shape[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) out.push(f.getShape());
  return out;
}

function sameShapes(a: Shape[], b: Shape[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createWrapGhosts(world: World): WrapGhosts {
  const ghosts = new Map<Body, Map<number, Ghost>>();
  const originalOf = new WeakMap<Body, Body>();
  const ghostOf = new WeakMap<Body, Ghost>();

  function copyFixtures(from: Body, to: Body): Shape[] {
    const shapes: Shape[] = [];
    for (let f: Fixture | null = from.getFixtureList(); f; f = f.getNext()) {
      to.createFixture({
        shape: f.getShape(),
        density: f.getDensity(),
        friction: f.getFriction(),
        restitution: f.getRestitution(),
        isSensor: f.isSensor(),
        filterCategoryBits: GHOST_CATEGORY,
        filterMaskBits: GHOST_MASK,
      });
      shapes.push(f.getShape());
    }
    return shapes;
  }

  function copyMass(from: Body, to: Body): void {
    if (from.getType() !== "dynamic") return;
    const md: MassData = { mass: 0, center: { x: 0, y: 0 }, I: 0 };
    from.getMassData(md);
    to.setMassData(md);
  }

  function makeGhost(original: Body, tile: Point): Ghost {
    const p = original.getPosition();
    const data = getBodyData(original);
    const body = world.createBody({
      type: original.getType(),
      position: { x: p.x, y: p.y },
      angle: original.getAngle(),
      // No gravity or damping: the ghost's velocity change over a step is then purely what its
      // contacts did to it, which is exactly what gets copied back to the original.
      gravityScale: 0,
      linearDamping: 0,
      angularDamping: 0,
      allowSleep: false,
      fixedRotation: original.isFixedRotation(),
      userData: {
        kind: "ghost",
        label: `${data?.label ?? "Body"} (wrap copy)`,
        fillStyle: "transparent",
      } satisfies BodyUserData,
    });
    const shapes = copyFixtures(original, body);
    copyMass(original, body);
    originalOf.set(body, original);
    const ghost: Ghost = {
      body,
      tile,
      shapes,
      offset: { x: 0, y: 0 },
      start: { x: p.x, y: p.y, angle: original.getAngle() },
      v: { x: 0, y: 0 },
      w: 0,
    };
    ghostOf.set(body, ghost);
    return ghost;
  }

  function rebuildFixtures(ghost: Ghost, original: Body): void {
    const old: Fixture[] = [];
    for (let f: Fixture | null = ghost.body.getFixtureList(); f; f = f.getNext()) old.push(f);
    for (const f of old) ghost.body.destroyFixture(f);
    ghost.shapes = copyFixtures(original, ghost.body);
    copyMass(original, ghost.body);
  }

  function syncMaterial(ghost: Ghost, original: Body): void {
    let g: Fixture | null = ghost.body.getFixtureList();
    for (let f: Fixture | null = original.getFixtureList(); f && g; f = f.getNext(), g = g.getNext()) {
      if (g.getFriction() !== f.getFriction()) g.setFriction(f.getFriction());
      if (g.getRestitution() !== f.getRestitution()) g.setRestitution(f.getRestitution());
    }
  }

  function dropGhost(original: Body, index: number, ghost: Ghost): void {
    world.destroyBody(ghost.body);
    const byTile = ghosts.get(original);
    if (!byTile) return;
    byTile.delete(index);
    if (byTile.size === 0) ghosts.delete(original);
  }

  // Ghost contacts honour joints that disable collision between the two real bodies.
  //
  // A ghost touching its own original is allowed: a shape longer than the canvas then blocks
  // itself across the seam (the two impulses cancel linearly and leave a net torque, which is
  // what stops it spinning through itself). Such a contact only exists while the shape is
  // actually turning into itself. A copy has the same linear velocity as its original, so the
  // relative speed at the seam is purely |w| * |offset|; when that is ~0 the contact is skipped,
  // otherwise the position solver would keep nudging a resting overlapped shape and make it
  // slowly rotate on its own.
  world.on("pre-solve", (contact: Contact) => {
    const bodyA = contact.getFixtureA().getBody();
    const bodyB = contact.getFixtureB().getBody();
    const ghostA = ghostOf.get(bodyA);
    const ghostB = ghostOf.get(bodyB);
    if (!ghostA && !ghostB) return;
    const ghost = (ghostA ?? ghostB) as Ghost;
    const real = ghostA ? bodyB : bodyA;
    const source = originalOf.get(ghost.body) as Body;
    if (real === source) {
      const seamSpeed = Math.abs(source.getAngularVelocity()) * Math.hypot(ghost.offset.x, ghost.offset.y);
      if (seamSpeed < SELF_CONTACT_MIN_SPEED) contact.setEnabled(false);
    } else if (!source.shouldCollide(real)) {
      contact.setEnabled(false);
    }
  });

  function sync(sizePx: { w: number; h: number }): void {
    const span = { x: toMeters(sizePx.w), y: toMeters(sizePx.h) };

    // Live shapes and the region they occupy, in pixels.
    const live = new Set<Body>();
    const bounds = new Map<Body, { min: Point; max: Point }>();
    const union = {
      min: { x: Infinity, y: Infinity },
      max: { x: -Infinity, y: -Infinity },
    };
    for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
      if (!isPickable(body)) continue;
      live.add(body);
      const b = bodyBoundsPx(body);
      bounds.set(body, b);
      union.min.x = Math.min(union.min.x, b.min.x);
      union.min.y = Math.min(union.min.y, b.min.y);
      union.max.x = Math.max(union.max.x, b.max.x);
      union.max.y = Math.max(union.max.y, b.max.y);
    }

    // Drop ghosts of bodies that left the world, or that no longer reach anything.
    for (const [original, byTile] of [...ghosts]) {
      for (const [index, ghost] of [...byTile]) {
        const b = bounds.get(original);
        const tile = TILES[index];
        const shift = { x: tile.x * sizePx.w, y: tile.y * sizePx.h };
        if (!live.has(original) || !b || !overlaps(b, shift, reachPx(original), union)) {
          dropGhost(original, index, ghost);
        }
      }
    }

    for (const original of live) {
      const b = bounds.get(original);
      if (!b) continue;
      const pad = reachPx(original);
      for (let index = 0; index < TILES.length; index++) {
        const tile = TILES[index];
        const shift = { x: tile.x * sizePx.w, y: tile.y * sizePx.h };
        if (!overlaps(b, shift, pad, union)) continue;

        let byTile = ghosts.get(original);
        if (!byTile) {
          byTile = new Map();
          ghosts.set(original, byTile);
        }
        let ghost = byTile.get(index);
        if (!ghost) {
          ghost = makeGhost(original, tile);
          byTile.set(index, ghost);
        } else if (!sameShapes(ghost.shapes, fixtureShapes(original))) {
          rebuildFixtures(ghost, original);
        } else {
          syncMaterial(ghost, original);
        }
        if (ghost.body.getType() !== original.getType()) {
          ghost.body.setType(original.getType());
          copyMass(original, ghost.body);
        }

        const p = original.getPosition();
        const angle = original.getAngle();
        const v = original.getLinearVelocity();
        const w = original.getAngularVelocity();
        ghost.offset = { x: tile.x * span.x, y: tile.y * span.y };
        ghost.start = { x: p.x + ghost.offset.x, y: p.y + ghost.offset.y, angle };
        ghost.v = { x: v.x, y: v.y };
        ghost.w = w;
        ghost.body.setTransform({ x: ghost.start.x, y: ghost.start.y }, angle);
        ghost.body.setLinearVelocity({ x: v.x, y: v.y });
        ghost.body.setAngularVelocity(w);
        ghost.body.setAwake(true);
      }
    }
  }

  function apply(dt: number): void {
    for (const [original, byTile] of ghosts) {
      if (original.getType() !== "dynamic") continue;
      for (const ghost of byTile.values()) {
        const gv = ghost.body.getLinearVelocity();
        const gw = ghost.body.getAngularVelocity();
        const dvx = gv.x - ghost.v.x;
        const dvy = gv.y - ghost.v.y;
        const dw = gw - ghost.w;
        // Whatever the ghost moved beyond integrating its final velocity is the position solver's
        // push-out of penetration.
        const gp = ghost.body.getPosition();
        const dpx = gp.x - ghost.start.x - gv.x * dt;
        const dpy = gp.y - ghost.start.y - gv.y * dt;
        const da = ghost.body.getAngle() - ghost.start.angle - gw * dt;
        if (dvx === 0 && dvy === 0 && dw === 0 && dpx === 0 && dpy === 0 && da === 0) continue;

        const v = original.getLinearVelocity();
        original.setLinearVelocity({ x: v.x + dvx, y: v.y + dvy });
        original.setAngularVelocity(original.getAngularVelocity() + dw);
        const p = original.getPosition();
        original.setTransform(
          { x: p.x + dvx * dt + dpx, y: p.y + dvy * dt + dpy },
          original.getAngle() + dw * dt + da,
        );
        original.setAwake(true);
      }
    }
  }

  function clear(): void {
    for (const [original, byTile] of [...ghosts]) {
      for (const [index, ghost] of [...byTile]) dropGhost(original, index, ghost);
    }
    ghosts.clear();
  }

  return { sync, apply, clear };
}
