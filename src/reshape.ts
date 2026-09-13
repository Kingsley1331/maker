import type { Body } from "planck";
import { applyContour } from "./cut";
import {
  applyFixtureSpecs,
  fixtureSpecs,
  getBodyData,
  type FixtureJson,
} from "./shapes";
import { toMeters, vecToMeters, vecToPixels, type Point } from "./units";

/** Smallest edge / chain segment allowed while dragging a vertex (px). Matches spawn. */
const MIN_EDGE_PX = 8;

export type VertexKind = "outline" | "hole" | "edge" | "chain";

export interface VertexRef {
  kind: VertexKind;
  /** Set when `kind` is `"hole"`. */
  holeIndex?: number;
  index: number;
}

export interface VertexHandle {
  ref: VertexRef;
  worldPx: Point;
}

/**
 * Live vertex drag. Geometry is copied at press time so a winding fix inside `applyContour`
 * cannot retarget the vertex being moved.
 */
export interface VertexDrag {
  body: Body;
  ref: VertexRef;
  outline: Point[] | null;
  holes: Point[][];
  specs: FixtureJson[] | null;
}

function copyRing(ring: Point[]): Point[] {
  return ring.map((p) => ({ x: p.x, y: p.y }));
}

function copySpecs(specs: FixtureJson[]): FixtureJson[] {
  return specs.map((spec) => {
    const shape = spec.shape;
    if (shape.type === "polygon") {
      return { ...spec, shape: { type: "polygon", vertices: copyRing(shape.vertices) } };
    }
    if (shape.type === "edge") {
      return { ...spec, shape: { type: "edge", v1: { ...shape.v1 }, v2: { ...shape.v2 } } };
    }
    if (shape.type === "chain") {
      return {
        ...spec,
        shape: { type: "chain", vertices: copyRing(shape.vertices), loop: shape.loop },
      };
    }
    return {
      ...spec,
      shape: { type: "circle", center: { ...shape.center }, radius: shape.radius },
    };
  });
}

function worldPxOf(body: Body, local: Point): Point {
  return vecToPixels(body.getWorldPoint(local));
}

export function refsEqual(a: VertexRef | null, b: VertexRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.index === b.index && a.holeIndex === b.holeIndex;
}

/** Outline + holes when the body is a filled solid with editable vertices. */
function filledGeometry(body: Body): { outline: Point[]; holes: Point[][] } | null {
  const data = getBodyData(body);
  if (data?.outline && data.outline.length >= 3) {
    return {
      outline: copyRing(data.outline),
      holes: (data.holes ?? []).filter((ring) => ring.length >= 3).map(copyRing),
    };
  }
  const specs = fixtureSpecs(body);
  if (specs.length !== 1) return null;
  const shape = specs[0].shape;
  if (shape.type !== "polygon" || shape.vertices.length < 3) return null;
  return { outline: copyRing(shape.vertices), holes: [] };
}

function lineSpecs(body: Body): FixtureJson[] | null {
  const specs = fixtureSpecs(body);
  if (specs.length !== 1) return null;
  const type = specs[0].shape.type;
  if (type !== "edge" && type !== "chain") return null;
  return copySpecs(specs);
}

/** Editable vertices of a pickable body. Circles and unmarked compounds have none. */
export function listVertices(body: Body): VertexHandle[] {
  const data = getBodyData(body);
  if (!data || data.kind !== "shape") return [];

  const filled = filledGeometry(body);
  if (filled) {
    const out: VertexHandle[] = [];
    for (let i = 0; i < filled.outline.length; i++) {
      out.push({
        ref: { kind: "outline", index: i },
        worldPx: worldPxOf(body, filled.outline[i]),
      });
    }
    for (let h = 0; h < filled.holes.length; h++) {
      const ring = filled.holes[h];
      for (let i = 0; i < ring.length; i++) {
        out.push({
          ref: { kind: "hole", holeIndex: h, index: i },
          worldPx: worldPxOf(body, ring[i]),
        });
      }
    }
    return out;
  }

  const specs = lineSpecs(body);
  if (!specs) return [];
  const shape = specs[0].shape;
  if (shape.type === "edge") {
    return [
      { ref: { kind: "edge", index: 0 }, worldPx: worldPxOf(body, shape.v1) },
      { ref: { kind: "edge", index: 1 }, worldPx: worldPxOf(body, shape.v2) },
    ];
  }
  if (shape.type === "chain") {
    return shape.vertices.map((v, i) => ({
      ref: { kind: "chain", index: i },
      worldPx: worldPxOf(body, v),
    }));
  }
  return [];
}

/** Vertex handles from a live drag's working copy (stable indices while dragging). */
export function verticesOfDrag(drag: VertexDrag): VertexHandle[] {
  const { body } = drag;
  if (drag.outline) {
    const out: VertexHandle[] = [];
    for (let i = 0; i < drag.outline.length; i++) {
      out.push({
        ref: { kind: "outline", index: i },
        worldPx: worldPxOf(body, drag.outline[i]),
      });
    }
    for (let h = 0; h < drag.holes.length; h++) {
      const ring = drag.holes[h];
      for (let i = 0; i < ring.length; i++) {
        out.push({
          ref: { kind: "hole", holeIndex: h, index: i },
          worldPx: worldPxOf(body, ring[i]),
        });
      }
    }
    return out;
  }
  if (!drag.specs || drag.specs.length !== 1) return [];
  const shape = drag.specs[0].shape;
  if (shape.type === "edge") {
    return [
      { ref: { kind: "edge", index: 0 }, worldPx: worldPxOf(body, shape.v1) },
      { ref: { kind: "edge", index: 1 }, worldPx: worldPxOf(body, shape.v2) },
    ];
  }
  if (shape.type === "chain") {
    return shape.vertices.map((v, i) => ({
      ref: { kind: "chain", index: i },
      worldPx: worldPxOf(body, v),
    }));
  }
  return [];
}

/** Snapshot geometry for a vertex drag. Null if `ref` does not match the body. */
export function startVertexDrag(body: Body, ref: VertexRef): VertexDrag | null {
  if (ref.kind === "outline" || ref.kind === "hole") {
    const geo = filledGeometry(body);
    if (!geo) return null;
    if (ref.kind === "outline") {
      if (ref.index < 0 || ref.index >= geo.outline.length) return null;
    } else if (ref.holeIndex === undefined || !geo.holes[ref.holeIndex]) {
      return null;
    } else if (ref.index < 0 || ref.index >= geo.holes[ref.holeIndex].length) {
      return null;
    }
    return { body, ref, outline: geo.outline, holes: geo.holes, specs: null };
  }

  const specs = lineSpecs(body);
  if (!specs) return null;
  const shape = specs[0].shape;
  if (ref.kind === "edge" && shape.type === "edge" && (ref.index === 0 || ref.index === 1)) {
    return { body, ref, outline: null, holes: [], specs };
  }
  if (ref.kind === "chain" && shape.type === "chain" && ref.index >= 0 && ref.index < shape.vertices.length) {
    return { body, ref, outline: null, holes: [], specs };
  }
  return null;
}

function minEdgeM(): number {
  return toMeters(MIN_EDGE_PX);
}

function tooShort(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < minEdgeM();
}

function chainTooShort(verts: Point[], loop: boolean): boolean {
  if (verts.length < (loop ? 3 : 2)) return true;
  for (let i = 1; i < verts.length; i++) {
    if (tooShort(verts[i - 1], verts[i])) return true;
  }
  if (loop && tooShort(verts[0], verts[verts.length - 1])) return true;
  return false;
}

function replaceSpecs(body: Body, specs: FixtureJson[]): boolean {
  const previous = fixtureSpecs(body);
  const stale: NonNullable<ReturnType<Body["getFixtureList"]>>[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) stale.push(f);
  for (const f of stale) body.destroyFixture(f);
  try {
    applyFixtureSpecs(body, specs);
    body.synchronizeFixtures();
    body.setAwake(true);
    return true;
  } catch {
    applyFixtureSpecs(body, previous);
    body.synchronizeFixtures();
    body.setAwake(true);
    return false;
  }
}

/** Move the captured vertex to `worldPx`. False leaves the last valid pose in place. */
export function moveVertex(drag: VertexDrag, worldPx: Point): boolean {
  const local = drag.body.getLocalPoint(vecToMeters(worldPx));
  const next = { x: local.x, y: local.y };
  const { body, ref } = drag;

  if (ref.kind === "outline" || ref.kind === "hole") {
    if (!drag.outline) return false;
    const outline = copyRing(drag.outline);
    const holes = drag.holes.map(copyRing);
    if (ref.kind === "outline") {
      if (ref.index < 0 || ref.index >= outline.length) return false;
      outline[ref.index] = next;
    } else {
      const ring = ref.holeIndex !== undefined ? holes[ref.holeIndex] : undefined;
      if (!ring || ref.index < 0 || ref.index >= ring.length) return false;
      ring[ref.index] = next;
    }
    try {
      if (!applyContour(body, outline, holes)) return false;
    } catch {
      return false;
    }
    drag.outline = outline;
    drag.holes = holes;
    return true;
  }

  if (!drag.specs || drag.specs.length !== 1) return false;
  const specs = copySpecs(drag.specs);
  const shape = specs[0].shape;

  if (ref.kind === "edge" && shape.type === "edge") {
    if (ref.index === 0) shape.v1 = next;
    else if (ref.index === 1) shape.v2 = next;
    else return false;
    if (tooShort(shape.v1, shape.v2)) return false;
  } else if (ref.kind === "chain" && shape.type === "chain") {
    if (ref.index < 0 || ref.index >= shape.vertices.length) return false;
    shape.vertices[ref.index] = next;
    if (chainTooShort(shape.vertices, shape.loop)) return false;
  } else {
    return false;
  }

  if (!replaceSpecs(body, specs)) return false;
  drag.specs = specs;
  return true;
}
