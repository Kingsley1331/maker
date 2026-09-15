import type { SceneContent } from "./scene-serialize";

const DEFAULT_LIMIT = 50;

export interface History {
  /**
   * Snapshot `scene` as the state to restore on undo. No-op while a gesture is already open so
   * pointer drags and slider travel stay one step.
   */
  begin(scene: SceneContent): void;
  /** Close the current gesture so the next `begin` is a new step. */
  end(): void;
  /**
   * Restore the previous snapshot. `current` is pushed onto redo. Returns null when there is
   * nothing to undo.
   */
  undo(current: SceneContent): SceneContent | null;
  /**
   * Restore the next snapshot. `current` is pushed onto undo. Returns null when there is
   * nothing to redo.
   */
  redo(current: SceneContent): SceneContent | null;
  /** Drop both stacks (after loading a saved scene). */
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function createHistory(limit = DEFAULT_LIMIT): History {
  const undoStack: SceneContent[] = [];
  const redoStack: SceneContent[] = [];
  let gesture = false;

  function pushUndo(scene: SceneContent): void {
    undoStack.push(scene);
    if (undoStack.length > limit) undoStack.shift();
  }

  return {
    begin(scene) {
      if (gesture) return;
      gesture = true;
      pushUndo(scene);
      redoStack.length = 0;
    },
    end() {
      gesture = false;
    },
    undo(current) {
      gesture = false;
      const prev = undoStack.pop();
      if (!prev) return null;
      redoStack.push(current);
      return prev;
    },
    redo(current) {
      gesture = false;
      const next = redoStack.pop();
      if (!next) return null;
      pushUndo(current);
      return next;
    },
    clear() {
      gesture = false;
      undoStack.length = 0;
      redoStack.length = 0;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
  };
}
