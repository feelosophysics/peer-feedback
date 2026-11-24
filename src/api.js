import {
  GATEWAY_MODEL_CATALOG,
  INLINE_SAFE_LIMIT_BYTES,
  TARGET_WAV_SAMPLE_RATE
} from "./constants.js";
import {
  blobToBase64,
  convertAudioBlobToWav16kMono,
  createToneWavBlob
} from "./audio.js";

// 음성 전달 점검: Gemini는 음성 1초를 약 32토큰으로 센다.
export const AUDIO_TOKENS_PER_SECOND = 32;
export const AUDIO_PROBE_SECONDS = 2;
const AUDIO_PROBE_PROMPT =
  "첨부된 오디오에 들리는 소리를 한 단어로 답하세요. 오디오가 첨부되지 않았다면 '없음'이라고만 답하세요.";

/**
 * 음성 없는 대조 요청과 음성 포함 요청의 prompt_tokens 차이로 음성 전달 여부를 판정한다.
 * - delivered: 음성 길이에 맞게 토큰이 늘었다
 * - dropped: 요청은 통과했지만 토큰이 거의 늘지 않았다(게이트웨이가 음성을 버림)
 * - inconclusive: usage 정보가 없어 판정할 수 없다
 */
export function judgeAudioProbe({ controlTokens, audioTokens, audioSeconds = AUDIO_PROBE_SECONDS }) {
  const expected = Math.round(audioSeconds * AUDIO_TOKENS_PER_SECOND);
  const c = Number.isFinite(controlTokens) && controlTokens > 0 ? controlTokens : null;
  const a = Number.isFinite(audioTokens) && audioTokens > 0 ? audioTokens : null;
  if (c === null || a === null) {
    return { verdict: "inconclusive", controlTokens: c, audioTokens: a, diff: null, expected };
  }
  const diff = a - c;
  const threshold = Math.max(10, Math.round(expected * 0.3));
  return { verdict: diff >= threshold ? "delivered" : "dropped", controlTokens: c, audioTokens: a, diff, expected };
}

/**
 * 게이트웨이가 input_audio를 조용히 버려도 HTTP 200이 올 수 있으므로,
 * 같은 문장을 음성 없이/있이(2초 신호음) 보내 usage.prompt_tokens가 음성 길이만큼 늘었는지로 판정한다.
 * 요청이 실패하면 err.probeStage("control" | "audio")를 붙여 그대로 던진다.
 */
export async function probeAudioDelivery({ baseUrl, apiKey, localProxyAvailable, modelId }) {
  const toneB64 = await blobToBase64(createToneWavBlob(AUDIO_PROBE_SECONDS, TARGET_WAV_SAMPLE_RATE));
  const probeOptions = { useJsonMode: false, maxTokens: 256, temperature: 0, allowEmptyText: true };
  const send = async (stage, audioPayload) => {
    try {
      return await callGatewayOpenAiEndpointDetailed({
        baseUrl,
        apiKey,
        localProxyAvailable,
        modelId,
        prompt: AUDIO_PROBE_PROMPT,
        audioPayload,
        options: probeOptions
      });
    } catch (err) {
      err.probeStage = stage;
      throw err;
    }
  };
  const control = await send("control", null);
  const withAudio = await send("audio", { base64: toneB64, cleanMime: "audio/wav" });
  return judgeAudioProbe({
    controlTokens: control.usage?.prompt_tokens,
    audioTokens: withAudio.usage?.prompt_tokens,
    audioSeconds: AUDIO_PROBE_SECONDS
  });
}

// 판정 보류(usage 없음)가 나온 게이트웨이·모델은 구간마다 다시 점검하지 않는다.
const audioProbeInconclusiveKeys = new Set();

/**
 * 녹음 전송 직전 점검. 돌려주는 값:
 * "delivered" | "dropped" | "rejected"(음성 요청 거부) | "inconclusive"(판정 불가 — 기존처럼 전송은 시도)
 */
export async function checkAudioDeliveryBeforeSend({
  baseUrl,
  apiKey,
  localProxyAvailable,
  selectedModel,
  customModel = "",
  syncedModels = [],
  onLog,
  label = "audio"
}) {
  let modelId;
  try {
    modelId = buildModelCandidates({ selectedModel, customModel, syncedModels, requireAudio: true })[0];
  } catch {
    return "inconclusive";
  }
  if (!modelId) return "inconclusive";
  const cacheKey = getJsonModeCacheKey(baseUrl, modelId);
  if (audioProbeInconclusiveKeys.has(cacheKey)) return "inconclusive";

  onLog?.(`${label}: 녹음을 보내기 전에 음성 전달 점검 중 (${modelId} · 2초 신호음과 토큰 수 비교)`, "info");
  try {
    const judged = await probeAudioDelivery({ baseUrl, apiKey, localProxyAvailable, modelId });
    if (judged.verdict === "inconclusive") audioProbeInconclusiveKeys.add(cacheKey);
    onLog?.(
      judged.diff === null
        ? `${label}: 음성 전달 판정 보류 — 게이트웨이가 토큰 사용량을 알려주지 않음`
        : `${label}: 음성 전달 점검 ${judged.verdict === "delivered" ? "통과" : "실패"} — 토큰 차이 ${judged.diff} (예상 약 ${judged.expected})`,
      judged.verdict === "delivered" ? "ok" : "warn"
    );
    return judged.verdict;
  } catch (err) {
    if (err.probeStage === "audio" && err.isAudioRejected) return "rejected";
    // 키·네트워크 오류 등은 실제 전송에서 원래 방식대로 드러나게 둔다.
    return "inconclusive";
  }
}
import {
  formatBytes,
  isGatewayAudioCapableModel,
  isNetworkOrCorsError,
  isOpenAiProtocolDisallowedError,
  mimeToAudioFormat,
  normalizeAudioMimeType,
  sortAllowedGatewayModels
} from "./utils.js";

const jsonModeUnsupportedKeys = new Set();

function getJsonModeCacheKey(baseUrl, modelId) {
  return `${String(baseUrl || "").trim()}::${String(modelId || "").trim()}`;
}

export function resetGatewayFeatureCache(baseUrl = null) {
  if (!baseUrl) {
    jsonModeUnsupportedKeys.clear();
    audioProbeInconclusiveKeys.clear();
    return;
  }
  const prefix = `${String(baseUrl).trim()}::`;
  for (const cache of [jsonModeUnsupportedKeys, audioProbeInconclusiveKeys]) {
    for (const key of cache) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }
}

export function isJsonModeUnsupportedCached(baseUrl, modelId) {
  return jsonModeUnsupportedKeys.has(getJsonModeCacheKey(baseUrl, modelId));
}

export function shouldRetryWithoutJsonMode({
  status,
  useJsonMode,
  errText = "",
  hasAudioPayload = false,
  allowAudioJsonFallback = false
}) {
  if (status !== 400 || !useJsonMode) return false;
  if (/response_format|json_object/i.test(errText)) return true;
  if (!hasAudioPayload) return true;
  if (allowAudioJsonFallback && /unsupported_feature|not\s+supported/i.test(errText)) {
    return true;
  }
  return false;
}

export function isLocalhostOrigin() {
  if (typeof window === "undefined") return false;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return (proto === "http:" || proto === "https:") && (host === "localhost" || host === "127.0.0.1");
}

export function buildGatewayFetchRequest({ path, baseUrl, localProxyAvailable, extraHeaders = {} }) {
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  if (localProxyAvailable) {
    return {
      url: `/api/proxy${normalizedPath}`,
      headers: {
        ...extraHeaders,
        "X-Proxy-Target-Base": baseUrl
      },
      baseUrl
    };
  }
  return {
    url: `${baseUrl}${normalizedPath}`,
    headers: { ...extraHeaders },
    baseUrl
  };
}

export function buildModelCandidates({ selectedModel, customModel = "", syncedModels = [], requireAudio = false }) {
  const staticIds = GATEWAY_MODEL_CATALOG.map((m) => m.id);
  let pool = Array.from(new Set([...staticIds, ...syncedModels]));
  if (requireAudio) {
    pool = pool.filter(isGatewayAudioCapableModel);
  }

  if (selectedModel === "__custom__") {
    const custom = String(customModel || "").trim().replace(/^models\//, "");
    if (!custom) throw new Error("직접 입력할 모델 ID를 적어주세요.");
    return Array.from(new Set([custom, ...pool]));
  }
  if (!selectedModel || selectedModel === "auto") {
    return pool;
  }
  if (requireAudio && !isGatewayAudioCapableModel(selectedModel)) {
    const err = new Error(`선택한 모델(${selectedModel})은 텍스트 전용 모델입니다.`);
    err.isTextOnlyModel = true;
    throw err;
  }
  return [selectedModel, ...pool.filter((m) => m !== selectedModel)];
}

export function formatCorsOrNetworkMessage(baseUrl, rawErrMsg, localProxyAvailable) {
  if (!localProxyAvailable) {
    return (
      `게이트웨이 API(${baseUrl})가 브라우저 직접 호출(CORS)을 차단했습니다.\n` +
      `해결 방법: 저장소 폴더에서 'node server.mjs' 또는 'python3 server.py'를 실행한 뒤 http://localhost:8765 로 열어 주세요.\n` +
      `(원인: ${rawErrMsg})`
    );
  }
  return (
    `로컬 프록시를 통한 게이트웨이 연결(${baseUrl}) 중 네트워크 오류가 발생했습니다. 인터넷 연결 또는 게이트웨이 상태를 확인해 주세요.\n` +
    `(원인: ${rawErrMsg})`
  );
}

export async function checkLocalProxyHealth() {
  if (!isLocalhostOrigin()) {
    return { ok: false, runtime: "", restrictedHosts: [], isLocalhost: false };
  }
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.ok === true && data.proxy === true) {
      return {
        ok: true,
        runtime: data.runtime || "local",
        restrictedHosts: Array.isArray(data.restrictedHosts) ? data.restrictedHosts : [],
        isLocalhost: true
      };
    }
  } catch {
    // Proxy endpoint unavailable
  }
  return { ok: false, runtime: "", restrictedHosts: [], isLocalhost: true };
}

export async function fetchAvailableModels({ baseUrl, apiKey, localProxyAvailable }) {
  try {
    const reqInfo = buildGatewayFetchRequest({
      path: "/v1/models",
      baseUrl,
      localProxyAvailable,
      extraHeaders: { Authorization: `Bearer ${apiKey}` }
    });
    const res = await fetch(reqInfo.url, {
      method: "GET",
      headers: reqInfo.headers
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 220)}`);
      err.status = res.status;
      return {
        ok: false,
        status: res.status,
        models: [],
        error: err,
        isAuthError: res.status === 401 || res.status === 403,
        isWrongProtocol: isOpenAiProtocolDisallowedError(err),
        isCorsOrNetwork: false
      };
    }

    const data = await res.json();
    const rawIds = (data.data || data.models || []).map((m) => m.id || m.name || "");
    const models = sortAllowedGatewayModels(rawIds);
    return {
      ok: true,
      status: res.status,
      models,
      error: null,
      isAuthError: false,
      isWrongProtocol: false,
      isCorsOrNetwork: false
    };
  } catch (err) {
    return {
      ok: false,
      status: err.status || null,
      models: [],
      error: err,
      isAuthError: false,
      isWrongProtocol: false,
      isCorsOrNetwork: isNetworkOrCorsError(err)
    };
  }
}

/**
 * 프롬프트를 chat messages 배열로 바꾼다.
 * - 문자열: user 메시지 하나
 * - { system, user }: 역할·규칙은 system, 자료는 user
 * 음성이 있으면 user 메시지에 input_audio 파트를 덧붙인다.
 */
export function buildChatMessages(prompt, audioPayload = null) {
  const isSplit = prompt && typeof prompt === "object";
  const systemText = isSplit ? String(prompt.system || "").trim() : "";
  const userText = isSplit ? String(prompt.user || "").trim() : String(prompt || "");

  const userContent = audioPayload
    ? [
        { type: "text", text: userText },
        {
          type: "input_audio",
          input_audio: {
            data: audioPayload.base64,
            format: mimeToAudioFormat(audioPayload.cleanMime)
          }
        }
      ]
    : userText;

  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  messages.push({ role: "user", content: userContent });
  return messages;
}

function extractMessageText(json) {
  const msgContent = json?.choices?.[0]?.message?.content;
  return Array.isArray(msgContent)
    ? msgContent.map((c) => c.text || "").join("")
    : (msgContent || "");
}

export async function callGatewayOpenAiEndpoint(args) {
  const { text } = await callGatewayOpenAiEndpointDetailed(args);
  return text;
}

/** callGatewayOpenAiEndpoint와 같지만 { text, usage, finishReason }을 돌려준다. */
export async function callGatewayOpenAiEndpointDetailed({
  baseUrl,
  apiKey,
  localProxyAvailable,
  modelId,
  prompt,
  audioPayload = null,
  options = {}
}) {
  const cacheKey = getJsonModeCacheKey(baseUrl, modelId);
  const isCachedUnsupported = jsonModeUnsupportedKeys.has(cacheKey);
  const effectiveUseJsonMode = options.useJsonMode !== false && !isCachedUnsupported;
  const allowAudioJsonFallback = Boolean(options.allowAudioJsonFallback);
  const isJsonFallbackRetry = Boolean(options._isJsonFallbackRetry);
  const maxTokens = options.maxTokens ?? null;

  const bodyObj = {
    model: modelId,
    temperature: options.temperature ?? 0.3,
    messages: buildChatMessages(prompt, audioPayload)
  };
  if (effectiveUseJsonMode) {
    bodyObj.response_format = { type: "json_object" };
  }
  if (typeof maxTokens === "number" && maxTokens > 0) {
    bodyObj.max_tokens = maxTokens;
  }

  const reqInfo = buildGatewayFetchRequest({
    path: "/v1/chat/completions",
    baseUrl,
    localProxyAvailable,
    extraHeaders: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const res = await fetch(reqInfo.url, {
    method: "POST",
    headers: reqInfo.headers,
    body: JSON.stringify(bodyObj)
  });

  if (res.ok) {
    const json = await res.json();
    const textPart = extractMessageText(json);
    const finishReason = json?.choices?.[0]?.finish_reason || "";
    if (!textPart && !options.allowEmptyText) {
      throw new Error(`응답 텍스트 없음 (${finishReason || "empty"})`);
    }
    if (isJsonFallbackRetry) {
      jsonModeUnsupportedKeys.add(cacheKey);
      options.onJsonModeFallback?.(modelId);
    }
    return { text: textPart, usage: json?.usage || null, finishReason };
  }

  const errText = await res.text();
  if (
    !isJsonFallbackRetry &&
    shouldRetryWithoutJsonMode({
      status: res.status,
      useJsonMode: effectiveUseJsonMode,
      errText,
      hasAudioPayload: Boolean(audioPayload),
      allowAudioJsonFallback
    })
  ) {
    return await callGatewayOpenAiEndpointDetailed({
      baseUrl,
      apiKey,
      localProxyAvailable,
      modelId,
      prompt,
      audioPayload,
      options: {
        ...options,
        useJsonMode: false,
        _isJsonFallbackRetry: true
      }
    });
  }

  const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 260)}`);
  err.status = res.status;
  if (
    audioPayload &&
    ([400, 415, 422, 501].includes(res.status) ||
      /(input_audio|audio|modality|unsupported.*content|invalid.*type|multimodal|format)/i.test(errText))
  ) {
    err.isAudioRejected = true;
  }
  throw err;
}

export async function callLLMWithFallback({
  baseUrl,
  apiKey,
  localProxyAvailable,
  selectedModel,
  customModel = "",
  syncedModels = [],
  prompt,
  audioPayload = null,
  allowAudioJsonFallback = false,
  onLog,
  onModelUsed,
  onProtocolDetected
}) {
  if (!baseUrl) {
    throw new Error("게이트웨이 API Base URL을 먼저 입력해 주세요. (또는 북마크 #api=주소 사용)");
  }
  if (!apiKey) {
    throw new Error("게이트웨이 OpenAI 호환 Virtual Key를 먼저 입력해 주세요.");
  }
  const hasPrompt = prompt && (typeof prompt === "string" ? prompt.trim() : String(prompt.user || "").trim());
  if (!hasPrompt) {
    throw new Error("내부 오류: 모델에 보낼 프롬프트가 비어 있습니다.");
  }

  const candidates = buildModelCandidates({
    selectedModel,
    customModel,
    syncedModels,
    requireAudio: Boolean(audioPayload)
  });
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const modelId = candidates[i];
    try {
      const textPart = await callGatewayOpenAiEndpoint({
        baseUrl,
        apiKey,
        localProxyAvailable,
        modelId,
        prompt,
        audioPayload,
        options: {
          allowAudioJsonFallback,
          onJsonModeFallback: (fallbackModelId) => {
            onLog?.(
              `${fallbackModelId}: response_format(JSON 모드) 미지원 감지 → 일반 JSON 텍스트 요청으로 자동 전환`,
              "info"
            );
          }
        }
      });
      onModelUsed?.(modelId);
      return { modelId, text: textPart };
    } catch (err) {
      if (isOpenAiProtocolDisallowedError(err)) {
        onProtocolDetected?.("wrong_protocol");
        const wrongErr = new Error(
          "현재 입력한 키는 OpenAI 호환 API(/v1/chat/completions) 권한이 없는 키입니다. 게이트웨이에서 OpenAI 호환 Virtual Key를 발급해 입력해 주세요."
        );
        wrongErr.status = 403;
        wrongErr.isOpenAiDisallowed = true;
        throw wrongErr;
      }

      if (err.status === 401 || err.status === 403) {
        throw new Error(`API 키 인증 오류 (HTTP ${err.status}): OpenAI 호환 Virtual Key가 유효한지 확인하세요. (${err.message})`);
      }

      if (err.isAudioRejected) {
        throw err;
      }

      if (isNetworkOrCorsError(err)) {
        throw new Error(formatCorsOrNetworkMessage(baseUrl, err.message, localProxyAvailable));
      }

      if ([404, 429, 500, 502, 503].includes(err.status)) {
        const reason = `HTTP ${err.status}`;
        errors.push(`${modelId}: ${reason}`);
        onLog?.(`${modelId} 실패(${reason}) → 다음 상위 모델로 폴백 시도`, "warn");
        continue;
      }

      errors.push(`${modelId}: ${err.message}`);
      if (i === candidates.length - 1) {
        throw new Error(`모델 호출에 모두 실패했습니다.\n- ${errors.join("\n- ")}`);
      }
    }
  }

  throw new Error(`사용 가능한 상위 모델을 찾지 못했습니다.\n- ${errors.join("\n- ")}`);
}

async function runTextCompatibilityProbe({
  baseUrl,
  apiKey,
  runtime,
  syncedModels,
  probeModel,
  textProbeModel,
  includeAudioProbe,
  audioOutcome = "rejected", // rejected(요청 거부) | dropped(통과했지만 음성 누락) | not_tested(대조 요청부터 실패)
  audioProbe = null,
  audioNote = "",
  onProgress
}) {
  const audioStepNote = {
    rejected: "오디오 미지원 확인 — ",
    dropped: "음성 누락 확인 — ",
    not_tested: ""
  }[audioOutcome] || "";
  onProgress?.({
    step: 3,
    stepText: includeAudioProbe
      ? `3/3 · ${audioStepNote}텍스트 초안 생성 점검 중 (${textProbeModel})...`
      : `3/3 · 텍스트 초안 생성 점검 중 (${textProbeModel})...`
  });

  let jsonModeFallbackUsed = isJsonModeUnsupportedCached(baseUrl, textProbeModel);
  try {
    await callGatewayOpenAiEndpoint({
      baseUrl,
      apiKey,
      localProxyAvailable: true,
      modelId: textProbeModel,
      prompt: 'Reply with JSON: {"ok":true}',
      audioPayload: null,
      options: {
        useJsonMode: true,
        maxTokens: 256,
        onJsonModeFallback: () => {
          jsonModeFallbackUsed = true;
        }
      }
    });

    if (includeAudioProbe) {
      const jsonFallbackNote = jsonModeFallbackUsed ? " · JSON 모드 미지원 자동 우회 적용" : "";
      const common = {
        runtime,
        syncedModels,
        probeModel,
        textProbeOk: true,
        textProbeModel,
        jsonModeSupported: !jsonModeFallbackUsed,
        audioProbe
      };
      if (audioOutcome === "not_tested") {
        return {
          ...common,
          status: "audio_inconclusive",
          message: "텍스트 초안 생성 정상 · 음성 전달 여부는 판정 보류",
          detail: `음성 점검용 대조 요청이 실패해 음성 전달 여부를 확인하지 못했습니다. ${textProbeModel} 텍스트 초안 생성은 정상 동작합니다${jsonFallbackNote}.`,
          nextAction: "기본 '실시간 받아적기' 모드로 쓰거나, 터미널에서 node tools/audio-probe.mjs로 다시 점검해 보세요."
        };
      }
      const reason = audioOutcome === "dropped"
        ? `게이트웨이가 음성 포함 요청을 받긴 했지만 음성이 모델까지 전달되지 않았습니다(${audioNote || "토큰 증가 없음"}).`
        : "게이트웨이가 16kHz WAV 직접 전송을 받지 않습니다.";
      return {
        ...common,
        status: "audio_unsupported",
        audioDropped: audioOutcome === "dropped",
        message: audioOutcome === "dropped"
          ? "텍스트 초안 생성 정상 · 음성이 모델까지 전달되지 않음"
          : "텍스트 초안 생성 정상 · 게이트웨이 오디오 직접 입력 미지원",
        detail: `${reason} ${textProbeModel} 텍스트 초안 생성은 정상 동작합니다${jsonFallbackNote}.`,
        nextAction: "일반 Google Chrome에서 그대로 '녹음 시작'을 누르면 실시간 한국어 받아적기로 자동 전환되어 초안을 만듭니다."
      };
    }

    const jsonFallbackNote = jsonModeFallbackUsed ? " · JSON 모드 자동 우회 적용" : "";
    return {
      status: "text_ready",
      runtime,
      syncedModels,
      probeModel: textProbeModel,
      textProbeOk: true,
      textProbeModel,
      jsonModeSupported: !jsonModeFallbackUsed,
      message: "연결 및 초안 생성 준비 완료",
      detail: `로컬 프록시(${runtime}) · OpenAI 호환 키 · ${textProbeModel} 텍스트 초안 생성이 정상 동작합니다${jsonFallbackNote}.`,
      nextAction: "이제 아래 '녹음 시작' 버튼을 눌러 일반 Google Chrome 실시간 받아적기로 대화를 시작하세요."
    };
  } catch (textErr) {
    if (isOpenAiProtocolDisallowedError(textErr)) {
      return {
        status: "wrong_key_protocol",
        runtime,
        syncedModels,
        probeModel,
        message: "OpenAI 호환 키가 필요합니다",
        detail: "현재 키는 OpenAI 호환(/v1/chat/completions) 권한이 없는 Anthropic 전용 키로 확인되었습니다.",
        nextAction: "게이트웨이에서 OpenAI 호환 Virtual Key를 발급해 입력해 주세요."
      };
    }
    if (textErr.status === 401 || textErr.status === 403) {
      return {
        status: "auth_error",
        httpStatus: textErr.status,
        runtime,
        syncedModels,
        probeModel,
        message: `API 키 인증 실패 (HTTP ${textErr.status})`,
        detail: textErr.message,
        nextAction: "OpenAI 호환 Virtual Key가 유효한지 확인해 주세요."
      };
    }
    if (isNetworkOrCorsError(textErr)) {
      return {
        status: "network_error",
        runtime,
        syncedModels,
        probeModel,
        message: "게이트웨이 네트워크 연결 오류",
        detail: textErr.message,
        nextAction: "인터넷 연결 또는 게이트웨이 Base URL을 확인해 주세요."
      };
    }
    const prefix = includeAudioProbe && audioOutcome !== "not_tested" ? "오디오 입력 미지원 확인 후 " : "";
    const statusSuffix = textErr.status ? ` (HTTP ${textErr.status})` : "";
    return {
      status: "text_probe_failed",
      httpStatus: textErr.status || null,
      runtime,
      syncedModels,
      probeModel,
      textProbeOk: false,
      textProbeModel,
      message: `텍스트 초안 생성 호출 실패${statusSuffix}`,
      detail: `${prefix}${textProbeModel} 텍스트 생성 테스트가 실패했습니다 (${textErr.message}).`,
      nextAction: "고급 설정에서 다른 모델(예: gpt-5.4-mini, claude-sonnet-4)을 선택하거나 키 권한을 확인해 주세요."
    };
  }
}

export async function runGatewayDiagnostics({ baseUrl, apiKey, includeAudioProbe = false, onProgress }) {
  onProgress?.({ step: 1, stepText: "1/3 · 로컬 프록시 연결 확인 중..." });
  const proxy = await checkLocalProxyHealth();
  if (!proxy.ok) {
    return {
      status: "proxy_missing",
      runtime: "",
      syncedModels: [],
      probeModel: "",
      message: "로컬 실행기(프록시)가 연결되지 않았습니다",
      detail: "CORS 차단을 피하려면 저장소 폴더에서 node server.mjs 또는 python3 server.py를 실행한 뒤 http://localhost:8765 로 열어 주세요.",
      nextAction: "서버 실행 후 상단 '로컬 프록시 다시 확인' 또는 연결 테스트를 다시 실행하세요."
    };
  }

  onProgress?.({ step: 2, stepText: "2/3 · OpenAI 호환 키 및 모델 목록 확인 중..." });
  const modelsRes = await fetchAvailableModels({
    baseUrl,
    apiKey,
    localProxyAvailable: true
  });

  if (modelsRes.isWrongProtocol) {
    return {
      status: "wrong_key_protocol",
      runtime: proxy.runtime,
      syncedModels: [],
      probeModel: "",
      message: "OpenAI 호환 키가 필요합니다",
      detail: "현재 키는 OpenAI 호환(/v1/models · /v1/chat/completions) 권한이 없는 Anthropic 전용 키입니다.",
      nextAction: "게이트웨이에서 OpenAI 호환 Virtual Key를 발급해 키 입력칸에 붙여넣어 주세요."
    };
  }

  if (modelsRes.isAuthError) {
    return {
      status: "auth_error",
      httpStatus: modelsRes.status,
      runtime: proxy.runtime,
      syncedModels: [],
      probeModel: "",
      message: `API 키 인증 실패 (HTTP ${modelsRes.status})`,
      detail: "게이트웨이 Virtual Key가 만료되었거나 오타가 있습니다.",
      nextAction: "Virtual Key를 다시 확인해 입력한 뒤 연결 테스트를 재실행하세요."
    };
  }

  if (modelsRes.isCorsOrNetwork) {
    return {
      status: "network_error",
      runtime: proxy.runtime,
      syncedModels: [],
      probeModel: "",
      message: "게이트웨이 네트워크 연결 오류",
      detail: modelsRes.error?.message || "요청을 전송할 수 없습니다.",
      nextAction: "인터넷 연결과 게이트웨이 Base URL 주소를 확인해 주세요."
    };
  }

  const syncedModels = modelsRes.models || [];
  const probeModel = syncedModels.find(isGatewayAudioCapableModel) || "gemini-3-flash";
  const textProbeModel = syncedModels[0] || probeModel;

  if (!includeAudioProbe) {
    return await runTextCompatibilityProbe({
      baseUrl,
      apiKey,
      runtime: proxy.runtime,
      syncedModels,
      probeModel: textProbeModel,
      textProbeModel,
      includeAudioProbe: false,
      onProgress
    });
  }

  onProgress?.({
    step: 3,
    stepText: `3/3 · 음성 전달 점검 중 (${probeModel}) — 음성 없는 요청과 토큰 수 비교...`
  });

  const textProbeArgs = { baseUrl, apiKey, runtime: proxy.runtime, syncedModels, probeModel, textProbeModel, onProgress };

  try {
    const judged = await probeAudioDelivery({ baseUrl, apiKey, localProxyAvailable: true, modelId: probeModel });
    const tokenNote = judged.diff === null
      ? "게이트웨이가 토큰 사용량(usage)을 돌려주지 않음"
      : `음성 없는 요청 ${judged.controlTokens}토큰 → 음성 ${AUDIO_PROBE_SECONDS}초 포함 ${judged.audioTokens}토큰 (차이 ${judged.diff}, 예상 약 ${judged.expected})`;

    if (judged.verdict === "delivered") {
      return {
        status: "audio_supported",
        runtime: proxy.runtime,
        syncedModels,
        probeModel,
        audioProbe: judged,
        message: "연결 및 음성 직접 분석 준비 완료",
        detail: `로컬 프록시(${proxy.runtime}) · OpenAI 호환 키 · ${probeModel}에 음성이 실제로 전달됩니다. ${tokenNote}.`,
        nextAction: "이제 아래 '녹음 시작' 버튼을 눌러 동료평가 대화를 바로 녹음하세요."
      };
    }

    if (judged.verdict === "dropped") {
      return await runTextCompatibilityProbe({
        ...textProbeArgs,
        includeAudioProbe: true,
        audioOutcome: "dropped",
        audioProbe: judged,
        audioNote: tokenNote
      });
    }

    return {
      status: "audio_inconclusive",
      runtime: proxy.runtime,
      syncedModels,
      probeModel,
      textProbeOk: true,
      audioProbe: judged,
      message: "텍스트 연결 정상 · 음성 전달 여부는 판정 보류",
      detail: `음성 포함 요청은 통과했지만 ${tokenNote}이라 음성이 모델까지 갔는지 확인할 수 없습니다.`,
      nextAction: "기본 '실시간 받아적기' 모드로 쓰거나, 터미널에서 node tools/audio-probe.mjs로 받아적기 기반 점검을 해 보세요."
    };
  } catch (err) {
    if (err.probeStage === "control") {
      // 음성 없는 요청부터 실패하면 텍스트 점검 경로에서 원인(키·네트워크·모델)을 가린다.
      return await runTextCompatibilityProbe({ ...textProbeArgs, includeAudioProbe: true, audioOutcome: "not_tested" });
    }
    if (isOpenAiProtocolDisallowedError(err)) {
      return {
        status: "wrong_key_protocol",
        runtime: proxy.runtime,
        syncedModels,
        probeModel,
        message: "OpenAI 호환 키가 필요합니다",
        detail: "현재 키는 OpenAI 호환(/v1/chat/completions) 권한이 없는 Anthropic 전용 키로 확인되었습니다.",
        nextAction: "게이트웨이에서 OpenAI 호환 Virtual Key를 발급해 입력해 주세요."
      };
    }

    if (err.status === 401 || err.status === 403) {
      return {
        status: "auth_error",
        httpStatus: err.status,
        runtime: proxy.runtime,
        syncedModels,
        probeModel,
        message: `API 키 인증 실패 (HTTP ${err.status})`,
        detail: err.message,
        nextAction: "OpenAI 호환 Virtual Key가 유효한지 확인해 주세요."
      };
    }

    if (err.isAudioRejected || [400, 415, 422, 501].includes(err.status)) {
      return await runTextCompatibilityProbe({ ...textProbeArgs, includeAudioProbe: true, audioOutcome: "rejected" });
    }

    if (isNetworkOrCorsError(err)) {
      return {
        status: "network_error",
        runtime: proxy.runtime,
        syncedModels,
        probeModel,
        message: "게이트웨이 네트워크 연결 오류",
        detail: err.message,
        nextAction: "인터넷 연결 또는 게이트웨이 Base URL을 확인해 주세요."
      };
    }

    return {
      status: "unknown_error",
      httpStatus: err.status || null,
      runtime: proxy.runtime,
      syncedModels,
      probeModel,
      message: `진단 예외 (HTTP ${err.status || "?"})`,
      detail: err.message,
      nextAction: "잠시 후 다시 진단하거나 고급 설정에서 다른 모델을 선택해 보세요."
    };
  }
}

export async function sendAudioOrTranscriptAndDispose({
  blob,
  rawMime,
  promptAudio,
  promptTranscript,
  label,
  transcriptText,
  uploadMode,
  gatewayAudioSupport,
  keyProtocolScope,
  selectedModel,
  customModel,
  syncedModels,
  baseUrl,
  apiKey,
  localProxyAvailable,
  onLog,
  onModelUsed,
  onAudioSupportDetected,
  onProtocolDetected
}) {
  const cleanTranscript = String(transcriptText || "").trim();

  if (keyProtocolScope === "wrong_protocol") {
    blob = null;
    throw new Error(
      "현재 키는 OpenAI 호환 API 권한이 없습니다. 게이트웨이에서 OpenAI 호환 Virtual Key를 발급해 입력해 주세요."
    );
  }

  // 1) 음성 외부 무전송 모드
  if (uploadMode === "speech_text_only") {
    blob = null;
    if (!cleanTranscript) {
      throw new Error("음성 외부 무전송 모드인데 수집된 대본이 비어 있습니다. 일반 Google Chrome으로 녹음하거나 보조 대본 칸에 내용을 입력해 주세요.");
    }
    onLog?.(`${label}: 음성 외부 무전송 — 대본(${cleanTranscript.length}자)만 게이트웨이로 전송`, "ok");
    return await callLLMWithFallback({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      prompt: promptTranscript,
      audioPayload: null,
      onLog,
      onModelUsed,
      onProtocolDetected
    });
  }

  // 2) 이전 진단/요청에서 게이트웨이 오디오 미지원 판명 시 Chrome 실시간 대본으로 자동 전환
  if (uploadMode === "hybrid_auto" && gatewayAudioSupport === "unsupported") {
    blob = null;
    if (!cleanTranscript) {
      throw new Error(
        "게이트웨이가 오디오 직접 입력을 지원하지 않아 Chrome 실시간 받아적기 또는 보조 대본이 필요합니다.\n" +
        "일반 Google Chrome에서 다시 녹음하거나 아래 보조 대본 칸을 확인해 주세요."
      );
    }
    onLog?.(`${label}: 오디오 미지원 게이트웨이 — 음성을 즉시 폐기하고 실시간 대본(${cleanTranscript.length}자)으로 자동 분석`, "info");
    return await callLLMWithFallback({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      prompt: promptTranscript,
      audioPayload: null,
      onLog,
      onModelUsed,
      onProtocolDetected
    });
  }

  // 3) 텍스트 전용 모델이 명시적으로 선택된 경우
  const isExplicitTextOnly =
    selectedModel &&
    selectedModel !== "auto" &&
    selectedModel !== "__custom__" &&
    !isGatewayAudioCapableModel(selectedModel);
  if (isExplicitTextOnly) {
    blob = null;
    if (uploadMode === "audio_only_force" || !cleanTranscript) {
      throw new Error(`선택한 모델(${selectedModel})은 텍스트 전용입니다. 고급 설정에서 모델을 '자동' 또는 'gemini-3-flash'로 바꾸거나 대본을 입력해 주세요.`);
    }
    onLog?.(`${label}: ${selectedModel}은 텍스트 전용 모델이므로 음성을 즉시 폐기하고 대본(${cleanTranscript.length}자)으로 분석`, "info");
    return await callLLMWithFallback({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      prompt: promptTranscript,
      audioPayload: null,
      onLog,
      onModelUsed,
      onProtocolDetected
    });
  }

  if (!blob) {
    if (!cleanTranscript) throw new Error("분석할 음성이나 대본이 없습니다.");
    return await callLLMWithFallback({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      prompt: promptTranscript,
      audioPayload: null,
      onLog,
      onModelUsed,
      onProtocolDetected
    });
  }

  // 4) 음성 전달 여부를 아직 모르면, 실제 녹음을 보내기 전에 짧은 신호음으로 토큰 비교 점검을 한다.
  //    HTTP 200만 보고 '지원됨'으로 믿으면, 게이트웨이가 음성을 버린 채 대본·메모만으로 지어낸 결과를 받을 수 있다.
  let deliveryUnverified = false;
  if (gatewayAudioSupport === "unknown") {
    const check = await checkAudioDeliveryBeforeSend({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      onLog,
      label
    });
    if (check === "delivered") {
      onAudioSupportDetected?.("supported");
    } else if (check === "dropped" || check === "rejected") {
      blob = null;
      onAudioSupportDetected?.("unsupported");
      const why = check === "dropped"
        ? "게이트웨이가 음성을 받긴 하지만 모델까지 전달하지 않아(토큰 증가 없음)"
        : "게이트웨이가 오디오 직접 입력을 받지 않아";
      if (uploadMode !== "audio_only_force" && cleanTranscript) {
        onLog?.(`${label}: ${why} 로컬 음성을 폐기하고 실시간 대본(${cleanTranscript.length}자)으로 자동 전환합니다.`, "warn");
        return await callLLMWithFallback({
          baseUrl,
          apiKey,
          localProxyAvailable,
          selectedModel,
          customModel,
          syncedModels,
          prompt: promptTranscript,
          audioPayload: null,
          onLog,
          onModelUsed,
          onProtocolDetected
        });
      }
      throw new Error(
        `${why} 음성으로 분석할 수 없습니다. 백업 대본도 비어 있습니다.\n` +
        `일반 Google Chrome에서 녹음해 실시간 받아적기가 동작하게 하거나 아래 보조 대본 칸에 내용을 입력해 주세요.`
      );
    } else {
      deliveryUnverified = true;
    }
  }

  // 5) 표준 16kHz 모노 WAV 변환 후 인라인 전송 시도
  const originalMime = normalizeAudioMimeType(rawMime || blob.type);
  const wavConverted = await convertAudioBlobToWav16kMono(blob, (msg) => onLog?.(msg, "warn"));
  blob = null;
  let sendBlob = wavConverted.blob;
  const cleanMime = wavConverted.cleanMime || originalMime;

  if (wavConverted.converted) {
    onLog?.(`${label}: 16kHz 모노 WAV 변환 완료 (${formatBytes(sendBlob.size)})`, "info");
  }

  if (sendBlob.size > INLINE_SAFE_LIMIT_BYTES) {
    sendBlob = null;
    if (uploadMode !== "audio_only_force" && cleanTranscript) {
      onLog?.(`${label}: WAV 크기 15MB 초과 — 음성을 폐기하고 대본(${cleanTranscript.length}자)으로 자동 전환`, "warn");
      return await callLLMWithFallback({
        baseUrl,
        apiKey,
        localProxyAvailable,
        selectedModel,
        customModel,
        syncedModels,
        prompt: promptTranscript,
        audioPayload: null,
        onLog,
        onModelUsed,
        onProtocolDetected
      });
    }
    throw new Error("오디오 WAV 크기가 15MB(약 6분) 인라인 한도를 초과했습니다. '구간 요약'으로 나누거나 대본 백업을 이용해 주세요.");
  }

  let b64 = await blobToBase64(sendBlob);
  const sendSize = sendBlob.size;
  sendBlob = null;

  try {
    onLog?.(`${label}: 게이트웨이 오디오 인라인 전송 시도 (${formatBytes(sendSize)}, ${cleanMime})`, "info");
    const result = await callLLMWithFallback({
      baseUrl,
      apiKey,
      localProxyAvailable,
      selectedModel,
      customModel,
      syncedModels,
      prompt: promptAudio,
      audioPayload: { base64: b64, cleanMime },
      allowAudioJsonFallback: gatewayAudioSupport === "supported",
      onLog,
      onModelUsed,
      onProtocolDetected
    });
    if (deliveryUnverified) {
      onLog?.(
        `${label}: 게이트웨이가 토큰 사용량을 알려주지 않아 음성이 모델까지 갔는지 확인하지 못했습니다. 결과가 대화와 다르면 '실시간 받아적기' 모드를 쓰세요.`,
        "warn"
      );
    }
    return result;
  } catch (err) {
    if (err.isOpenAiDisallowed) {
      throw err;
    }
    if (err.isAudioRejected || err.isTextOnlyModel) {
      onAudioSupportDetected?.("unsupported");
      if (uploadMode !== "audio_only_force" && cleanTranscript) {
        onLog?.(
          `${label}: 게이트웨이가 오디오 직접 입력을 받지 않아(${err.message.slice(0, 70)}) 로컬 음성을 폐기하고 실시간 대본(${cleanTranscript.length}자)으로 자동 전환합니다.`,
          "warn"
        );
        return await callLLMWithFallback({
          baseUrl,
          apiKey,
          localProxyAvailable,
          selectedModel,
          customModel,
          syncedModels,
          prompt: promptTranscript,
          audioPayload: null,
          onLog,
          onModelUsed,
          onProtocolDetected
        });
      }
      throw new Error(
        `게이트웨이가 오디오 직접 입력을 지원하지 않으며(${err.message}), 백업 대본도 비어 있습니다.\n` +
        `일반 Google Chrome에서 녹음해 실시간 받아적기가 동작하게 하거나 아래 보조 대본 칸에 내용을 입력해 주세요.`
      );
    }
    throw err;
  } finally {
    b64 = null;
    sendBlob = null;
  }
}
