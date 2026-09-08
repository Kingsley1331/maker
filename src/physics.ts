import { Bodies, Body, Common, Composite, Engine, Render, Runner } from "matter-js";
import decomp from "poly-decomp";

Common.setDecomp(decomp);

const WALL_THICKNESS = 200;

export const DEFAULT_BACKGROUND = "#ffffff";

export interface Physics {
  engine: Engine;
  render: Render;
  runner: Runner;
  setGravity(x: number, y: number): void;
  setBackground(color: string): void;
  /** Stop stepping the simulation. Rendering continues. */
  pause(): void;
  /** Resume stepping the simulation. */
  play(): void;
  isPaused(): boolean;
}

function sceneSize(container: HTMLElement): { w: number; h: number } {
  return {
    w: Math.max(1, container.clientWidth),
    h: Math.max(1, container.clientHeight),
  };
}

export function createPhysics(container: HTMLElement): Physics {
  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 1;
  engine.constraintIterations = 4;

  const initial = sceneSize(container);
  const render = Render.create({
    element: container,
    engine,
    options: {
      width: initial.w,
      height: initial.h,
      wireframes: false,
      background: DEFAULT_BACKGROUND,
      pixelRatio: window.devicePixelRatio || 1,
    },
  });

  const runner = Runner.create();

  let walls: Body[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastDpr = 0;

  function buildWalls(w: number, h: number): void {
    if (walls.length) {
      Composite.remove(engine.world, walls);
    }

    const half = WALL_THICKNESS / 2;
    const wallOptions = {
      isStatic: true,
      render: { fillStyle: "#22262e" },
    };

    walls = [
      // floor
      Bodies.rectangle(w / 2, h + half, w + WALL_THICKNESS * 2, WALL_THICKNESS, wallOptions),
      // ceiling
      Bodies.rectangle(w / 2, -half, w + WALL_THICKNESS * 2, WALL_THICKNESS, wallOptions),
      // left
      Bodies.rectangle(-half, h / 2, WALL_THICKNESS, h + WALL_THICKNESS * 2, wallOptions),
      // right
      Bodies.rectangle(w + half, h / 2, WALL_THICKNESS, h + WALL_THICKNESS * 2, wallOptions),
    ];

    Composite.add(engine.world, walls);
  }

  function resize(): void {
    const { w, h } = sceneSize(container);
    const dpr = window.devicePixelRatio || 1;
    if (w === lastW && h === lastH && dpr === lastDpr) return;
    lastW = w;
    lastH = h;
    lastDpr = dpr;

    render.options.width = w;
    render.options.height = h;
    render.bounds.max.x = w;
    render.bounds.max.y = h;
    Render.setPixelRatio(render, dpr);
    buildWalls(w, h);
  }

  new ResizeObserver(resize).observe(container);
  window.addEventListener("resize", resize);
  resize();

  Render.run(render);
  Runner.run(runner, engine);
  let paused = false;

  return {
    engine,
    render,
    runner,
    setGravity(x: number, y: number): void {
      engine.gravity.x = x;
      engine.gravity.y = y;
    },
    setBackground(color: string): void {
      // Render applies options.background to the canvas on the next frame.
      render.options.background = color;
    },
    pause(): void {
      if (paused) return;
      paused = true;
      Runner.stop(runner);
    },
    play(): void {
      if (!paused) return;
      paused = false;
      // Runner.tick treats the long gap since the last tick as a fallback delta, so no jump.
      Runner.run(runner, engine);
    },
    isPaused: () => paused,
  };
}
