import type { SavedScene, SceneSummary } from "./scene-serialize";

const DB_NAME = "physics-sandbox";
const DB_VERSION = 1;
const STORE = "scenes";
const UPDATED_INDEX = "updatedAt";

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex(UPDATED_INDEX, "updatedAt");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema, drop our handle so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Every saved scene (without body/joint content), newest first. */
export async function listScenes(): Promise<SceneSummary[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const all = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<SavedScene[]>);
  return all
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, name, createdAt, updatedAt, thumbnail }) => ({ id, name, createdAt, updatedAt, thumbnail }));
}

export async function getScene(id: string): Promise<SavedScene | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const scene = await requestToPromise(tx.objectStore(STORE).get(id) as IDBRequest<SavedScene | undefined>);
  return scene ?? null;
}

export async function putScene(scene: SavedScene): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(scene);
  await transactionDone(tx);
}

export async function deleteScene(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await transactionDone(tx);
}

export async function countScenes(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return requestToPromise(tx.objectStore(STORE).count());
}
