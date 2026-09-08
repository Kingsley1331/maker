import { createPhysics } from "./physics";
import { setupInput } from "./input";
import { setAngleRange, setJointMotor } from "./joints";
import { setupUi } from "./ui";

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
});

const input = setupInput({
  world: physics.world,
  ground: physics.ground,
  canvas: physics.canvas,
  getSize: () => physics.getSize(),
  isPaused: () => physics.isPaused(),
  getActiveTool: () => ui.getActiveTool(),
  onSelectionUpdate: (body, members) => ui.showSelectionInfo(body, members),
  onJointSelectionUpdate: (joint) => {
    physics.setSelectedJoint(joint);
    ui.showMotorInfo(joint);
  },
  onAfterRender: (cb) => physics.onAfterRender(cb),
  bodyAt: (point) => physics.bodyAt(point),
  jointAt: (point) => physics.jointAt(point),
});

ui.setPaused(physics.isPaused());
