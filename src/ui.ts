import type { Body, BodyType, Joint } from "planck";
import {
  ANGLE_START_MAX_DEG,
  ANGLE_START_MIN_DEG,
  FULL_RANGE_DEG,
  FULL_TRAVEL_PX,
  getAngleRangeDeg,
  getAngleStartDeg,
  getJointDamping,
  getJointFrequency,
  getMotorSpeed,
  getTravelRangePx,
  hasAngleLimit,
  hasSpring,
  hasTravelLimit,
  isMotorJoint,
  jointKindLabel,
  JOINT_TYPES,
  MAX_SPRING_HZ,
  type JointType,
} from "./joints";
import { bodyLabel, groupBoundsPx } from "./group";
import { bodyBoundsPx, MAX_ZOOM, MIN_ZOOM } from "./physics";
import {
  DEFAULT_FILL,
  DEFAULT_INNER_RADIUS,
  DEFAULT_PHASE_SECONDS,
  DEFAULT_SCHEDULE,
  DEFAULT_SECTOR_DEG,
  DEFAULT_STREAM,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WIND,
  clampInnerRadius,
  clampSectorDeg,
  getBodyData,
  getBodyRestitution,
  isPrimitiveShape,
  MAX_INNER_RADIUS,
  MIN_WALL_THICKNESS,
  SHAPE_TYPES,
  tracePreview,
  type DirectionalForce,
  type JointUserData,
  type ParticleStream,
  type PhaseKind,
  type Schedule,
  type Scheduled,
  type SchedulePhase,
  type ShapeType,
} from "./shapes";
import { FRICTION, LINEAR_DAMPING, RESTITUTION, toPixels } from "./units";

export type ActiveTool =
  | { kind: "none" }
  | { kind: "shape"; shape: ShapeType }
  | { kind: "joint"; joint: JointType }
  | { kind: "zoom" };

export interface UiOptions {
  onGravityChange(x: number, y: number): void;
  onBackgroundChange(color: string): void;
  /** Called when the wrap-edges checkbox is toggled. */
  onWrapChange(wrap: boolean): void;
  /** Called with the requested state when the user toggles Pause/Play (button or Space). */
  onPauseToggle(paused: boolean): void;
  /** Advance the simulation by one physics step (paused only). */
  onStep(): void;
  /** Called when the motor speed slider moves while a joint is selected. */
  onMotorSpeedChange(speed: number): void;
  /**
   * Called when the range slider moves while a limitable joint is selected: degrees for a
   * pin / revolute, pixels of travel for a slider.
   */
  onMotorRangeChange(value: number): void;
  /** Called when the Start slider moves on a pin / revolute with a limited range. */
  onMotorStartChange(startDeg: number): void;
  /** Called when the slider Collide checkbox is toggled. */
  onSliderCollideChange(collide: boolean): void;
  /** Called when the rod / weld stiffness slider moves (Hz; 0 is rigid). */
  onJointStiffnessChange(hz: number): void;
  /** Called when the rod / weld damping slider moves. */
  onJointDampingChange(ratio: number): void;
  /** Called when the Static / Dynamic / Kinematic control is used on the current selection. */
  onBodyTypeChange(type: BodyType): void;
  /** Called when the No Collisions checkbox is toggled on the current selection. */
  onWallsOnlyChange(enabled: boolean): void;
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
  /**
   * Called when a particle stream is added, edited, or removed on the current selection. `stream`
   * replaces the entry at `index` (appending when `index` equals the list length); null removes
   * it.
   */
  onStreamChange(index: number, stream: ParticleStream | null): void;
  /**
   * Called when a directional force is added, edited, or removed on the current selection. `wind`
   * replaces the entry at `index` (appending when `index` equals the list length); null removes
   * it.
   */
  onWindChange(index: number, wind: DirectionalForce | null): void;
  /** View zoom. 1 is identity; the slider and keyboard omit a cursor anchor. */
  onZoomChange(zoom: number): void;
  /** Fired when the shape, joint, or zoom tool changes. */
  onToolChange(tool: ActiveTool): void;
  /** Delete the current body/group or selected joint (paused only). */
  onDeleteSelection(): void;
  /** Duplicate the current body/group (paused only). */
  onDuplicateSelection(): void;
  /** Union overlapping/touching filled shapes into the selected body (paused only). */
  onMergeSelection(): void;
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

/** Toolbar-wide simulation settings (slider / colour values, not physics units). */
export interface WorldSettings {
  gravityX: number;
  gravityY: number;
  elasticity: number;
  airDrag: number;
  friction: number;
  background: string;
  wrap: boolean;
}

export interface Ui {
  getSelectedShape(): ShapeType;
  /** Current values of the global sliders and background colour. */
  getSettings(): WorldSettings;
  /** Write the global sliders / background and push the values to the simulation. */
  setSettings(settings: WorldSettings): void;
  /** Restore the global sliders / background to their markup defaults. */
  resetSettings(): void;
  getActiveTool(): ActiveTool;
  /** True when Spray is on and a primitive shape is the active tool. */
  isSpray(): boolean;
  /** True when Cut is on and a filled spawn shape is the active tool. */
  isCut(): boolean;
  /** Turn Cut on or off. Turning it on clears Spray and Chain. */
  setCut(on: boolean): void;
  /** True when Chain outline is on and a filled spawn shape is the active tool. */
  isChainOutline(): boolean;
  /** One stamp's properties (defaults, or a random roll inside each Rand range). */
  getSpraySample(): SpraySample;
  /** Size default used for spray spacing (not a random roll). */
  getSpraySize(): number;
  /** Wall thickness in px for the four-sided frame tool. */
  getWallThickness(): number;
  /** Sector sweep in degrees for the circle-sector tool. */
  getSectorDeg(): number;
  /** Inner radius as a fraction of the outer radius for the circle-sector tool. */
  getInnerRadius(): number;
  /**
   * Show (or hide, when null) the readout for the current selection. `members` is every selected
   * shape; more than one means a jointed group. `mergeEnabled` lights up Merge when another filled
   * shape overlaps or touches the selection.
   */
  showSelectionInfo(body: Body | null, members?: readonly Body[], mergeEnabled?: boolean): void;
  /** Show (or hide, when null) the motor slider for the currently selected joint. */
  showMotorInfo(joint: Joint | null): void;
  /** Switch the active shape / joint / zoom tool (or none). */
  setActiveTool(tool: ActiveTool): void;
  /** Reflect the current paused state on the toggle button. */
  setPaused(paused: boolean): void;
  /** Update the canvas HUD step count and simulated time. */
  setClock(steps: number, seconds: number): void;
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

/** Activate on press so toolbar buttons still work if `click` is suppressed. */
function bindActivate(button: HTMLElement, handler: () => void): void {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handler();
  });
}

export function setupUi({
  onGravityChange,
  onBackgroundChange,
  onWrapChange,
  onPauseToggle,
  onStep,
  onMotorSpeedChange,
  onMotorRangeChange,
  onMotorStartChange,
  onSliderCollideChange,
  onJointStiffnessChange,
  onJointDampingChange,
  onBodyTypeChange,
  onWallsOnlyChange,
  onMassChange,
  onElasticityChange,
  onSelectionElasticityChange,
  onAirDragChange,
  onFrictionChange,
  onVelocityChange,
  onSpinChange,
  onColorChange,
  onStreamChange,
  onWindChange,
  onZoomChange,
  onToolChange,
  onDeleteSelection,
  onDuplicateSelection,
  onMergeSelection,
}: UiOptions): Ui {
  let selectedShape: ShapeType = "circle";
  let activeTool: ActiveTool = { kind: "shape", shape: selectedShape };
  let spray = false;
  let cut = false;
  let chain = false;

  // Pause / Play
  let paused = false;
  const pauseButton = requireElement<HTMLButtonElement>("pause-toggle");
  const clockToggle = requireElement<HTMLButtonElement>("clock-toggle");
  const simHud = requireElement<HTMLDivElement>("sim-hud");
  const hudSteps = requireElement<HTMLElement>("hud-steps");
  const hudTime = requireElement<HTMLElement>("hud-time");
  const hudPause = requireElement<HTMLButtonElement>("hud-pause");
  const hudStep = requireElement<HTMLButtonElement>("hud-step");

  function setPaused(value: boolean): void {
    paused = value;
    pauseButton.textContent = paused ? "Play" : "Pause";
    pauseButton.setAttribute("aria-pressed", String(paused));
    pauseButton.classList.toggle("is-paused", paused);
    hudPause.classList.toggle("is-paused", paused);
    hudPause.setAttribute("aria-label", paused ? "Play" : "Pause");
    hudStep.hidden = !paused;
    if (!paused && activeTool.kind === "joint") setActiveTool({ kind: "none" });
    else syncToolButtons();
  }

  bindActivate(pauseButton, () => onPauseToggle(!paused));
  bindActivate(hudPause, () => onPauseToggle(!paused));
  bindActivate(hudStep, () => onStep());

  function setClockVisible(visible: boolean): void {
    simHud.hidden = !visible;
    clockToggle.classList.toggle("is-active", visible);
    clockToggle.setAttribute("aria-pressed", String(visible));
    clockToggle.title = visible ? "Hide step counter" : "Show step counter";
    clockToggle.setAttribute("aria-label", clockToggle.title);
  }

  bindActivate(clockToggle, () => setClockVisible(simHud.hidden));

  function setClock(steps: number, seconds: number): void {
    if (simHud.hidden) return;
    const stepText = String(steps);
    const timeText = seconds.toFixed(2);
    if (hudSteps.textContent !== stepText) hudSteps.textContent = stepText;
    if (hudTime.textContent !== timeText) hudTime.textContent = timeText;
  }

  // Help modal
  const helpDialog = requireElement<HTMLDialogElement>("help-dialog");
  const helpOpen = requireElement<HTMLButtonElement>("help-open");
  const helpClose = requireElement<HTMLButtonElement>("help-close");
  bindActivate(helpOpen, () => helpDialog.showModal());
  bindActivate(helpClose, () => helpDialog.close());
  // A click on the backdrop lands on the dialog element itself, outside the inner panel.
  helpDialog.addEventListener("click", (event) => {
    if (event.target === helpDialog) helpDialog.close();
  });

  // Zoom
  const zoomInput = requireElement<HTMLInputElement>("zoom");
  const zoomValue = requireElement<HTMLOutputElement>("zoom-value");
  const zoomRow = requireElement<HTMLLabelElement>("zoom-row");

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
  const cutToggle = requireElement<HTMLButtonElement>("cut-toggle");
  const chainToggle = requireElement<HTMLButtonElement>("chain-toggle");
  const shapeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".shape-btn[data-shape]"),
  );
  const jointButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".joint-btn[data-joint]"),
  );

  function sprayAllowed(tool: ActiveTool): boolean {
    return tool.kind === "shape" && isPrimitiveShape(tool.shape);
  }

  function cutAllowed(tool: ActiveTool): boolean {
    return (
      tool.kind === "shape" &&
      (isPrimitiveShape(tool.shape) || tool.shape === "box" || tool.shape === "polygon")
    );
  }

  function chainAllowed(tool: ActiveTool): boolean {
    return cutAllowed(tool);
  }

  function isSpray(): boolean {
    return spray && sprayAllowed(activeTool);
  }

  function isCut(): boolean {
    return cut && cutAllowed(activeTool);
  }

  function setCut(on: boolean): void {
    if (on) {
      if (!cutAllowed(activeTool)) return;
      cut = true;
      spray = false;
      chain = false;
    } else {
      cut = false;
    }
    syncSpray();
    syncCut();
    syncChain();
  }

  function isChainOutline(): boolean {
    return chain && chainAllowed(activeTool);
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

  function syncCut(): void {
    const allowed = cutAllowed(activeTool);
    const on = isCut();
    cutToggle.disabled = !allowed;
    cutToggle.classList.toggle("is-active", on);
    cutToggle.setAttribute("aria-pressed", String(on));
  }

  function syncChain(): void {
    const allowed = chainAllowed(activeTool);
    if (!allowed) chain = false;
    const on = isChainOutline();
    chainToggle.disabled = !allowed;
    chainToggle.classList.toggle("is-active", on);
    chainToggle.setAttribute("aria-pressed", String(on));
  }

  bindActivate(sprayOptionsToggle, () => {
    sprayOptionsOpen = !sprayOptionsOpen;
    syncSprayOptions();
  });

  function setActiveTool(tool: ActiveTool): void {
    if (tool.kind === "joint" && !paused) return;
    activeTool = tool;
    if (!sprayAllowed(tool)) spray = false;
    if (!chainAllowed(tool)) chain = false;
    syncToolButtons();
    syncSpray();
    syncCut();
    syncChain();
    syncFrameInfo();
    syncSectorInfo();
    onToolChange(tool);
  }

  function syncToolButtons(): void {
    const zoomOn = activeTool.kind === "zoom";
    zoomTool.classList.toggle("is-active", zoomOn);
    zoomTool.setAttribute("aria-pressed", String(zoomOn));
    zoomRow.hidden = !zoomOn;
    zoomInput.disabled = !zoomOn;
    for (const button of shapeButtons) {
      button.classList.toggle(
        "is-active",
        activeTool.kind === "shape" && button.dataset.shape === activeTool.shape,
      );
    }
    for (const button of jointButtons) {
      button.disabled = !paused;
      button.classList.toggle(
        "is-active",
        paused && activeTool.kind === "joint" && button.dataset.joint === activeTool.joint,
      );
    }
  }

  bindActivate(zoomTool, () => {
    if (activeTool.kind === "zoom") {
      setActiveTool({ kind: "none" });
      return;
    }
    setActiveTool({ kind: "zoom" });
  });

  const settingsToggle = requireElement<HTMLButtonElement>("settings-toggle");
  const worldSettings = requireElement<HTMLDivElement>("world-settings");

  function setSettingsOpen(open: boolean): void {
    worldSettings.hidden = !open;
    settingsToggle.classList.toggle("is-active", open);
    settingsToggle.setAttribute("aria-pressed", String(open));
    settingsToggle.setAttribute("aria-expanded", String(open));
    settingsToggle.title = open ? "Hide world settings" : "World settings";
    settingsToggle.setAttribute("aria-label", settingsToggle.title);
  }

  bindActivate(settingsToggle, () => setSettingsOpen(worldSettings.hidden));

  bindActivate(sprayToggle, () => {
    if (!sprayAllowed(activeTool)) return;
    spray = !spray;
    if (spray) {
      cut = false;
      chain = false;
    }
    syncSpray();
    syncCut();
    syncChain();
  });

  bindActivate(cutToggle, () => {
    if (!cutAllowed(activeTool)) return;
    cut = !cut;
    if (cut) {
      spray = false;
      chain = false;
    }
    syncSpray();
    syncCut();
    syncChain();
  });

  bindActivate(chainToggle, () => {
    if (!chainAllowed(activeTool)) return;
    chain = !chain;
    if (chain) {
      spray = false;
      cut = false;
    }
    syncSpray();
    syncCut();
    syncChain();
  });

  for (const button of shapeButtons) {
    bindActivate(button, () => {
      const shape = button.dataset.shape;
      if (!isShapeType(shape)) return;
      if (activeTool.kind === "shape" && activeTool.shape === shape) {
        setActiveTool({ kind: "none" });
        return;
      }
      selectedShape = shape;
      setActiveTool({ kind: "shape", shape });
    });
  }

  for (const button of jointButtons) {
    bindActivate(button, () => {
      if (!paused) return;
      const joint = button.dataset.joint;
      if (!isJointType(joint)) return;
      if (activeTool.kind === "joint" && activeTool.joint === joint) {
        setActiveTool({ kind: "none" });
        return;
      }
      setActiveTool({ kind: "joint", joint });
    });
  }
  syncSpray();
  syncCut();
  syncChain();

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

  const sectorInfo = requireElement<HTMLDivElement>("sector-info");
  const sectorDeg = requireElement<HTMLInputElement>("sector-deg");
  const sectorDegValue = requireElement<HTMLOutputElement>("sector-deg-value");
  const sectorInner = requireElement<HTMLInputElement>("sector-inner");
  const sectorInnerValue = requireElement<HTMLOutputElement>("sector-inner-value");
  const sectorPreview = requireElement<HTMLCanvasElement>("sector-preview");
  const sectorPreviewCtx = sectorPreview.getContext("2d");

  /** Redraw the panel thumbnail from the current slider values. */
  function drawSectorPreview(): void {
    const ctx = sectorPreviewCtx;
    if (!ctx) return;
    const cssW = sectorPreview.clientWidth || sectorPreview.width;
    const cssH = sectorPreview.clientHeight || sectorPreview.height;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (sectorPreview.width !== pxW || sectorPreview.height !== pxH) {
      sectorPreview.width = pxW;
      sectorPreview.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    tracePreview(ctx, {
      type: "sector",
      x: cssW / 2,
      y: cssH / 2,
      size: Math.min(cssW, cssH) * 0.4,
      fillStyle: DEFAULT_FILL,
      sectorDeg: getSectorDeg(),
      innerRatio: getInnerRadius(),
    });
    ctx.fillStyle = DEFAULT_FILL;
    ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  function syncSectorInfo(): void {
    const show = activeTool.kind === "shape" && activeTool.shape === "sector";
    sectorInfo.hidden = !show;
    if (show) drawSectorPreview();
  }

  function showSectorDeg(value: number): void {
    sectorDegValue.textContent = `${Math.round(value)}°`;
  }

  function showInnerRadius(value: number): void {
    sectorInnerValue.textContent = value.toFixed(2);
  }

  function getSectorDeg(): number {
    return clampSectorDeg(parseFinite(sectorDeg, DEFAULT_SECTOR_DEG));
  }

  function getInnerRadius(): number {
    return clampInnerRadius(parseFinite(sectorInner, DEFAULT_INNER_RADIUS));
  }

  function applySectorDeg(): void {
    const value = getSectorDeg();
    sectorDeg.value = String(value);
    showSectorDeg(value);
    drawSectorPreview();
  }

  function applyInnerRadius(): void {
    const value = getInnerRadius();
    sectorInner.max = String(MAX_INNER_RADIUS);
    sectorInner.value = String(value);
    showInnerRadius(value);
    drawSectorPreview();
  }

  sectorDeg.addEventListener("input", applySectorDeg);
  sectorInner.addEventListener("input", applyInnerRadius);
  applySectorDeg();
  applyInnerRadius();
  syncSectorInfo();

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

  const wrapEdges = requireElement<HTMLInputElement>("wrap-edges");
  const applyWrap = (): void => onWrapChange(wrapEdges.checked);
  wrapEdges.addEventListener("change", applyWrap);
  applyWrap();

  function applyAllSettings(): void {
    applyGravity();
    applyElasticity();
    applyAirDrag();
    applyFriction();
    applyBackground();
    applyWrap();
  }

  function getSettings(): WorldSettings {
    return {
      gravityX: parseFloat(gravityX.value),
      gravityY: parseFloat(gravityY.value),
      elasticity: parseFloat(elasticity.value),
      airDrag: parseFloat(airDrag.value),
      friction: parseFloat(friction.value),
      background: backgroundColor.value,
      wrap: wrapEdges.checked,
    };
  }

  function setSettings(settings: WorldSettings): void {
    gravityX.value = String(settings.gravityX);
    gravityY.value = String(settings.gravityY);
    elasticity.value = String(settings.elasticity);
    airDrag.value = String(settings.airDrag);
    friction.value = String(settings.friction);
    backgroundColor.value = settings.background;
    wrapEdges.checked = settings.wrap === true;
    applyAllSettings();
  }

  function resetSettings(): void {
    for (const input of [gravityX, gravityY, elasticity, airDrag, friction, backgroundColor]) {
      input.value = input.defaultValue;
    }
    wrapEdges.checked = wrapEdges.defaultChecked;
    applyAllSettings();
  }

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
  const wallsOnly = requireElement<HTMLInputElement>("walls-only");

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
    bindActivate(button, () => {
      const type = button.dataset.bodyType;
      if (!isBodyType(type)) return;
      onBodyTypeChange(type);
      button.blur();
    });
  }

  wallsOnly.addEventListener("change", () => {
    onWallsOnlyChange(wallsOnly.checked);
  });

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

  /** Numeric setting keys of a scheduled feature (everything except schedule / random flags). */
  type NumericKeys<T> = Exclude<keyof T, "schedule" | "random">;

  /** Set a checkbox unless the user is on it right now. */
  function setCheckedIfUnfocused(input: HTMLInputElement, checked: boolean): void {
    if (document.activeElement === input) return;
    if (input.checked !== checked) input.checked = checked;
  }

  /** Find a control inside a cloned feature panel by its `data-role`. */
  function requireRole<E extends HTMLElement>(root: ParentNode, role: string): E {
    const el = root.querySelector<E>(`[data-role="${role}"]`);
    if (!el) throw new Error(`Missing [data-role="${role}"] in feature template`);
    return el;
  }

  /** One feature panel's timer controls: Always on, ordered On / Off rows, a "+" menu, Loop. */
  interface ScheduleControls {
    /** Current schedule, or undefined when Always on is checked. */
    read(): Schedule | undefined;
    /** Reflect a schedule without disturbing a control being edited. */
    sync(schedule: Schedule | undefined): void;
    /** Drop the document-level listener once the panel is removed. */
    dispose(): void;
  }

  /**
   * Bind the schedule controls inside `root` (a cloned feature panel). `emit` is called whenever
   * the user changes the schedule.
   */
  function bindSchedule(root: ParentNode, emit: () => void): ScheduleControls {
    const always = requireRole<HTMLInputElement>(root, "always");
    const scheduleBox = requireRole<HTMLDivElement>(root, "schedule");
    const rowsBox = requireRole<HTMLDivElement>(root, "phases");
    const addButton = requireRole<HTMLButtonElement>(root, "add");
    const addMenu = requireRole<HTMLDivElement>(root, "add-menu");
    const addWrap = addButton.parentElement ?? addButton;
    const loop = requireRole<HTMLInputElement>(root, "loop");

    /** The UI's working copy of the schedule rows, in run order. */
    let phases: SchedulePhase[] = [];
    /** Seconds input of each rendered row, parallel to `phases`. */
    let rowInputs: HTMLInputElement[] = [];

    function readSeconds(input: HTMLInputElement): number {
      const value = Number(input.value);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function kindLabel(kind: PhaseKind): string {
      return kind === "on" ? "On" : "Off";
    }

    /** Rebuild the row elements from `phases`. */
    function renderRows(): void {
      rowsBox.replaceChildren();
      rowInputs = [];
      for (const phase of phases) {
        const row = document.createElement("div");
        row.className = "schedule-row";

        const kind = document.createElement("span");
        kind.className = "schedule-row-kind";
        kind.textContent = kindLabel(phase.kind);

        const seconds = document.createElement("input");
        seconds.type = "number";
        seconds.min = "0";
        seconds.step = "0.5";
        seconds.value = String(phase.seconds);
        seconds.title = "Seconds";
        seconds.setAttribute("aria-label", `${kindLabel(phase.kind)} for (seconds)`);
        seconds.addEventListener("input", () => {
          phase.seconds = readSeconds(seconds);
          emit();
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "schedule-row-remove";
        remove.textContent = "\u00D7";
        remove.title = "Remove phase";
        remove.setAttribute("aria-label", "Remove phase");
        remove.addEventListener("click", () => {
          const index = phases.indexOf(phase);
          if (index < 0) return;
          phases.splice(index, 1);
          renderRows();
          emit();
        });

        row.append(kind, seconds, remove);
        rowsBox.append(row);
        rowInputs.push(seconds);
      }
    }

    function setMenuOpen(open: boolean): void {
      addMenu.hidden = !open;
      addButton.setAttribute("aria-expanded", String(open));
    }

    addButton.addEventListener("click", () => setMenuOpen(addMenu.hidden));
    for (const item of addMenu.querySelectorAll<HTMLButtonElement>("[data-kind]")) {
      item.addEventListener("click", () => {
        const kind: PhaseKind = item.dataset.kind === "on" ? "on" : "off";
        phases.push({ kind, seconds: DEFAULT_PHASE_SECONDS });
        setMenuOpen(false);
        renderRows();
        const added = rowInputs[rowInputs.length - 1];
        added.focus();
        added.select();
        emit();
      });
    }
    // Pressing anywhere outside the "+" button and its menu closes the menu.
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (addMenu.hidden) return;
      if (event.target instanceof Node && addWrap.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    addWrap.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || addMenu.hidden) return;
      event.preventDefault();
      setMenuOpen(false);
      addButton.focus();
    });

    function readSchedule(): Schedule | undefined {
      if (always.checked) return undefined;
      return { phases: phases.map((p) => ({ ...p })), loop: loop.checked };
    }

    /** True when the incoming rows match the rendered ones in count and kind. */
    function sameStructure(incoming: readonly SchedulePhase[]): boolean {
      if (incoming.length !== phases.length) return false;
      return incoming.every((p, i) => p.kind === phases[i].kind);
    }

    /**
     * Reflect a schedule in the rows. Only the seconds are written when the structure matches,
     * so a live refresh never destroys the row the user is typing in.
     */
    function syncSchedule(schedule: Schedule | undefined): void {
      setCheckedIfUnfocused(always, schedule === undefined);
      scheduleBox.hidden = schedule === undefined;
      if (scheduleBox.hidden) setMenuOpen(false);
      const times = schedule ?? DEFAULT_SCHEDULE;
      if (sameStructure(times.phases)) {
        times.phases.forEach((p, i) => {
          phases[i].seconds = p.seconds;
          setIfUnfocused(rowInputs[i], String(p.seconds));
        });
      } else {
        phases = times.phases.map((p) => ({ ...p }));
        renderRows();
      }
      setCheckedIfUnfocused(loop, times.loop);
    }

    always.addEventListener("change", () => {
      scheduleBox.hidden = always.checked;
      if (!always.checked) {
        // A fresh timer starts empty: the effect stays off until a row is added.
        phases = [];
        loop.checked = false;
        renderRows();
      } else {
        setMenuOpen(false);
      }
      emit();
    });
    loop.addEventListener("change", emit);

    return {
      read: readSchedule,
      sync: syncSchedule,
      dispose: () => document.removeEventListener("pointerdown", closeOnOutsidePress),
    };
  }

  /**
   * A list of per-selection feature instances (particle streams, directional forces). The "+"
   * button `#{prefix}-add` appends one; each instance is a clone of `#{prefix}-template` placed in
   * `#{prefix}-list`, with a slider per numeric setting (found by `data-role` = key, its readout by
   * `data-role` = `{key}-value`), optional Randomise checkbox, Always on / schedule controls, and a
   * remove button.
   * `onChange(index, value)` replaces the entry at `index` (appending when `index` equals the
   * list length); `onChange(index, null)` removes it.
   */
  function bindFeatureList<T extends Scheduled & { [K in NumericKeys<T>]: number }>(
    prefix: string,
    noun: string,
    defaults: Readonly<T>,
    fields: { [K in NumericKeys<T>]: { format(value: number): string } },
    onChange: (index: number, value: T | null) => void,
  ): (values: readonly T[] | undefined) => void {
    const addButton = requireElement<HTMLButtonElement>(`${prefix}-add`);
    const list = requireElement<HTMLDivElement>(`${prefix}-list`);
    const template = requireElement<HTMLTemplateElement>(`${prefix}-template`);
    const keys = Object.keys(fields) as NumericKeys<T>[];

    interface Item {
      root: HTMLElement;
      title: HTMLElement;
      inputs: Record<NumericKeys<T>, HTMLInputElement>;
      outputs: Record<NumericKeys<T>, HTMLOutputElement>;
      schedule: ScheduleControls;
      /** Present only when the template has a Randomise checkbox (particle streams). */
      random?: HTMLInputElement;
    }
    /** Rendered panels, parallel to the selection's list of settings. */
    let items: Item[] = [];

    function read(item: Item): T {
      const numbers = {} as Record<NumericKeys<T>, number>;
      for (const key of keys) {
        const value = Number(item.inputs[key].value);
        numbers[key] = Number.isFinite(value) ? value : (defaults[key] as number);
      }
      const out: Scheduled & { random?: boolean } = { ...numbers };
      const schedule = item.schedule.read();
      if (schedule) out.schedule = schedule;
      if (item.random?.checked) out.random = true;
      return out as T;
    }

    function show(item: Item, value: T): void {
      for (const key of keys) {
        item.outputs[key].textContent = fields[key].format(value[key] as number);
      }
    }

    function emit(item: Item): void {
      const index = items.indexOf(item);
      if (index < 0) return;
      const value = read(item);
      show(item, value);
      onChange(index, value);
    }

    function retitle(): void {
      items.forEach((item, i) => {
        item.title.textContent = `${noun} ${i + 1}`;
      });
    }

    function createItem(): Item {
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      const root = fragment.firstElementChild as HTMLElement;
      const inputs = {} as Record<NumericKeys<T>, HTMLInputElement>;
      const outputs = {} as Record<NumericKeys<T>, HTMLOutputElement>;
      for (const key of keys) {
        inputs[key] = requireRole<HTMLInputElement>(root, String(key));
        outputs[key] = requireRole<HTMLOutputElement>(root, `${String(key)}-value`);
      }
      const item = { root, title: requireRole<HTMLElement>(root, "title"), inputs, outputs } as Item;
      item.schedule = bindSchedule(root, () => emit(item));
      const random = root.querySelector<HTMLInputElement>('[data-role="random"]');
      if (random) {
        item.random = random;
        random.addEventListener("change", () => emit(item));
      }
      for (const key of keys) inputs[key].addEventListener("input", () => emit(item));
      requireRole<HTMLButtonElement>(root, "remove").addEventListener("click", () => {
        const index = items.indexOf(item);
        if (index < 0) return;
        item.schedule.dispose();
        item.root.remove();
        items.splice(index, 1);
        retitle();
        onChange(index, null);
      });
      return item;
    }

    /** Write a value into a panel without disturbing a control being edited. */
    function write(item: Item, value: T): void {
      for (const key of keys) setIfUnfocused(item.inputs[key], String(value[key]));
      item.schedule.sync(value.schedule);
      if (item.random) {
        setCheckedIfUnfocused(item.random, (value as { random?: boolean }).random === true);
      }
      show(item, read(item));
    }

    /** Tear down and rebuild every panel for a list of `count` entries. */
    function rebuild(count: number): void {
      for (const item of items) item.schedule.dispose();
      list.replaceChildren();
      items = [];
      for (let i = 0; i < count; i++) {
        const item = createItem();
        items.push(item);
        list.append(item.root);
      }
      retitle();
    }

    addButton.addEventListener("click", () => {
      const item = createItem();
      items.push(item);
      list.append(item.root);
      retitle();
      write(item, defaults);
      onChange(items.length - 1, { ...defaults });
      item.root.scrollIntoView({ block: "nearest" });
    });

    /**
     * Reflect the selection's list. Panels are rebuilt only when the count changes; otherwise each
     * one is updated in place so a live per-frame refresh never disturbs a control being edited.
     */
    return (values) => {
      const incoming = values ?? [];
      if (incoming.length !== items.length) rebuild(incoming.length);
      incoming.forEach((value, i) => write(items[i], value));
    };
  }

  const degrees = (value: number): string => `${Math.round(value)}\u00B0`;

  // Particle streams
  const syncStreamControls = bindFeatureList<ParticleStream>(
    "stream",
    "Stream",
    DEFAULT_STREAM,
    {
      angleDeg: { format: degrees },
      intensity: { format: (v) => v.toFixed(2) },
      frequency: { format: (v) => `${Math.round(v)} /s/m` },
    },
    onStreamChange,
  );

  // Directional forces (wind pressure)
  const syncWindControls = bindFeatureList<DirectionalForce>(
    "wind",
    "Force",
    DEFAULT_WIND,
    {
      angleDeg: { format: degrees },
      force: { format: (v) => `${v.toFixed(1)} N/m` },
    },
    onWindChange,
  );

  const selectionMerge = requireElement<HTMLButtonElement>("selection-merge");
  const selectionDuplicate = requireElement<HTMLButtonElement>("selection-duplicate");
  const selectionDelete = requireElement<HTMLButtonElement>("selection-delete");
  bindActivate(selectionMerge, () => {
    if (selectionMerge.disabled) return;
    onMergeSelection();
    selectionMerge.blur();
  });
  bindActivate(selectionDuplicate, () => {
    onDuplicateSelection();
    selectionDuplicate.blur();
  });
  bindActivate(selectionDelete, () => {
    onDeleteSelection();
    selectionDelete.blur();
  });

  const motorDelete = requireElement<HTMLButtonElement>("motor-delete");
  bindActivate(motorDelete, () => {
    onDeleteSelection();
    motorDelete.blur();
  });

  function showSelectionInfo(
    body: Body | null,
    members: readonly Body[] = body ? [body] : [],
    mergeEnabled = false,
  ): void {
    if (!body || members.length === 0) {
      selectionInfo.hidden = true;
      selectionMerge.disabled = true;
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
    selectionMerge.disabled = !mergeEnabled;
    selectionMerge.title = mergeEnabled
      ? "Merge overlapping shapes"
      : "Overlap or touch another filled shape";
    syncBodyTypeButtons(members);
    setCheckedIfUnfocused(
      wallsOnly,
      members.every((member) => getBodyData(member)?.wallsOnly === true),
    );

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
    const data = getBodyData(body);
    syncStreamControls(data?.streams);
    syncWindControls(data?.winds);
  }

  // Selected joint motor
  const motorInfo = requireElement<HTMLDivElement>("motor-info");
  const motorKind = requireElement<HTMLElement>("motor-kind");
  const motorSpeedRow = requireElement<HTMLLabelElement>("motor-speed-row");
  const motorSpeed = requireElement<HTMLInputElement>("motor-speed");
  const motorSpeedValue = requireElement<HTMLOutputElement>("motor-speed-value");
  const motorRangeRow = requireElement<HTMLLabelElement>("motor-range-row");
  const motorRangeLabel = requireElement<HTMLElement>("motor-range-label");
  const motorRange = requireElement<HTMLInputElement>("motor-range");
  const motorRangeValue = requireElement<HTMLOutputElement>("motor-range-value");
  const motorStartRow = requireElement<HTMLLabelElement>("motor-start-row");
  const motorStart = requireElement<HTMLInputElement>("motor-start");
  const motorStartValue = requireElement<HTMLOutputElement>("motor-start-value");
  const motorCollideRow = requireElement<HTMLLabelElement>("motor-collide-row");
  const motorCollide = requireElement<HTMLInputElement>("motor-collide");
  const jointStiffnessRow = requireElement<HTMLLabelElement>("joint-stiffness-row");
  const jointStiffness = requireElement<HTMLInputElement>("joint-stiffness");
  const jointStiffnessValue = requireElement<HTMLOutputElement>("joint-stiffness-value");
  const jointDampingRow = requireElement<HTMLLabelElement>("joint-damping-row");
  const jointDamping = requireElement<HTMLInputElement>("joint-damping");
  const jointDampingValue = requireElement<HTMLOutputElement>("joint-damping-value");

  /** What the Range slider currently edits: hinge angle (degrees) or slider travel (pixels). */
  let rangeUnit: "degrees" | "pixels" = "degrees";
  /** Joint currently shown in the motor panel, for syncing Start when Range moves. */
  let motorJoint: Joint | null = null;

  function showMotorSpeed(speed: number): void {
    motorSpeed.value = String(speed);
    motorSpeedValue.textContent = speed.toFixed(2);
  }

  function showMotorRange(value: number): void {
    motorRange.value = String(value);
    if (rangeUnit === "pixels") {
      motorRangeValue.textContent = value >= FULL_TRAVEL_PX ? "Free" : `${Math.round(value)} px`;
    } else {
      motorRangeValue.textContent =
        value >= FULL_RANGE_DEG ? "Free" : `${Math.round(value)}\u00B0`;
    }
  }

  function showMotorStart(startDeg: number): void {
    const clamped = Math.max(ANGLE_START_MIN_DEG, Math.min(ANGLE_START_MAX_DEG, startDeg));
    motorStart.value = String(clamped);
    motorStartValue.textContent = `${Math.round(clamped)}\u00B0`;
  }

  function syncMotorStartRow(): void {
    const limited =
      motorJoint !== null &&
      hasAngleLimit(motorJoint) &&
      rangeUnit === "degrees" &&
      getAngleRangeDeg(motorJoint) < FULL_RANGE_DEG;
    motorStartRow.hidden = !limited;
    if (limited && motorJoint) showMotorStart(getAngleStartDeg(motorJoint));
  }

  function showJointStiffness(hz: number): void {
    jointStiffness.value = String(hz);
    jointStiffness.max = String(MAX_SPRING_HZ);
    jointStiffnessValue.textContent = hz <= 0 ? "Rigid" : `${hz.toFixed(1)} Hz`;
  }

  function showJointDamping(ratio: number): void {
    jointDamping.value = String(ratio);
    jointDampingValue.textContent = ratio.toFixed(2);
  }

  /** Point the Range row at the joint's limit: angle for pin / revolute, travel for sliders. */
  function configureRangeRow(joint: Joint): void {
    if (hasTravelLimit(joint)) {
      rangeUnit = "pixels";
      motorRangeLabel.textContent = "Travel";
      motorRange.min = "0";
      motorRange.max = String(FULL_TRAVEL_PX);
      motorRange.step = "10";
      showMotorRange(getTravelRangePx(joint));
    } else {
      rangeUnit = "degrees";
      motorRangeLabel.textContent = "Range";
      motorRange.min = "0";
      motorRange.max = String(FULL_RANGE_DEG);
      motorRange.step = "1";
      motorStart.min = String(ANGLE_START_MIN_DEG);
      motorStart.max = String(ANGLE_START_MAX_DEG);
      motorStart.step = "1";
      showMotorRange(getAngleRangeDeg(joint));
    }
  }

  function showMotorInfo(joint: Joint | null): void {
    motorJoint = joint;
    if (!joint) {
      motorInfo.hidden = true;
      motorStartRow.hidden = true;
      return;
    }
    const data = joint.getUserData() as JointUserData | undefined;
    if (!data?.kind) {
      motorInfo.hidden = true;
      motorStartRow.hidden = true;
      motorJoint = null;
      return;
    }
    motorInfo.hidden = false;
    motorInfo.scrollIntoView({ block: "nearest" });
    motorKind.textContent = jointKindLabel(data.kind);
    const motor = isMotorJoint(data.kind);
    motorSpeedRow.hidden = !motor;
    if (motor) showMotorSpeed(getMotorSpeed(joint));
    motorRangeRow.hidden = !hasAngleLimit(joint) && !hasTravelLimit(joint);
    if (!motorRangeRow.hidden) configureRangeRow(joint);
    syncMotorStartRow();
    motorCollideRow.hidden = !hasTravelLimit(joint);
    motorCollide.checked = hasTravelLimit(joint) && joint.getCollideConnected();
    const spring = hasSpring(joint);
    jointStiffnessRow.hidden = !spring;
    if (spring) {
      showJointStiffness(getJointFrequency(joint));
      showJointDamping(getJointDamping(joint));
    }
    jointDampingRow.hidden = !spring || getJointFrequency(joint) <= 0;
  }

  motorSpeed.addEventListener("input", () => {
    const speed = parseFloat(motorSpeed.value);
    showMotorSpeed(speed);
    onMotorSpeedChange(speed);
  });

  motorRange.addEventListener("input", () => {
    const value = parseFloat(motorRange.value);
    showMotorRange(value);
    onMotorRangeChange(value);
    syncMotorStartRow();
  });

  motorStart.addEventListener("input", () => {
    const startDeg = parseFloat(motorStart.value);
    showMotorStart(startDeg);
    onMotorStartChange(startDeg);
  });

  motorCollide.addEventListener("change", () => {
    onSliderCollideChange(motorCollide.checked);
  });

  jointStiffness.addEventListener("input", () => {
    const hz = parseFloat(jointStiffness.value);
    showJointStiffness(hz);
    jointDampingRow.hidden = hz <= 0;
    onJointStiffnessChange(hz);
  });

  jointDamping.addEventListener("input", () => {
    const ratio = parseFloat(jointDamping.value);
    showJointDamping(ratio);
    onJointDampingChange(ratio);
  });

  return {
    getSelectedShape: () => selectedShape,
    getSettings,
    setSettings,
    resetSettings,
    getActiveTool: () => activeTool,
    isSpray,
    isCut,
    setCut,
    isChainOutline,
    getSpraySample,
    getSpraySize,
    getWallThickness,
    getSectorDeg,
    getInnerRadius,
    showSelectionInfo,
    showMotorInfo,
    setActiveTool,
    setPaused,
    setClock,
    setZoom: showZoom,
  };
}
