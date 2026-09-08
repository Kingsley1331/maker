import { Bodies, Body, Vertices } from "matter-js";

export type PrimitiveShape = "circle" | "rectangle" | "triangle" | "pentagon" | "hexagon";
export type ShapeType = PrimitiveShape | "polygon";

export const PRIMITIVE_SHAPES: PrimitiveShape[] = [
  "circle",
  "rectangle",
  "triangle",
  "pentagon",
  "hexagon",
];

export const SHAPE_TYPES: ShapeType[] = [...PRIMITIVE_SHAPES, "polygon"];

const PALETTE = [
  "#f94144",
  "#f3722c",
  "#f8961e",
  "#f9c74f",
  "#90be6d",
  "#43aa8b",
  "#4d908e",
  "#577590",
  "#277da1",
  "#b56576",
];

export const DEFAULT_SIZE = 28;

export type Point = { x: number; y: number };

function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

function bodyOptions(label?: string) {
  return {
    ...(label ? { label } : {}),
    restitution: 0.4,
    friction: 0.3,
    frictionAir: 0.005,
    render: { fillStyle: randomColor() },
  };
}

/**
 * Create a body of the given type centred at (x, y). `size` is the nominal radius in px.
 * Mass is derived by Matter from area and density, so larger shapes are heavier.
 */
export function createBody(type: PrimitiveShape, x: number, y: number, size: number = DEFAULT_SIZE): Body {
  const options = bodyOptions();

  switch (type) {
    case "circle":
      return Bodies.circle(x, y, size, options);
    case "rectangle":
      return Bodies.rectangle(x, y, size * 2, size * 2, options);
    case "triangle":
      return Bodies.polygon(x, y, 3, size * 1.2, options);
    case "pentagon":
      return Bodies.polygon(x, y, 5, size, options);
    case "hexagon":
      return Bodies.polygon(x, y, 6, size, options);
  }
}

/**
 * Create a rigid body from user-drawn vertices. Returns null if Matter cannot form a body
 * (degenerate or empty decomposition). The body is placed on the drawn centroid.
 */
export function createPolygon(points: Point[]): Body | null {
  if (points.length < 3) return null;

  const vertices = points.map((p) => ({ x: p.x, y: p.y }));
  const centre = Vertices.centre(vertices);
  const body = Bodies.fromVertices(centre.x, centre.y, [vertices], bodyOptions("Polygon Body"), true);

  if (!body) return null;
  Body.setPosition(body, centre);
  return body;
}
