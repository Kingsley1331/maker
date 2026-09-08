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
import { bodyBoundsPx, MAX_ZOOM, MIN_ZOOM } from "./physics";
import {
  DEFAULT_FILL,
  DEFAULT_WALL_THICKNESS,
  getBodyData,
  getBodyRestitution,
  isPrimitiveShape,
  MIN_WALL_THICKNESS,
  SHAPE_TYPES,
  type JointUserData,
  type ShapeType,
} from "./shapes";
import { FRICTION, LINEAR_DAMPING, RESTITUTION, toPixels } from "./units";

export type ActiveTool =
  | { kind: "shape"; shape: ShapeType }
  | { kind: "joint"; joint: JointType }
  | { kind: "zoom" };

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
  onElasticityChange(value: number): void;
  onSelectionElasticityChange(value: number): void;
  onAirDragChange(value: number): void;
  onFrictionChange(value: number): void;
  /** Linear velocity in pixels per second. */
  onVelocityChange(vxPx: number, vyPx: number): void;
  /** Angular velocity in degrees per second. */
  onSpinChange(degPerSec: number): void;
  onColorChange(color: string): void;
  /** View zoom. 1 is identity; the slider and keyboard omit a cursor anchor. */
  onZoomChange(zoom: number): void;
  /** Fired when the shape, joint, or zoom tool changes. */
  onToolChange(tool: ActiveTool): void;
  /** Delete the current body/group or selected joint (paused only). */
  onDeleteSelection(): void;
  /** Duplicate the current body/group (paused only). */
  onDuplicateSelection(): void;
}

export interface SpraySample {
  size: number;
  fillStyle: string;
  angleDeg: number;
  mass: number;
  vxPx: number;
  vyPx: number;
  spinDeg: number;
}

export interface Ui {
  getSelectedShape(): ShapeType;
  getActiveTool(): ActiveTool;
  /** True when Spray is on and a primitive shape is the active tool. */
  isSpray(): boolean;
  /** One stamp's properties (defaults, or a random roll inside each Rand range). */
  getSpraySample(): SpraySample;
  /** Size default used for spray spacing (not a random roll). */
  getSpraySize(): number;
  /** Wall thickness in px for the four-sided frame tool. */
  getWallThickness(): number;
  /**
   * Show (or hide, when null) the readout for the current selection. `members` is every selected
   * shape; more than one means a jointed group.
   */
  showSelectionInfo(body: Body | null, members?: readonly Body[]): void;
  /** Show (or hide, when null) the motor slider for the currently selected joint. */
  showMotorInfo(joint: Joint | null): void;
  /** Reflect the current paused state on the toggle button. */
  setPaused(paused: boolean): void;
  /** Keep the Zoom slider in sync with wheel / other non-slider changes. */
  setZoom(zoom: number): void;
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
  onElasticityChange,
  onSelectionElasticityChange,
  onAirDragChange,
  onFrictionChange,
  onVelocityChange,
  onSpinChange,
  onColorChange,
  onZoomChange,
  onToolChange,
  onDeleteSelection,
  onDuplicateSelection,
}: UiOptions): Ui {
  let selectedShape: ShapeType = "circle";
  let activeTool: ActiveTool = { kind: "shape", shape: selectedShape };
  let spray = false;

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

  // Zoom
  const zoomInput = requireElement<HTMLInputElement>("zoom");
  const zoomValue = requireElement<HTMLOutputElement>("zoom-value");

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  function showZoom(value: number): void {
    const z = clampZoom(value);
    if (zoomInput.value !== String(z)) zoomInput.value = String(z);
    zoomValue.textContent = `${Math.round(z * 100)}%`;
  }

  function nudgeZoom(factor: number): void {
    const next = clampZoom(parseFloat(zoomInput.value) * factor);
    showZoom(next);
    onZoomChange(next);
  }

  zoomInput.addEventListener("input", () => {
    if (activeTool.kind !== "zoom") return;
    const z = parseFloat(zoomInput.value);
    showZoom(z);
    onZoomChange(z);
  });
  showZoom(1);

  window.addEventListener("keydown", (event) => {
    if (helpDialog.open) return;
    // Don't hijack keys when a form control has focus (a focused button already clicks on Space).
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;

    if (event.code === "Space") {
      if (event.repeat) return;
      event.preventDefault();
      onPauseToggle(!paused);
      return;
    }

    if (event.key === "=" || event.key === "+") {
      if (activeTool.kind !== "zoom") return;
      event.preventDefault();
      nudgeZoom(1.1);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      if (activeTool.kind !== "zoom") return;
      event.preventDefault();
      nudgeZoom(1 / 1.1);
      return;
    }
    if (event.key === "0") {
      if (activeTool.kind !== "zoom") return;
      event.preventDefault();
      showZoom(1);
      onZoomChange(1);
      return;
    }

    if (!paused) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDeleteSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      onDuplicateSelection();
    }
  });

  // Shape / joint tools (mutually exclusive)
  const zoomTool = requireElement<HTMLButtonElement>("zoom-tool");
  const sprayToggle = requireElement<HTMLButtonElement>("spray-toggle");
  const shapeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".shape-btn[data-shape]"),
  );
  const jointButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".joint-btn[data-joint]"),
  );

  function sprayAllowed(tool: ActiveTool): boolean {
    return tool.kind === "shape" && isPrimitiveShape(tool.shape);
  }

  function isSpray(): boolean {
    return spray && sprayAllowed(activeTool);
  }

  const sprayInfo = requireElement<HTMLDivElement>("spray-info");
  const sprayOptions = requireElement<HTMLDivElement>("spray-options");
  const sprayOptionsToggle = requireElement<HTMLButtonElement>("spray-options-toggle");
  let sprayOptionsOpen = false;

  function syncSprayOptions(): void {
    sprayOptions.hidden = !sprayOptionsOpen;
    sprayOptionsToggle.setAttribute("aria-expanded", String(sprayOptionsOpen));
  }

  function syncSpray(): void {
    const allowed = sprayAllowed(activeTool);
    if (!allowed) spray = false;
    const on = isSpray();
    sprayToggle.disabled = !allowed;
    sprayToggle.classList.toggle("is-active", on);
    sprayToggle.setAttribute("aria-pressed", String(on));
    sprayInfo.hidden = !on;
    if (!on) sprayOptionsOpen = false;
    syncSprayOptions();
  }

  sprayOptionsToggle.addEventListener("click", () => {
    sprayOptionsOpen = !sprayOptionsOpen;
    syncSprayOptions();
  });

  function setActiveTool(tool: ActiveTool): void {
    activeTool = tool;
    if (!sprayAllowed(tool)) spray = false;
    syncToolButtons();
    syncSpray();
    syncFrameInfo();
    onToolChange(tool);
  }

  function syncToolButtons(): void {
    const zoomOn = activeTool.kind === "zoom";
    zoomTool.classList.toggle("is-active", zoomOn);
    zoomTool.setAttribute("aria-pressed", String(zoomOn));
    zoomInput.disabled = !zoomOn;
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

  zoomTool.addEventListener("click", () => setActiveTool({ kind: "zoom" }));

  sprayToggle.addEventListener("click", () => {
    if (!sprayAllowed(activeTool)) return;
    spray = !spray;
    syncSpray();
  });

  for (const button of shapeButtons) {
    button.addEventListener("click", () => {
      const shape = button.dataset.shape;
      if (!isShapeType(shape)) return;
      selectedShape = shape;
      setActiveTool({ kind: "shape", shape });
    });
  }

  for (const button of jointButtons) {
    button.addEventListener("click", () => {
      const joint = button.dataset.joint;
      if (!isJointType(joint)) return;
      setActiveTool({ kind: "joint", joint });
    });
  }
  syncSpray();

  function parseFinite(input: HTMLInputElement, fallback: number): number {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function sampleRange(
    value: HTMLInputElement,
    rand: HTMLInputElement,
    min: HTMLInputElement,
    max: HTMLInputElement,
    fallback: number,
  ): number {
    if (!rand.checked) return parseFinite(value, fallback);
    let a = parseFinite(min, fallback);
    let b = parseFinite(max, fallback);
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    return a + Math.random() * (b - a);
  }

  function bindRand(rand: HTMLInputElement, ...inputs: HTMLInputElement[]): void {
    const sync = (): void => {
      for (const input of inputs) input.disabled = !rand.checked;
    };
    rand.addEventListener("change", sync);
    sync();
  }

  function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function hue2rgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hk = h / 360;
    const r = Math.round(hue2rgb(p, q, hk + 1 / 3) * 255);
    const g = Math.round(hue2rgb(p, q, hk) * 255);
    const b = Math.round(hue2rgb(p, q, hk - 1 / 3) * 255);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  function mixHex(a: string, b: string, t: number): string {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    if (!ca || !cb) return a;
    const ha = rgbToHsl(ca.r, ca.g, ca.b);
    const hb = rgbToHsl(cb.r, cb.g, cb.b);
    let dh = hb.h - ha.h;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    return hslToHex(ha.h + dh * t, ha.s + (hb.s - ha.s) * t, ha.l + (hb.l - ha.l) * t);
  }

  const spraySize = requireElement<HTMLInputElement>("spray-size");
  const spraySizeRand = requireElement<HTMLInputElement>("spray-size-rand");
  const spraySizeMin = requireElement<HTMLInputElement>("spray-size-min");
  const spraySizeMax = requireElement<HTMLInputElement>("spray-size-max");
  const sprayColor = requireElement<HTMLInputElement>("spray-color");
  const sprayColorRand = requireElement<HTMLInputElement>("spray-color-rand");
  const sprayColorB = requireElement<HTMLInputElement>("spray-color-b");
  const sprayAngle = requireElement<HTMLInputElement>("spray-angle");
  const sprayAngleRand = requireElement<HTMLInputElement>("spray-angle-rand");
  const sprayAngleMin = requireElement<HTMLInputElement>("spray-angle-min");
  const sprayAngleMax = requireElement<HTMLInputElement>("spray-angle-max");
  const sprayMass = requireElement<HTMLInputElement>("spray-mass");
  const sprayMassRand = requireElement<HTMLInputElement>("spray-mass-rand");
  const sprayMassMin = requireElement<HTMLInputElement>("spray-mass-min");
  const sprayMassMax = requireElement<HTMLInputElement>("spray-mass-max");
  const sprayVx = requireElement<HTMLInputElement>("spray-vx");
  const sprayVxRand = requireElement<HTMLInputElement>("spray-vx-rand");
  const sprayVxMin = requireElement<HTMLInputElement>("spray-vx-min");
  const sprayVxMax = requireElement<HTMLInputElement>("spray-vx-max");
  const sprayVy = requireElement<HTMLInputElement>("spray-vy");
  const sprayVyRand = requireElement<HTMLInputElement>("spray-vy-rand");
  const sprayVyMin = requireElement<HTMLInputElement>("spray-vy-min");
  const sprayVyMax = requireElement<HTMLInputElement>("spray-vy-max");
  const spraySpin = requireElement<HTMLInputElement>("spray-spin");
  const spraySpinRand = requireElement<HTMLInputElement>("spray-spin-rand");
  const spraySpinMin = requireElement<HTMLInputElement>("spray-spin-min");
  const spraySpinMax = requireElement<HTMLInputElement>("spray-spin-max");

  bindRand(spraySizeRand, spraySizeMin, spraySizeMax);
  bindRand(sprayColorRand, sprayColorB);
  bindRand(sprayAngleRand, sprayAngleMin, sprayAngleMax);
  bindRand(sprayMassRand, sprayMassMin, sprayMassMax);
  bindRand(sprayVxRand, sprayVxMin, sprayVxMax);
  bindRand(sprayVyRand, sprayVyMin, sprayVyMax);
  bindRand(spraySpinRand, spraySpinMin, spraySpinMax);

  function getSpraySize(): number {
    return Math.max(1, parseFinite(spraySize, 6));
  }

  const frameInfo = requireElement<HTMLDivElement>("frame-info");
  const wallThickness = requireElement<HTMLInputElement>("wall-thickness");

  function syncFrameInfo(): void {
    frameInfo.hidden = !(activeTool.kind === "shape" && activeTool.shape === "frame");
  }

  function getWallThickness(): number {
    return Math.max(MIN_WALL_THICKNESS, parseFinite(wallThickness, DEFAULT_WALL_THICKNESS));
  }

  syncFrameInfo();

  function getSpraySample(): SpraySample {
    const a = /^#[0-9a-fA-F]{6}$/.test(sprayColor.value) ? sprayColor.value : DEFAULT_FILL;
    const b = /^#[0-9a-fA-F]{6}$/.test(sprayColorB.value) ? sprayColorB.value : a;
    return {
      size: Math.max(1, sampleRange(spraySize, spraySizeRand, spraySizeMin, spraySizeMax, 6)),
      fillStyle: sprayColorRand.checked ? mixHex(a, b, Math.random()) : a,
      angleDeg: sampleRange(sprayAngle, sprayAngleRand, sprayAngleMin, sprayAngleMax, 0),
      mass: Math.max(0.01, sampleRange(sprayMass, sprayMassRand, sprayMassMin, sprayMassMax, 0.1)),
      vxPx: sampleRange(sprayVx, sprayVxRand, sprayVxMin, sprayVxMax, 0),
      vyPx: sampleRange(sprayVy, sprayVyRand, sprayVyMin, sprayVyMax, 0),
      spinDeg: sampleRange(spraySpin, spraySpinRand, spraySpinMin, spraySpinMax, 0),
    };
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

  const elasticity = requireElement<HTMLInputElement>("elasticity");
  const elasticityValue = requireElement<HTMLOutputElement>("elasticity-value");

  function applyElasticity(): void {
    const value = Number(elasticity.value);
    const r = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : RESTITUTION;
    elasticityValue.textContent = r.toFixed(2);
    onElasticityChange(r);
  }

  elasticity.addEventListener("input", applyElasticity);
  applyElasticity();

  const airDrag = requireElement<HTMLInputElement>("air-drag");
  const airDragValue = requireElement<HTMLOutputElement>("air-drag-value");

  function applyAirDrag(): void {
    const value = Number(airDrag.value);
    const d = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : LINEAR_DAMPING;
    airDragValue.textContent = d.toFixed(2);
    onAirDragChange(d);
  }

  airDrag.addEventListener("input", applyAirDrag);
  applyAirDrag();

  const friction = requireElement<HTMLInputElement>("friction");
  const frictionValue = requireElement<HTMLOutputElement>("friction-value");

  function applyFriction(): void {
    const value = Number(friction.value);
    const mu = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : FRICTION;
    frictionValue.textContent = mu.toFixed(2);
    onFrictionChange(mu);
  }

  friction.addEventListener("input", applyFriction);
  applyFriction();

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
  const selectionElasticity = requireElement<HTMLInputElement>("selection-elasticity");
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

  selectionElasticity.addEventListener("input", () => {
    const value = Number(selectionElasticity.value);
    if (!Number.isFinite(value)) return;
    onSelectionElasticityChange(Math.min(1, Math.max(0, value)));
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

  const selectionDuplicate = requireElement<HTMLButtonElement>("selection-duplicate");
  const selectionDelete = requireElement<HTMLButtonElement>("selection-delete");
  selectionDuplicate.addEventListener("click", () => {
    onDuplicateSelection();
    selectionDuplicate.blur();
  });
  selectionDelete.addEventListener("click", () => {
    onDeleteSelection();
    selectionDelete.blur();
  });

  const motorDelete = requireElement<HTMLButtonElement>("motor-delete");
  motorDelete.addEventListener("click", () => {
    onDeleteSelection();
    motorDelete.blur();
  });

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
    setIfUnfocused(selectionElasticity, getBodyRestitution(body).toFixed(2));
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
    isSpray,
    getSpraySample,
    getSpraySize,
    getWallThickness,
    showSelectionInfo,
    showMotorInfo,
    setPaused,
    setZoom: showZoom,
  };
}
