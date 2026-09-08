import type { Body } from "matter-js";
import { JOINT_TYPES, type JointType } from "./joints";
import { SHAPE_TYPES, type ShapeType } from "./shapes";

export type ActiveTool =
  | { kind: "shape"; shape: ShapeType }
  | { kind: "joint"; joint: JointType };

export interface UiOptions {
  onGravityChange(x: number, y: number): void;
  onBackgroundChange(color: string): void;
  /** Called with the requested state when the user toggles Pause/Play (button or Space). */
  onPauseToggle(paused: boolean): void;
}

export interface Ui {
  getSelectedShape(): ShapeType;
  getActiveTool(): ActiveTool;
  /** Show (or hide, when null) the readout for the currently selected body. */
  showSelectionInfo(body: Body | null): void;
  /** Reflect the current paused state on the toggle button. */
  setPaused(paused: boolean): void;
}

function isShapeType(value: string | undefined): value is ShapeType {
  return SHAPE_TYPES.includes(value as ShapeType);
}

function isJointType(value: string | undefined): value is JointType {
  return JOINT_TYPES.includes(value as JointType);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el as T;
}

export function setupUi({ onGravityChange, onBackgroundChange, onPauseToggle }: UiOptions): Ui {
  let selectedShape: ShapeType = "circle";
  let activeTool: ActiveTool = { kind: "shape", shape: selectedShape };

  // Pause / Play
  let paused = false;
  const pauseButton = requireElement<HTMLButtonElement>("pause-toggle");

  function setPaused(value: boolean): void {
    paused = value;
    pauseButton.textContent = paused ? "Play" : "Pause";
    pauseButton.setAttribute("aria-pressed", String(paused));
    pauseButton.classList.toggle("is-paused", paused);
  }

  pauseButton.addEventListener("click", () => onPauseToggle(!paused));
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    // Don't hijack Space when a form control has focus (a focused button already clicks on Space).
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    onPauseToggle(!paused);
  });

  // Shape / joint tools (mutually exclusive)
  const shapeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".shape-btn[data-shape]"),
  );
  const jointButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".joint-btn[data-joint]"),
  );

  function syncToolButtons(): void {
    for (const button of shapeButtons) {
      button.classList.toggle(
        "is-active",
        activeTool.kind === "shape" && button.dataset.shape === activeTool.shape,
      );
    }
    for (const button of jointButtons) {
      button.classList.toggle(
        "is-active",
        activeTool.kind === "joint" && button.dataset.joint === activeTool.joint,
      );
    }
  }

  for (const button of shapeButtons) {
    button.addEventListener("click", () => {
      const shape = button.dataset.shape;
      if (!isShapeType(shape)) return;
      selectedShape = shape;
      activeTool = { kind: "shape", shape };
      syncToolButtons();
    });
  }

  for (const button of jointButtons) {
    button.addEventListener("click", () => {
      const joint = button.dataset.joint;
      if (!isJointType(joint)) return;
      activeTool = { kind: "joint", joint };
      syncToolButtons();
    });
  }

  // Gravity sliders
  const gravityX = requireElement<HTMLInputElement>("gravity-x");
  const gravityY = requireElement<HTMLInputElement>("gravity-y");
  const gravityXValue = requireElement<HTMLOutputElement>("gravity-x-value");
  const gravityYValue = requireElement<HTMLOutputElement>("gravity-y-value");

  function applyGravity(): void {
    const x = parseFloat(gravityX.value);
    const y = parseFloat(gravityY.value);
    gravityXValue.textContent = x.toFixed(2);
    gravityYValue.textContent = y.toFixed(2);
    onGravityChange(x, y);
  }

  gravityX.addEventListener("input", applyGravity);
  gravityY.addEventListener("input", applyGravity);
  applyGravity();

  // Background colour
  const backgroundColor = requireElement<HTMLInputElement>("background-color");
  const applyBackground = (): void => onBackgroundChange(backgroundColor.value);
  backgroundColor.addEventListener("input", applyBackground);
  applyBackground();

  // Selected body readout
  const selectionInfo = requireElement<HTMLDivElement>("selection-info");
  const selectionShape = requireElement<HTMLElement>("selection-shape");
  const selectionSize = requireElement<HTMLElement>("selection-size");
  const selectionMass = requireElement<HTMLElement>("selection-mass");
  const selectionAngle = requireElement<HTMLElement>("selection-angle");

  function showSelectionInfo(body: Body | null): void {
    if (!body) {
      selectionInfo.hidden = true;
      return;
    }
    const width = body.bounds.max.x - body.bounds.min.x;
    const height = body.bounds.max.y - body.bounds.min.y;
    selectionInfo.hidden = false;
    selectionShape.textContent = body.label.replace(/ Body$/, "");
    selectionSize.textContent = `${Math.round(width)} x ${Math.round(height)} px`;
    selectionMass.textContent = body.mass.toFixed(2);
    const degrees = (((body.angle * 180) / Math.PI) % 360 + 360) % 360;
    selectionAngle.textContent = `${Math.round(degrees)}\u00B0`;
  }

  return {
    getSelectedShape: () => selectedShape,
    getActiveTool: () => activeTool,
    showSelectionInfo,
    setPaused,
  };
}
