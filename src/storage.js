import {
  DB_NAME,
  DB_VERSION,
  GATEWAY_BASE_URL_STORAGE,
  GATEWAY_KEY_STORAGE,
  STORE_CHUNKS,
  STORE_NOTES
} from "./constants.js";
import { extractGatewayUrlParam, normalizeGatewayBaseUrl } from "./utils.js";

export function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: "id" });
        chunkStore.createIndex("segmentIndex", "segmentIndex", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        db.createObjectStore(STORE_NOTES, { keyPath: "segmentIndex" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveActiveChunkToIdb(db, { sessionId, segmentIndex, chunkSeq, mime, blob }) {
  if (!db) return;
  const tx = db.transaction(STORE_CHUNKS, "readwrite");
  const store = tx.objectStore(STORE_CHUNKS);
  await idbRequest(store.put({
    id: `${sessionId}_seg${segmentIndex}_seq${chunkSeq}`,
    sessionId,
    segmentIndex,
    chunkSeq,
    mime,
    blob,
    size: blob.size,
    createdAt: Date.now()
  }));
}

export async function replaceSegmentChunksWithFullBlobInIdb(db, sessionId, segmentIndex, mime, fullBlob) {
  if (!db) return;
  const tx = db.transaction(STORE_CHUNKS, "readwrite");
  const store = tx.objectStore(STORE_CHUNKS);
  const all = await idbRequest(store.getAll());
  for (const item of all) {
    if (item.segmentIndex === segmentIndex) {
      await idbRequest(store.delete(item.id));
    }
  }
  await idbRequest(store.put({
    id: `${sessionId}_seg${segmentIndex}_complete`,
    sessionId,
    segmentIndex,
    chunkSeq: 0,
    mime,
    blob: fullBlob,
    size: fullBlob.size,
    isCompleteSegment: true,
    createdAt: Date.now()
  }));
}

export async function deleteSegmentChunksFromIdb(db, segmentIndex) {
  if (!db) return;
  const tx = db.transaction(STORE_CHUNKS, "readwrite");
  const store = tx.objectStore(STORE_CHUNKS);
  const all = await idbRequest(store.getAll());
  for (const item of all) {
    if (item.segmentIndex === segmentIndex) {
      await idbRequest(store.delete(item.id));
    }
  }
}

export async function saveExtractedNoteToIdb(db, noteObj) {
  if (!db) return;
  const tx = db.transaction(STORE_NOTES, "readwrite");
  await idbRequest(tx.objectStore(STORE_NOTES).put(noteObj));
}

export async function getAllIdbRecords(db, storeName) {
  if (!db) return [];
  const tx = db.transaction(storeName, "readonly");
  return await idbRequest(tx.objectStore(storeName).getAll());
}

export async function clearIdbStore(db, storeName) {
  if (!db) return;
  const tx = db.transaction(storeName, "readwrite");
  await idbRequest(tx.objectStore(storeName).clear());
}

export async function calcIdbChunkBytes(db) {
  const chunks = await getAllIdbRecords(db, STORE_CHUNKS);
  return chunks.reduce((acc, c) => acc + (c.size || (c.blob ? c.blob.size : 0)), 0);
}

export function saveStoredGatewayBaseUrl({ baseUrl, remember }) {
  const clean = normalizeGatewayBaseUrl(baseUrl);
  if (!clean) {
    sessionStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
    localStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
    return;
  }
  if (remember) {
    localStorage.setItem(GATEWAY_BASE_URL_STORAGE, clean);
    sessionStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
  } else {
    sessionStorage.setItem(GATEWAY_BASE_URL_STORAGE, clean);
    localStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
  }
}

export function saveStoredGatewayConfig({ baseUrl, apiKey, remember }) {
  const cleanKey = String(apiKey || "").trim();
  if (!cleanKey) {
    sessionStorage.removeItem(GATEWAY_KEY_STORAGE);
    localStorage.removeItem(GATEWAY_KEY_STORAGE);
  } else if (remember) {
    localStorage.setItem(GATEWAY_KEY_STORAGE, cleanKey);
    sessionStorage.removeItem(GATEWAY_KEY_STORAGE);
  } else {
    sessionStorage.setItem(GATEWAY_KEY_STORAGE, cleanKey);
    localStorage.removeItem(GATEWAY_KEY_STORAGE);
  }
  saveStoredGatewayBaseUrl({ baseUrl, remember });
}

export function loadStoredGatewayConfig({ hash = "", search = "" } = {}) {
  const localKey = localStorage.getItem(GATEWAY_KEY_STORAGE) || "";
  const sessionKey = sessionStorage.getItem(GATEWAY_KEY_STORAGE) || "";
  const localUrl = localStorage.getItem(GATEWAY_BASE_URL_STORAGE) || "";
  const sessionUrl = sessionStorage.getItem(GATEWAY_BASE_URL_STORAGE) || "";

  const remember = localKey ? true : sessionKey ? false : Boolean(localUrl);
  const fromLoc = extractGatewayUrlParam(hash, search);
  const baseUrl = fromLoc || localUrl || sessionUrl || "";
  if (fromLoc) {
    saveStoredGatewayBaseUrl({ baseUrl: fromLoc, remember });
  }

  return {
    baseUrl,
    apiKey: localKey || sessionKey || "",
    remember,
    fromLocation: Boolean(fromLoc),
    fromLocalKey: Boolean(localKey)
  };
}

export function clearStoredGatewayConfig() {
  sessionStorage.removeItem(GATEWAY_KEY_STORAGE);
  localStorage.removeItem(GATEWAY_KEY_STORAGE);
  sessionStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
  localStorage.removeItem(GATEWAY_BASE_URL_STORAGE);
}
