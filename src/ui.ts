import type { Body, BodyType, Joint } from "planck";
import {
  getAngleRangeDeg,
  getMotorSpeed,
  hasAngleLimit,
  isMotorJoint,
  JOINT_TYPES,
  motorJointLabel,
  type JointType,
} from "./joints";
import { bodyLabel, groupBoundsPx } from "./group";
import { bodyBoundsPx } from "./physics";
import { getBodyData, SHAPE_TYPES, type JointUserData, type ShapeType } from "./shapes";
import { toPixels } from "./units";

export type ActiveTool =
  | { kind: "shape"; shape: ShapeType }
  | { kind: "joint"; joint: JointType };

export interface UiOptions {
  onGravityChange(x: number, y: number): void;
  onBackgroundChange(color: string): void;
  /** Called with the requested state when the user toggles Pause/Play (button or Space). */
  onPauseToggle(paused: boolean): void;
  /** Called when the motor speed slider moves while a joint is selected. */
  onMotorSpeedChange(speed: number): void;
  /** Called when the angular range slider moves while a pin / revolute is selected (degrees). */
  onMotorRangeChange(degrees: number): void;
  /** Called when the Static / Dynamic / Kinematic control is used on the current selection. */
  onBodyTypeChange(type: BodyType): void;
  onMassChange(mass: number): void;
  /** Linear velocity in pixels per second. */
  onVelocityChange(vxPx: number, vyPx: number): void;
  /** Angular velocity in degrees per second. */
  onSpinChange(degPerSec: number): void;
  onColorChange(color: string): void;
}

export interface Ui {
  getSelectedShape(): ShapeType;
  getActiveTool(): ActiveTool;
  /**
   * Show (or hide, when null) the readout for the current selection. `members` is every selected
   * shape; more than one means a jointed group.
   */
  showSelectionInfo(body: Body | null, members?: readonly Body[]): void;
  /** Show (or hide, when null) the motor slider for the currently selected joint. */
  showMotorInfo(joint: Joint | null): void;
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

export function setupUi({
  onGravityChange,
  onBackgroundChange,
  onPauseToggle,
  onMotorSpeedChange,
  onMotorRangeChange,
  onBodyTypeChange,
  onMassChange,
  onVelocityChange,
  onSpinChange,
  onColorChange,
}: UiOptions): Ui {
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

  // Help modal
  const helpDialog = requireElement<HTMLDialogElement>("help-dialog");
  const helpOpen = requireElement<HTMLButtonElement>("help-open");
  const helpClose = requireElement<HTMLButtonElement>("help-close");
  helpOpen.addEventListener("click", () => helpDialog.showModal());
  helpClose.addEventListener("click", () => helpDialog.close());
  // A click on the backdrop lands on the dialog element itself, outside the inner panel.
  helpDialog.addEventListener("click", (event) => {
    if (event.target === helpDialog) helpDialog.close();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    // Space belongs to the modal while it is open (e.g. activating its Close button).
    if (helpDialog.open) return;
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
  const selectionAngle = requireElement<HTMLElement>("selection-angle");
  const selectionMass = requireElement<HTMLInputElement>("selection-mass");
  const selectionVx = requireElement<HTMLInputElement>("selection-vx");
  const selectionVy = requireElement<HTMLInputElement>("selection-vy");
  const selectionSpin = requireElement<HTMLInputElement>("selection-spin");
  const selectionColor = requireElement<HTMLInputElement>("selection-color");
  const bodyTypeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#body-type [data-body-type]"),
  );

  function isBodyType(value: string | undefined): value is BodyType {
    return value === "static" || value === "dynamic" || value === "kinematic";
  }

  function syncBodyTypeButtons(members: readonly Body[]): void {
    const types = new Set(members.map((body) => body.getType()));
    const shared = types.size === 1 ? [...types][0] : null;
    for (const button of bodyTypeButtons) {
      button.classList.toggle("is-active", button.dataset.bodyType === shared);
    }
  }

  function setIfUnfocused(input: HTMLInputElement, value: string): void {
    if (document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  function toColorInput(value: string): string {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "#888888";
  }

  for (const button of bodyTypeButtons) {
    button.addEventListener("click", () => {
      const type = button.dataset.bodyType;
      if (!isBodyType(type)) return;
      onBodyTypeChange(type);
      button.blur();
    });
  }

  selectionMass.addEventListener("input", () => {
    const mass = Number(selectionMass.value);
    if (!Number.isFinite(mass)) return;
    onMassChange(Math.max(0.01, mass));
  });

  function emitVelocity(): void {
    const vx = Number(selectionVx.value);
    const vy = Number(selectionVy.value);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
    onVelocityChange(vx, vy);
  }
  selectionVx.addEventListener("input", emitVelocity);
  selectionVy.addEventListener("input", emitVelocity);

  selectionSpin.addEventListener("input", () => {
    const spin = Number(selectionSpin.value);
    if (!Number.isFinite(spin)) return;
    onSpinChange(spin);
  });

  selectionColor.addEventListener("input", () => onColorChange(selectionColor.value));

  function showSelectionInfo(body: Body | null, members: readonly Body[] = body ? [body] : []): void {
    if (!body || members.length === 0) {
      selectionInfo.hidden = true;
      return;
    }
    const isGroup = members.length > 1;
    const { min, max } = isGroup ? groupBoundsPx([...members]) : bodyBoundsPx(body);
    const width = max.x - min.x;
    const height = max.y - min.y;
    selectionInfo.hidden = false;
    selectionShape.textContent = isGroup ? `Group (${members.length} shapes)` : bodyLabel(body);
    selectionSize.textContent = `${Math.round(width)} x ${Math.round(height)} px`;
    const degrees = (((body.getAngle() * 180) / Math.PI) % 360 + 360) % 360;
    selectionAngle.textContent = `${Math.round(degrees)}\u00B0`;
    syncBodyTypeButtons(members);

    selectionMass.disabled = !members.some((member) => member.getType() === "dynamic");
    setIfUnfocused(selectionMass, body.getMass().toFixed(2));
    const vel = body.getLinearVelocity();
    setIfUnfocused(selectionVx, toPixels(vel.x).toFixed(1));
    setIfUnfocused(selectionVy, toPixels(vel.y).toFixed(1));
    setIfUnfocused(selectionSpin, ((body.getAngularVelocity() * 180) / Math.PI).toFixed(1));
    if (document.activeElement !== selectionColor) {
      const fill = getBodyData(body)?.fillStyle ?? "#888888";
      const hex = toColorInput(fill);
      if (selectionColor.value !== hex) selectionColor.value = hex;
    }
  }

  // Selected joint motor
  const motorInfo = requireElement<HTMLDivElement>("motor-info");
  const motorKind = requireElement<HTMLElement>("motor-kind");
  const motorSpeed = requireElement<HTMLInputElement>("motor-speed");
  const motorSpeedValue = requireElement<HTMLOutputElement>("motor-speed-value");
  const motorRangeRow = requireElement<HTMLLabelElement>("motor-range-row");
  const motorRange = requireElement<HTMLInputElement>("motor-range");
  const motorRangeValue = requireElement<HTMLOutputElement>("motor-range-value");

  function showMotorSpeed(speed: number): void {
    motorSpeed.value = String(speed);
    motorSpeedValue.textContent = speed.toFixed(2);
  }

  function showMotorRange(degrees: number): void {
    motorRange.value = String(degrees);
    motorRangeValue.textContent = `${Math.round(degrees)}\u00B0`;
  }

  function showMotorInfo(joint: Joint | null): void {
    if (!joint) {
      motorInfo.hidden = true;
      return;
    }
    const data = joint.getUserData() as JointUserData | undefined;
    if (!data || !isMotorJoint(data.kind)) {
      motorInfo.hidden = true;
      return;
    }
    motorInfo.hidden = false;
    motorKind.textContent = motorJointLabel(data.kind);
    showMotorSpeed(getMotorSpeed(joint));
    // Wheels cannot be angle-limited in Planck, so only pin / revolute get the Range row.
    motorRangeRow.hidden = !hasAngleLimit(joint);
    showMotorRange(getAngleRangeDeg(joint));
  }

  motorSpeed.addEventListener("input", () => {
    const speed = parseFloat(motorSpeed.value);
    showMotorSpeed(speed);
    onMotorSpeedChange(speed);
  });

  motorRange.addEventListener("input", () => {
    const degrees = parseFloat(motorRange.value);
    showMotorRange(degrees);
    onMotorRangeChange(degrees);
  });

  return {
    getSelectedShape: () => selectedShape,
    getActiveTool: () => activeTool,
    showSelectionInfo,
    showMotorInfo,
    setPaused,
  };
}
