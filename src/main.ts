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
  engine: physics.engine,
  render: physics.render,
  isPaused: () => physics.isPaused(),
  getSelectedShape: () => ui.getSelectedShape(),
  onSelectionUpdate: (body) => ui.showSelectionInfo(body),
});

ui.setPaused(physics.isPaused());
