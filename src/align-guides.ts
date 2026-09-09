import type { Body, ChainShape, CircleShape, EdgeShape, PolygonShape, World } from "planck";
import { bodyBoundsPx, nearestWrapPoint, withWrapOffsets, type AfterRender } from "./physics";
import { getBodyData, isPickable, regularPolygon, type PrimitiveShape } from "./shapes";
import { toPixels, vecToPixels, type Point } from "./units";

/** Screen-pixel distance at which edges/centres snap and guides appear. */
export const ALIGN_THRESHOLD_PX = 6;

const GUIDE_STROKE = "#c44e7a";
const MATCH_EPS = 0.5;
const LINE_PAD = 16;

export interface AlignBounds {
  min: Point;
  max: Point;
}

export interface GuideLine {
  axis: "h" | "v";
  pos: number;
  from: number;
  to: number;
}

export interface AlignResult {
  dx: number;
  dy: number;
  lines: GuideLine[];
}

export interface AlignGuides {
  set(lines: GuideLine[]): void;
  clear(): void;
}

export function createAlignGuides({
  getWrapOffsets,
  onAfterRender,
}: {
  getWrapOffsets(): Point[];
  onAfterRender(cb: AfterRender): void;
}): AlignGuides {
  let lines: GuideLine[] = [];

  onAfterRender((ctx) => {
    if (lines.length === 0) return;
    withWrapOffsets(ctx, getWrapOffsets(), () => {
      ctx.save();
      ctx.strokeStyle = GUIDE_STROKE;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (const g of lines) {
        if (g.axis === "v") {
          ctx.moveTo(g.pos, g.from);
          ctx.lineTo(g.pos, g.to);
        } else {
          ctx.moveTo(g.from, g.pos);
          ctx.lineTo(g.to, g.pos);
        }
      }
      ctx.stroke();
      ctx.restore();
    });
  });

  return {
    set(next) {
      lines = next;
    },
    clear() {
      lines = [];
    },
  };
}

export function alignThreshold(zoom: number): number {
  return ALIGN_THRESHOLD_PX / zoom;
}

export function collectTargetBounds(
  world: World,
  skip: Iterable<Body>,
  around: Point,
  offsets: Point[],
): AlignBounds[] {
  const ignored = skip instanceof Set ? skip : new Set(skip);
  const out: AlignBounds[] = [];
  for (let body: Body | null = world.getBodyList(); body; body = body.getNext()) {
    if (!isPickable(body) || ignored.has(body)) continue;
    out.push(wrapBoundsToward(bodyBoundsPx(body), around, offsets));
  }
  return out;
}

export function matchBounds(active: AlignBounds, targets: AlignBounds[], threshold: number): AlignResult {
  const dx = bestSlotDelta(vSlots(active), targets, "v", threshold);
  const dy = bestSlotDelta(hSlots(active), targets, "h", threshold);
  const snapped = shiftBounds(active, dx, dy);
  return { dx, dy, lines: slotLines(snapped, targets, MATCH_EPS) };
}

/** Snap a free corner so the AABB from `anchor` to the pointer lines up with other shapes. */
export function snapBoxPointer(
  anchor: Point,
  pointer: Point,
  targets: AlignBounds[],
  threshold: number,
): { point: Point; lines: GuideLine[] } {
  const x = bestPointerCoord(pointer.x, anchor.x, targets, "v", threshold);
  const y = bestPointerCoord(pointer.y, anchor.y, targets, "h", threshold);
  const point = { x, y };
  const bounds = aabbFromCorners(anchor, point);
  return { point, lines: slotLines(bounds, targets, MATCH_EPS) };
}

export function radialPreviewBounds(type: PrimitiveShape, x: number, y: number, size: number): AlignBounds {
  if (type === "circle" || type === "rectangle") {
    return { min: { x: x - size, y: y - size }, max: { x: x + size, y: y + size } };
  }
  const radius = type === "triangle" ? size * 1.2 : size;
  const sides = type === "triangle" ? 3 : type === "pentagon" ? 5 : 6;
  const verts = regularPolygon(sides, radius);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    minX = Math.min(minX, x + v.x);
    minY = Math.min(minY, y + v.y);
    maxX = Math.max(maxX, x + v.x);
    maxY = Math.max(maxY, y + v.y);
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Snap a radial preview's size so its AABB sides line up; also report centre-line guides. */
export function snapRadialSize(
  center: Point,
  size: number,
  bounds: AlignBounds,
  targets: AlignBounds[],
  threshold: number,
  minSize: number,
  maxSize: number,
): { size: number; lines: GuideLine[] } {
  let best = size;
  let bestAbs = threshold + 1;
  const consider = (slot: number, origin: number, target: number): void => {
    const span = slot - origin;
    if (Math.abs(span) < 1e-6) return;
    const next = size * (target - origin) / span;
    if (next < minSize || next > maxSize) return;
    const dist = Math.abs(slot - target);
    if (dist <= threshold && dist < bestAbs) {
      bestAbs = dist;
      best = next;
    }
  };
  for (const t of targets) {
    for (const s of vSlots(t)) {
      consider(bounds.min.x, center.x, s);
      consider(bounds.max.x, center.x, s);
    }
    for (const s of hSlots(t)) {
      consider(bounds.min.y, center.y, s);
      consider(bounds.max.y, center.y, s);
    }
  }
  const factor = size === 0 ? 1 : best / size;
  const snapped: AlignBounds = {
    min: {
      x: center.x + (bounds.min.x - center.x) * factor,
      y: center.y + (bounds.min.y - center.y) * factor,
    },
    max: {
      x: center.x + (bounds.max.x - center.x) * factor,
      y: center.y + (bounds.max.y - center.y) * factor,
    },
  };
  const lines = slotLines(snapped, targets, MATCH_EPS);
  lines.push(...slotLines({ min: center, max: center }, targets, MATCH_EPS));
  return { size: best, lines: mergeLines(lines) };
}

/**
 * Snap a live point onto other shapes, and optionally onto a horizontal/vertical
 * from `axisFrom` (the previous vertex or edge start).
 */
export function snapDrawPoint(
  pointer: Point,
  targets: AlignBounds[],
  threshold: number,
  axisFrom?: Point,
): { point: Point; lines: GuideLine[] } {
  let x = pointer.x;
  let y = pointer.y;
  let bestDx = threshold + 1;
  let bestDy = threshold + 1;

  const considerX = (next: number, dist: number): void => {
    if (dist <= threshold && dist < bestDx) {
      bestDx = dist;
      x = next;
    }
  };
  const considerY = (next: number, dist: number): void => {
    if (dist <= threshold && dist < bestDy) {
      bestDy = dist;
      y = next;
    }
  };

  if (axisFrom) {
    considerX(axisFrom.x, Math.abs(pointer.x - axisFrom.x));
    considerY(axisFrom.y, Math.abs(pointer.y - axisFrom.y));
  }
  for (const t of targets) {
    for (const s of vSlots(t)) considerX(s, Math.abs(pointer.x - s));
    for (const s of hSlots(t)) considerY(s, Math.abs(pointer.y - s));
  }

  const point = { x, y };
  const lines: GuideLine[] = [];
  if (axisFrom) {
    if (Math.abs(point.x - axisFrom.x) <= MATCH_EPS) {
      lines.push(paddedLine("v", point.x, axisFrom.y, point.y));
    }
    if (Math.abs(point.y - axisFrom.y) <= MATCH_EPS) {
      lines.push(paddedLine("h", point.y, axisFrom.x, point.x));
    }
  }
  lines.push(...slotLines({ min: point, max: point }, targets, MATCH_EPS));
  if (axisFrom) lines.push(...slotLines({ min: axisFrom, max: axisFrom }, targets, MATCH_EPS));
  return { point, lines: mergeLines(lines) };
}

export function matchRotate(
  bodies: readonly Body[],
  pivot: Point,
  extraAngle: number,
  targets: AlignBounds[],
  threshold: number,
  snapAxis: boolean,
): { dAngle: number; lines: GuideLine[] } {
  const dAngle = snapAxis ? rotationSnapDelta(bodies, pivot, extraAngle, threshold) : 0;
  const total = extraAngle + dAngle;
  const lines: GuideLine[] = [];
  for (const body of bodies) {
    for (const edge of bodyEdgesPx(body)) {
      const a = rotatePx(edge.a, pivot, total);
      const b = rotatePx(edge.b, pivot, total);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dy) <= MATCH_EPS && Math.abs(dx) > MATCH_EPS) {
        const ext = extendEdge(a, b, LINE_PAD);
        lines.push(paddedLine("h", (ext.a.y + ext.b.y) / 2, ext.a.x, ext.b.x));
      }
      if (Math.abs(dx) <= MATCH_EPS && Math.abs(dy) > MATCH_EPS) {
        const ext = extendEdge(a, b, LINE_PAD);
        lines.push(paddedLine("v", (ext.a.x + ext.b.x) / 2, ext.a.y, ext.b.y));
      }
    }
  }
  const aabb = rotatedGroupBounds(bodies, pivot, total);
  lines.push(...slotLines(aabb, targets, threshold));
  return { dAngle, lines: mergeLines(lines) };
}

function wrapBoundsToward(b: AlignBounds, around: Point, offsets: Point[]): AlignBounds {
  const c = centreOf(b);
  const local = nearestWrapPoint(c, around, offsets);
  return shiftBounds(b, local.x - c.x, local.y - c.y);
}

function centreOf(b: AlignBounds): Point {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
}

function shiftBounds(b: AlignBounds, dx: number, dy: number): AlignBounds {
  return {
    min: { x: b.min.x + dx, y: b.min.y + dy },
    max: { x: b.max.x + dx, y: b.max.y + dy },
  };
}

function vSlots(b: AlignBounds): number[] {
  return [b.min.x, (b.min.x + b.max.x) / 2, b.max.x];
}

function hSlots(b: AlignBounds): number[] {
  return [b.min.y, (b.min.y + b.max.y) / 2, b.max.y];
}

function bestSlotDelta(
  activeSlots: number[],
  targets: AlignBounds[],
  axis: "v" | "h",
  threshold: number,
): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const t of targets) {
    const slots = axis === "v" ? vSlots(t) : hSlots(t);
    for (const a of activeSlots) {
      for (const s of slots) {
        const d = s - a;
        const ad = Math.abs(d);
        if (ad <= threshold && ad < bestAbs) {
          bestAbs = ad;
          best = d;
        }
      }
    }
  }
  return Number.isFinite(bestAbs) ? best : 0;
}

function bestPointerCoord(
  pointer: number,
  anchor: number,
  targets: AlignBounds[],
  axis: "v" | "h",
  threshold: number,
): number {
  let best = pointer;
  let bestAbs = Infinity;
  const consider = (next: number, dist: number): void => {
    if (dist <= threshold && dist < bestAbs) {
      bestAbs = dist;
      best = next;
    }
  };
  for (const t of targets) {
    const slots = axis === "v" ? vSlots(t) : hSlots(t);
    for (const s of slots) {
      consider(s, Math.abs(pointer - s));
      consider(2 * s - anchor, Math.abs((anchor + pointer) / 2 - s));
    }
  }
  return best;
}

function aabbFromCorners(a: Point, b: Point): AlignBounds {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

function slotLines(active: AlignBounds, targets: AlignBounds[], threshold: number): GuideLine[] {
  const lines: GuideLine[] = [];
  for (const t of targets) {
    for (const a of vSlots(active)) {
      for (const s of vSlots(t)) {
        if (Math.abs(a - s) <= threshold) {
          lines.push(paddedLine("v", s, active.min.y, t.min.y, active.max.y, t.max.y));
        }
      }
    }
    for (const a of hSlots(active)) {
      for (const s of hSlots(t)) {
        if (Math.abs(a - s) <= threshold) {
          lines.push(paddedLine("h", s, active.min.x, t.min.x, active.max.x, t.max.x));
        }
      }
    }
  }
  return mergeLines(lines);
}

function paddedLine(axis: "h" | "v", pos: number, ...span: number[]): GuideLine {
  let from = Math.min(...span);
  let to = Math.max(...span);
  if (to - from < 1) {
    const mid = (from + to) / 2;
    from = mid - LINE_PAD;
    to = mid + LINE_PAD;
  }
  return { axis, pos, from, to };
}

function mergeLines(lines: GuideLine[]): GuideLine[] {
  const map = new Map<string, GuideLine>();
  for (const g of lines) {
    const from = Math.min(g.from, g.to);
    const to = Math.max(g.from, g.to);
    const key = `${g.axis}:${g.pos.toFixed(2)}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { axis: g.axis, pos: g.pos, from, to });
    } else {
      prev.from = Math.min(prev.from, from);
      prev.to = Math.max(prev.to, to);
    }
  }
  return [...map.values()];
}

function wrapPi(a: number): number {
  const tau = Math.PI * 2;
  return a - tau * Math.round(a / tau);
}

function wrapHalfPi(a: number): number {
  let x = wrapPi(a);
  if (x > Math.PI / 2) x -= Math.PI;
  if (x < -Math.PI / 2) x += Math.PI;
  return x;
}

function rotatePx(p: Point, pivot: Point, angle: number): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
}

function extendEdge(a: Point, b: Point, pad: number): { a: Point; b: Point } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { a, b };
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  return {
    a: { x: a.x - ux * pad, y: a.y - uy * pad },
    b: { x: b.x + ux * pad, y: b.y + uy * pad },
  };
}

function rotationSnapDelta(
  bodies: readonly Body[],
  pivot: Point,
  extraAngle: number,
  threshold: number,
): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const body of bodies) {
    for (const edge of bodyEdgesPx(body)) {
      const a = rotatePx(edge.a, pivot, extraAngle);
      const b = rotatePx(edge.b, pivot, extraAngle);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(dy) <= threshold) {
        const d = wrapHalfPi(-ang);
        if (Math.abs(d) < bestAbs) {
          bestAbs = Math.abs(d);
          best = d;
        }
      }
      if (Math.abs(dx) <= threshold) {
        const d = wrapHalfPi(Math.PI / 2 - ang);
        if (Math.abs(d) < bestAbs) {
          bestAbs = Math.abs(d);
          best = d;
        }
      }
    }
  }
  return Number.isFinite(bestAbs) ? best : 0;
}

function rotatedGroupBounds(bodies: readonly Body[], pivot: Point, angle: number): AlignBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Point): void => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const body of bodies) {
    let used = false;
    const data = getBodyData(body);
    if (data?.outline && data.outline.length >= 2) {
      for (const p of data.outline) add(rotatePx(vecToPixels(body.getWorldPoint(p)), pivot, angle));
      used = true;
    } else {
      for (let f = body.getFixtureList(); f; f = f.getNext()) {
        const shape = f.getShape();
        const type = shape.getType();
        if (type === "circle") {
          const circle = shape as CircleShape;
          const c = rotatePx(vecToPixels(body.getWorldPoint(circle.getCenter())), pivot, angle);
          const r = toPixels(circle.getRadius());
          add({ x: c.x - r, y: c.y - r });
          add({ x: c.x + r, y: c.y + r });
          used = true;
        } else if (type === "polygon") {
          const poly = shape as PolygonShape;
          for (let i = 0; i < poly.m_count; i++) {
            add(rotatePx(vecToPixels(body.getWorldPoint(poly.m_vertices[i])), pivot, angle));
          }
          used = true;
        } else if (type === "edge") {
          const edge = shape as EdgeShape;
          add(rotatePx(vecToPixels(body.getWorldPoint(edge.m_vertex1)), pivot, angle));
          add(rotatePx(vecToPixels(body.getWorldPoint(edge.m_vertex2)), pivot, angle));
          used = true;
        } else if (type === "chain") {
          const chain = shape as ChainShape;
          for (let i = 0; i < chain.m_count; i++) {
            add(rotatePx(vecToPixels(body.getWorldPoint(chain.m_vertices[i])), pivot, angle));
          }
          used = true;
        }
      }
    }
    if (!used) add(rotatePx(vecToPixels(body.getPosition()), pivot, angle));
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function bodyEdgesPx(body: Body): { a: Point; b: Point }[] {
  const data = getBodyData(body);
  if (data?.outline && data.outline.length >= 2) {
    return ringEdges(
      data.outline.map((p) => vecToPixels(body.getWorldPoint(p))),
      true,
    );
  }
  const edges: { a: Point; b: Point }[] = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === "polygon") {
      const poly = shape as PolygonShape;
      const pts: Point[] = [];
      for (let i = 0; i < poly.m_count; i++) pts.push(vecToPixels(body.getWorldPoint(poly.m_vertices[i])));
      edges.push(...ringEdges(pts, true));
    } else if (type === "edge") {
      const edge = shape as EdgeShape;
      edges.push({
        a: vecToPixels(body.getWorldPoint(edge.m_vertex1)),
        b: vecToPixels(body.getWorldPoint(edge.m_vertex2)),
      });
    } else if (type === "chain") {
      const chain = shape as ChainShape;
      const pts: Point[] = [];
      for (let i = 0; i < chain.m_count; i++) pts.push(vecToPixels(body.getWorldPoint(chain.m_vertices[i])));
      edges.push(...ringEdges(pts, Boolean(chain.m_isLoop)));
    }
  }
  return edges;
}

function ringEdges(pts: Point[], closed: boolean): { a: Point; b: Point }[] {
  const edges: { a: Point; b: Point }[] = [];
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a && b) edges.push({ a, b });
  }
  return edges;
}
