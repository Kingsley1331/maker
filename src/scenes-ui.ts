import type { SceneSummary } from "./scene-serialize";
import { deleteScene, listScenes } from "./scene-store";

export type View = "editor" | "scenes";

export interface ScenesUiOptions {
  /** Save the current scene (overwrite when one is loaded, otherwise create). */
  onSave(): void;
  /** Always save a fresh copy. */
  onSaveAsNew(): void;
  /** Start a blank scene. */
  onClear(): void;
  /** Load a saved scene into the editor. */
  onLoad(id: string): void;
  /** Fired after the visible view changes. */
  onViewChange?(view: View): void;
}

export interface ScenesUi {
  getView(): View;
  showView(view: View): void;
  /** Re-read the store and redraw the library grid. */
  refresh(): Promise<void>;
  /** Show the loaded scene's name in the nav bar (null for an unsaved scene). */
  setSceneTitle(name: string | null): void;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function formatDate(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function setupScenesUi({ onSave, onSaveAsNew, onClear, onLoad, onViewChange }: ScenesUiOptions): ScenesUi {
  const tabEditor = requireElement<HTMLButtonElement>("tab-editor");
  const tabScenes = requireElement<HTMLButtonElement>("tab-scenes");
  const editorPanel = requireElement<HTMLDivElement>("app");
  const scenesPanel = requireElement<HTMLElement>("scenes-view");
  const list = requireElement<HTMLDivElement>("scene-list");
  const empty = requireElement<HTMLParagraphElement>("scenes-empty");
  const title = requireElement<HTMLSpanElement>("scene-title");
  const saveButton = requireElement<HTMLButtonElement>("scene-save");
  const saveNewButton = requireElement<HTMLButtonElement>("scene-save-new");
  const clearButton = requireElement<HTMLButtonElement>("scene-clear");

  let view: View = "editor";

  function showView(next: View): void {
    view = next;
    const editorOn = next === "editor";
    editorPanel.hidden = !editorOn;
    scenesPanel.hidden = editorOn;
    tabEditor.classList.toggle("is-active", editorOn);
    tabScenes.classList.toggle("is-active", !editorOn);
    tabEditor.setAttribute("aria-selected", String(editorOn));
    tabScenes.setAttribute("aria-selected", String(!editorOn));
    // Scene actions only make sense while looking at the canvas.
    for (const button of [saveButton, saveNewButton, clearButton]) button.disabled = !editorOn;
    if (!editorOn) void refresh();
    onViewChange?.(next);
  }

  function card(scene: SceneSummary): HTMLElement {
    const el = document.createElement("article");
    el.className = "scene-card";

    const thumb = document.createElement("img");
    thumb.className = "scene-thumb";
    thumb.alt = `Preview of ${scene.name}`;
    thumb.src = scene.thumbnail;
    thumb.title = "Load scene";
    thumb.addEventListener("click", () => onLoad(scene.id));

    const body = document.createElement("div");
    body.className = "scene-card-body";
    const name = document.createElement("div");
    name.className = "scene-name";
    name.textContent = scene.name;
    name.title = scene.name;
    const date = document.createElement("div");
    date.className = "scene-date";
    date.textContent = `Saved ${formatDate(scene.updatedAt)}`;
    body.append(name, date);

    const actions = document.createElement("div");
    actions.className = "scene-card-actions";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "nav-btn nav-btn-primary";
    load.textContent = "Load";
    load.addEventListener("click", () => onLoad(scene.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nav-btn nav-btn-danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${scene.name}"? This cannot be undone.`)) return;
      remove.disabled = true;
      try {
        await deleteScene(scene.id);
      } finally {
        await refresh();
      }
    });
    actions.append(load, remove);

    el.append(thumb, body, actions);
    return el;
  }

  async function refresh(): Promise<void> {
    let scenes: SceneSummary[] = [];
    try {
      scenes = await listScenes();
    } catch (error) {
      console.error("Could not read saved scenes", error);
    }
    list.replaceChildren(...scenes.map(card));
    empty.hidden = scenes.length > 0;
  }

  function setSceneTitle(name: string | null): void {
    title.textContent = name ?? "Untitled";
    title.title = name ?? "Unsaved scene";
  }

  tabEditor.addEventListener("click", () => showView("editor"));
  tabScenes.addEventListener("click", () => showView("scenes"));
  saveButton.addEventListener("click", onSave);
  saveNewButton.addEventListener("click", onSaveAsNew);
  clearButton.addEventListener("click", onClear);

  return {
    getView: () => view,
    showView,
    refresh,
    setSceneTitle,
  };
}
