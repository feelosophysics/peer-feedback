import { GATEWAY_MODEL_CATALOG } from "./constants.js";

export function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const rem = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${rem}`;
}

export function formatMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const rem = String(s % 60).padStart(2, "0");
  return `${m}:${rem}`;
}

export function nowTimeStr() {
  return new Date().toTimeString().slice(0, 8);
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeGatewayBaseUrl(raw) {
  let val = String(raw || "").trim();
  if (!val) return "";
  if (!/^https?:\/\//i.test(val)) {
    val = `https://${val}`;
  }
  val = val.replace(/\/+$/, "");
  val = val.replace(/\/v1\/(?:chat\/completions|messages|models)$/i, "");
  val = val.replace(/\/v1$/i, "");
  val = val.replace(/\/+$/, "");
  return val;
}

export function extractGatewayUrlParam(hashStr = "", searchStr = "") {
  for (const rawSource of [hashStr, searchStr]) {
    if (!rawSource) continue;
    const stripped = String(rawSource).replace(/^[#?]+/, "");
    const params = new URLSearchParams(stripped);
    const candidate = params.get("api") || params.get("url") || params.get("base");
    if (candidate) {
      return normalizeGatewayBaseUrl(candidate);
    }
  }
  return "";
}

export function parseGeminiVersion(modelId) {
  const clean = String(modelId || "").replace(/^models\//, "");
  const match = clean.match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
  return { major, minor, id: clean };
}

export function isGatewayChatModelAllowed(id) {
  if (!id) return false;
  if (/tts|image|imagen|veo|sora|embedding|whisper|moderation|realtime|audio/i.test(id)) {
    return false;
  }
  const gemVer = parseGeminiVersion(id);
  if (gemVer && gemVer.major < 3) return false;
  if (/^claude-3/i.test(id) || /^gpt-[34]/i.test(id)) return false;
  return true;
}

export function isGatewayAudioCapableModel(id) {
  const found = GATEWAY_MODEL_CATALOG.find((m) => m.id === id);
  if (found) return Boolean(found.audioCapable);
  return /^gemini-/i.test(String(id || ""));
}

export function sortAllowedGatewayModels(rawIds) {
  const cleaned = (Array.isArray(rawIds) ? rawIds : [])
    .map((id) => String(id || "").replace(/^models\//, "").trim())
    .filter(Boolean);
  const filtered = Array.from(new Set(cleaned.filter(isGatewayChatModelAllowed)));
  const catalogOrder = GATEWAY_MODEL_CATALOG.map((m) => m.id);

  filtered.sort((a, b) => {
    const ia = catalogOrder.indexOf(a);
    const ib = catalogOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  return filtered;
}

export function normalizeAudioMimeType(mime) {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!base) return "audio/webm";
  if (base === "audio/x-m4a" || base === "audio/m4a") return "audio/mp4";
  if (base === "audio/x-wav") return "audio/wav";
  return base;
}

export function mimeToAudioFormat(cleanMime) {
  const sub = String(cleanMime || "audio/wav").split("/")[1] || "wav";
  if (sub === "mpeg") return "mp3";
  if (sub === "x-wav") return "wav";
  return sub;
}

export function isNetworkOrCorsError(err) {
  if (!err) return false;
  if (err instanceof TypeError) return true;
  return /Failed to fetch|Load failed|NetworkError|CORS/i.test(err.message || "");
}

export function isOpenAiProtocolDisallowedError(err) {
  return Boolean(
    err &&
    err.status === 403 &&
    /not allowed for the openai|use an openai-compatible key|openai-compatible/i.test(err.message || "")
  );
}

export function parseModelJson(rawText) {
  let cleaned = String(rawText || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw firstErr;
  }
}
