import { createPhysics } from "./physics";
import { setupInput } from "./input";
import { setJointDamping, setJointFrequency, setJointMotor, setJointRange } from "./joints";
import { deleteSelection, duplicateSelection, setPrismaticCollide } from "./scene-edit";
import {
  clearScene,
  deserializeScene,
  SCENE_FORMAT_VERSION,
  serializeScene,
  type SavedScene,
  type SceneSettings,
} from "./scene-serialize";
import { countScenes, getScene, putScene } from "./scene-store";
import { setupScenesUi } from "./scenes-ui";
import { getBodyData, setBodyMass, setBodyRestitution } from "./shapes";
import { setupUi } from "./ui";
import { vecToMeters } from "./units";

const THUMBNAIL_WIDTH = 320;

const scene = document.getElementById("scene");
if (!scene) {
  throw new Error("Missing #scene container");
}

const physics = createPhysics(scene);
// Start paused so the scene can be built (select, move, joint) before anything falls.
physics.pause();

const ui = setupUi({
  onGravityChange: (x, y) => physics.setGravity(x, y),
  onBackgroundChange: (color) => physics.setBackground(color),
  onWrapChange: (wrap) => physics.setWrapEnabled(wrap),
  onPauseToggle: (paused) => {
    if (paused) {
      physics.pause();
    } else {
      // Resizing is only allowed while paused, so resuming drops the selection.
      input.selection.deselect();
      physics.play();
    }
    ui.setPaused(physics.isPaused());
  },
  onStep: () => {
    if (physics.isPaused()) physics.stepOnce();
  },
  onMotorSpeedChange: (speed) => {
    const joint = input.selection.selectedJoint;
    if (joint) setJointMotor(joint, speed);
  },
  onMotorRangeChange: (value) => {
    const joint = input.selection.selectedJoint;
    if (joint) setJointRange(joint, value);
  },
  onSliderCollideChange: (collide) => {
    const joint = input.selection.selectedJoint;
    if (!joint) return;
    const created = setPrismaticCollide(physics.world, physics.ground, joint, collide);
    if (created) input.selection.selectJoint(created);
    else input.selection.deselect();
  },
  onJointStiffnessChange: (hz) => {
    const joint = input.selection.selectedJoint;
    if (joint) setJointFrequency(joint, hz);
  },
  onJointDampingChange: (ratio) => {
    const joint = input.selection.selectedJoint;
    if (joint) setJointDamping(joint, ratio);
  },
  onBodyTypeChange: (type) => {
    for (const body of input.selection.members) {
      body.setType(type);
      if (type !== "dynamic") {
        body.setLinearVelocity({ x: 0, y: 0 });
        body.setAngularVelocity(0);
      }
      body.setAwake(true);
    }
  },
  onMassChange: (mass) => {
    for (const body of input.selection.members) setBodyMass(body, mass);
  },
  onElasticityChange: (value) => physics.setWorldRestitution(value),
  onSelectionElasticityChange: (value) => {
    for (const body of input.selection.members) setBodyRestitution(body, value, true);
  },
  onAirDragChange: (value) => physics.setWorldDamping(value),
  onFrictionChange: (value) => physics.setWorldFriction(value),
  onVelocityChange: (vxPx, vyPx) => {
    const v = vecToMeters({ x: vxPx, y: vyPx });
    for (const body of input.selection.members) body.setLinearVelocity(v);
  },
  onSpinChange: (degPerSec) => {
    const w = (degPerSec * Math.PI) / 180;
    for (const body of input.selection.members) body.setAngularVelocity(w);
  },
  onColorChange: (color) => {
    for (const body of input.selection.members) {
      const data = getBodyData(body);
      if (data) data.fillStyle = color;
    }
  },
  onStreamChange: (stream) => {
    for (const body of input.selection.members) {
      const data = getBodyData(body);
      if (!data || data.kind !== "shape") continue;
      data.stream = stream ? { ...stream } : undefined;
      body.setAwake(true);
    }
  },
  onWindChange: (wind) => {
    for (const body of input.selection.members) {
      const data = getBodyData(body);
      if (!data || data.kind !== "shape") continue;
      data.wind = wind ? { ...wind } : undefined;
      body.setAwake(true);
    }
  },
  onZoomChange: (zoom) => physics.setZoom(zoom),
  onToolChange: (tool) => {
    if (tool.kind === "zoom") input.selection.deselect();
  },
  onDeleteSelection: () => {
    if (!physics.isPaused()) return;
    const { members, selectedJoint } = input.selection;
    if (!selectedJoint && members.length === 0) return;
    deleteSelection(physics.world, members, selectedJoint);
    input.selection.deselect();
  },
  onDuplicateSelection: () => {
    if (!physics.isPaused()) return;
    const { members, selected } = input.selection;
    if (members.length === 0) return;
    const { primary } = duplicateSelection(physics.world, physics.ground, members, selected);
    if (primary) input.selection.select(primary);
  },
});

const input = setupInput({
  world: physics.world,
  ground: physics.ground,
  canvas: physics.canvas,
  getSize: () => physics.getSize(),
  getZoom: () => physics.getZoom(),
  setZoom: (zoom, anchor) => physics.setZoom(zoom, anchor),
  screenToWorld: (point) => physics.screenToWorld(point),
  panBy: (dx, dy) => physics.panBy(dx, dy),
  isPaused: () => physics.isPaused(),
  getActiveTool: () => ui.getActiveTool(),
  isSpray: () => ui.isSpray(),
  isCut: () => ui.isCut(),
  isChainOutline: () => ui.isChainOutline(),
  getSpraySample: () => ui.getSpraySample(),
  getSpraySize: () => ui.getSpraySize(),
  getWallThickness: () => ui.getWallThickness(),
  onSelectionUpdate: (body, members) => ui.showSelectionInfo(body, members),
  onJointSelectionUpdate: (joint) => {
    physics.setSelectedJoint(joint);
    ui.showMotorInfo(joint);
  },
  onZoomChange: (zoom) => ui.setZoom(zoom),
  clearTool: () => ui.setActiveTool({ kind: "none" }),
  onAfterRender: (cb) => physics.onAfterRender(cb),
  bodyAt: (point) => physics.bodyAt(point),
  jointAt: (point) => physics.jointAt(point),
  jointEndAt: (point) => physics.jointEndAt(point),
  setHoveredJoint: (joint, end) => physics.setHoveredJoint(joint, end),
  getWrapOffsets: () => physics.getWrapOffsets(),
});

ui.setPaused(physics.isPaused());
physics.onAfterRender(() => ui.setClock(physics.getStepCount(), physics.getSimTime()));

// Scene save / load -------------------------------------------------------------------------

let currentSceneId: string | null = null;
let currentSceneName: string | null = null;
let currentCreatedAt: number | null = null;

function captureThumbnail(): string {
  const source = physics.canvas;
  const { w, h } = physics.getSize();
  const scale = Math.min(1, THUMBNAIL_WIDTH / Math.max(1, w));
  const thumb = document.createElement("canvas");
  thumb.width = Math.max(1, Math.round(w * scale));
  thumb.height = Math.max(1, Math.round(h * scale));
  const ctx = thumb.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = physics.getBackground();
  ctx.fillRect(0, 0, thumb.width, thumb.height);
  ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/jpeg", 0.7);
}

function currentSettings(): SceneSettings {
  const settings = ui.getSettings();
  return { ...settings, zoom: physics.getZoom(), pan: physics.getOffset() };
}

function setCurrentScene(scene: Pick<SavedScene, "id" | "name" | "createdAt"> | null): void {
  currentSceneId = scene?.id ?? null;
  currentSceneName = scene?.name ?? null;
  currentCreatedAt = scene?.createdAt ?? null;
  scenesUi.setSceneTitle(currentSceneName);
}

async function defaultSceneName(): Promise<string> {
  try {
    return `Scene ${(await countScenes()) + 1}`;
  } catch {
    return "Scene";
  }
}

async function saveScene(asNew: boolean): Promise<void> {
  const overwrite = !asNew && currentSceneId !== null;
  const suggested = overwrite && currentSceneName ? currentSceneName : await defaultSceneName();
  const entered = window.prompt(overwrite ? "Scene name" : "Name for the new scene", suggested);
  if (entered === null) return;
  const name = entered.trim() || suggested;

  const now = Date.now();
  const scene: SavedScene = {
    id: overwrite && currentSceneId ? currentSceneId : crypto.randomUUID(),
    name,
    createdAt: overwrite && currentCreatedAt !== null ? currentCreatedAt : now,
    updatedAt: now,
    thumbnail: captureThumbnail(),
    version: SCENE_FORMAT_VERSION,
    settings: currentSettings(),
    ...serializeScene(physics.world, physics.ground),
  };

  try {
    await putScene(scene);
    setCurrentScene(scene);
  } catch (error) {
    console.error("Could not save scene", error);
    window.alert("Saving failed. Your browser may be blocking site storage.");
  }
}

function resetEditor(): void {
  physics.pause();
  physics.resetClock();
  input.selection.deselect();
  ui.setPaused(true);
}

function clearCurrentScene(): void {
  resetEditor();
  clearScene(physics.world);
  ui.resetSettings();
  physics.setZoom(1);
  ui.setZoom(1);
  setCurrentScene(null);
}

async function loadScene(id: string): Promise<void> {
  let scene: SavedScene | null = null;
  try {
    scene = await getScene(id);
  } catch (error) {
    console.error("Could not read scene", error);
  }
  if (!scene) {
    window.alert("That scene could not be loaded.");
    await scenesUi.refresh();
    return;
  }

  resetEditor();
  deserializeScene(physics.world, physics.ground, scene);
  const { zoom, pan, ...settings } = scene.settings;
  ui.setSettings({ ...settings, wrap: settings.wrap === true });
  physics.setView(zoom, pan);
  ui.setZoom(zoom);
  setCurrentScene(scene);
  scenesUi.showView("editor");
}

const scenesUi = setupScenesUi({
  onSave: () => void saveScene(false),
  onSaveAsNew: () => void saveScene(true),
  onClear: () => {
    if (!window.confirm("Clear the canvas? Unsaved changes will be lost.")) return;
    clearCurrentScene();
  },
  onLoad: (id) => void loadScene(id),
});
scenesUi.setSceneTitle(null);
