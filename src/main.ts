import { createPhysics } from "./physics";
import { setupInput } from "./input";
import { setupUi } from "./ui";

const scene = document.getElementById("scene");
if (!scene) {
  throw new Error("Missing #scene container");
}

const physics = createPhysics(scene);

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
});

const input = setupInput({
  world: physics.world,
  ground: physics.ground,
  canvas: physics.canvas,
  getSize: () => physics.getSize(),
  isPaused: () => physics.isPaused(),
  getActiveTool: () => ui.getActiveTool(),
  onSelectionUpdate: (body) => ui.showSelectionInfo(body),
  onAfterRender: (cb) => physics.onAfterRender(cb),
  bodyAt: (point) => physics.bodyAt(point),
});

ui.setPaused(physics.isPaused());
