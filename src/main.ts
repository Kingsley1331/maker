import { createPhysics } from "./physics";
import { setupInput } from "./input";
import { setAngleRange, setJointMotor } from "./joints";
import { getBodyData, setBodyMass } from "./shapes";
import { setupUi } from "./ui";
import { vecToMeters } from "./units";

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
  onMotorSpeedChange: (speed) => {
    const joint = input.selection.selectedJoint;
    if (joint) setJointMotor(joint, speed);
  },
  onMotorRangeChange: (degrees) => {
    const joint = input.selection.selectedJoint;
    if (joint) setAngleRange(joint, degrees);
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
  onZoomChange: (zoom) => physics.setZoom(zoom),
  onToolChange: (tool) => {
    if (tool.kind === "zoom") input.selection.deselect();
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
  onSelectionUpdate: (body, members) => ui.showSelectionInfo(body, members),
  onJointSelectionUpdate: (joint) => {
    physics.setSelectedJoint(joint);
    ui.showMotorInfo(joint);
  },
  onZoomChange: (zoom) => ui.setZoom(zoom),
  onAfterRender: (cb) => physics.onAfterRender(cb),
  bodyAt: (point) => physics.bodyAt(point),
  jointAt: (point) => physics.jointAt(point),
});

ui.setPaused(physics.isPaused());
