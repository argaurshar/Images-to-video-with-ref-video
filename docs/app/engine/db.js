/* Storage. The Python kept one JSON document per project on disk plus a tree
   of binary files; this keeps the same shape in IndexedDB, so the project
   document is still the record and the rest is addressed by the same relative
   paths the document already carries.

   IndexedDB is per origin and per browser. Nothing here reaches a server, and
   nothing here survives clearing site data, which the app says plainly rather
   than letting a designer discover it after a paid batch. */

const DB_NAME = "archviz";
const VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(new Error("this browser blocked local storage, so projects cannot be kept: " + req.error));
  });
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onabort = t.onerror = () => reject(t.error || new Error("storage transaction failed"));
    if (req) req.onsuccess = () => resolve(req.result);
    else t.oncomplete = () => resolve();
  }));
}

// ------------------------------------------------------------- projects

export const putProject = (p) => {
  p.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  return tx("projects", "readwrite", (s) => s.put(JSON.parse(JSON.stringify(p))));
};
export const getProject = (id) => tx("projects", "readonly", (s) => s.get(id));
export const allProjects = () => tx("projects", "readonly", (s) => s.getAll());
export const delProject = (id) => tx("projects", "readwrite", (s) => s.delete(id));

// ---------------------------------------------------------------- files

/** Store a Blob under a relative path, exactly the paths the project document
    already uses ("projects/<id>/stills/<id>.jpg"). */
export const putFile = (path, blob) => tx("files", "readwrite", (s) => s.put(blob, path));
export const getFile = (path) => tx("files", "readonly", (s) => s.get(path));
export const allFileKeys = () => tx("files", "readonly", (s) => s.getAllKeys());

export async function delFilesUnder(prefix) {
  const keys = await allFileKeys();
  for (const k of keys) if (String(k).startsWith(prefix)) await tx("files", "readwrite", (s) => s.delete(k));
}

// Object URLs are cached so a re-render of the same tile does not leak a new
// one every time, and revoked wholesale when a project is closed.
const _urls = new Map();

export async function fileURL(path) {
  if (!path) return "";
  if (_urls.has(path)) return _urls.get(path);
  const blob = await getFile(path);
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  _urls.set(path, url);
  return url;
}

export function forgetURL(path) {
  const u = _urls.get(path);
  if (u) { URL.revokeObjectURL(u); _urls.delete(path); }
}

export function forgetAllURLs() {
  for (const u of _urls.values()) URL.revokeObjectURL(u);
  _urls.clear();
}

// ------------------------------------------------------------- settings

const DEFAULTS = {
  provider: "demo",
  freepik_api_key: "",
  base_url: "https://api.freepik.com/v1",
  image_path: "/ai/gemini-2-5-flash-image-preview",
  video_path: "/ai/image-to-video/kling-v2-5-pro",
  image_cost: 0.08,
  video_cost: 0.28,
};

export async function loadSettings() {
  const s = await tx("settings", "readonly", (st) => st.get("main"));
  return Object.assign({}, DEFAULTS, s || {});
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = Object.assign(cur, patch);
  await tx("settings", "readwrite", (st) => st.put(next, "main"));
  return next;
}

/** What the UI is allowed to see: never the key itself, only a hint. */
export function publicSettings(s) {
  const k = s.freepik_api_key || "";
  return {
    provider: s.provider,
    has_key: !!k,
    key_hint: k ? k.slice(0, 4) + "…" + k.slice(-4) : "",
    base_url: s.base_url,
    image_path: s.image_path,
    video_path: s.video_path,
    image_cost: s.image_cost,
    video_cost: s.video_cost,
  };
}

/** Ask the browser to treat this origin's storage as persistent.

    Without it a phone treats the projects as a cache and is free to throw
    them away when it wants space, which for the only copy of a paid batch is
    not a cache at all. The answer is not something to argue with: Chrome
    decides on its own signals and Safari grants it on a gesture, so the result
    is reported and the app says plainly where the work lives either way. */
export async function persist() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

/** Rough measure of how much room is left, so a paid batch is not started
    into a quota that cannot hold its output. */
export async function quota() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota, free: quota - usage };
  } catch { return null; }
}
