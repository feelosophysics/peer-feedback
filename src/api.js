import {
  GATEWAY_MODEL_CATALOG,
  INLINE_SAFE_LIMIT_BYTES,
  TARGET_WAV_SAMPLE_RATE
} from "./constants.js";
import {
  blobToBase64,
  convertAudioBlobToWav16kMono,
  createSilentWavBlob
} from "./audio.js";
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
    return;
  }
  const prefix = `${String(baseUrl).trim()}::`;
  for (const key of jsonModeUnsupportedKeys) {
    if (key.startsWith(prefix)) {
      jsonModeUnsupportedKeys.delete(key);
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

export async function callGatewayOpenAiEndpoint({
  baseUrl,
  apiKey,
  localProxyAvailable,
  modelId,
  promptText,
  audioPayload = null,
  options = {}
}) {
  const cacheKey = getJsonModeCacheKey(baseUrl, modelId);
  const isCachedUnsupported = jsonModeUnsupportedKeys.has(cacheKey);
  const effectiveUseJsonMode = options.useJsonMode !== false && !isCachedUnsupported;
  const allowAudioJsonFallback = Boolean(options.allowAudioJsonFallback);
  const isJsonFallbackRetry = Boolean(options._isJsonFallbackRetry);
  const maxTokens = options.maxTokens ?? null;

  const content = audioPayload
    ? [
        { type: "text", text: promptText },
        {
          type: "input_audio",
          input_audio: {
            data: audioPayload.base64,
            format: mimeToAudioFormat(audioPayload.cleanMime)
          }
        }
      ]
    : promptText;

  const bodyObj = {
    model: modelId,
    temperature: 0.3,
    messages: [{ role: "user", content }]
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
    const msgContent = json?.choices?.[0]?.message?.content;
    const textPart = Array.isArray(msgContent)
      ? msgContent.map((c) => c.text || "").join("")
      : (msgContent || "");
    if (!textPart) {
      throw new Error(`응답 텍스트 없음 (${json?.choices?.[0]?.finish_reason || "empty"})`);
    }
    if (isJsonFallbackRetry) {
      jsonModeUnsupportedKeys.add(cacheKey);
      options.onJsonModeFallback?.(modelId);
    }
    return textPart;
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
    return await callGatewayOpenAiEndpoint({
      baseUrl,
      apiKey,
      localProxyAvailable,
      modelId,
      promptText,
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
  promptText,
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
        promptText,
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
  onProgress
}) {
  onProgress?.({
    step: 3,
    stepText: includeAudioProbe
      ? `3/3 · 오디오 미지원 확인 — 텍스트 초안 생성 점검 중 (${textProbeModel})...`
      : `3/3 · 텍스트 초안 생성 점검 중 (${textProbeModel})...`
  });

  let jsonModeFallbackUsed = isJsonModeUnsupportedCached(baseUrl, textProbeModel);
  try {
    await callGatewayOpenAiEndpoint({
      baseUrl,
      apiKey,
      localProxyAvailable: true,
      modelId: textProbeModel,
      promptText: 'Reply with JSON: {"ok":true}',
      audioPayload: null,
      options: {
        useJsonMode: true,
        maxTokens: 16,
        onJsonModeFallback: () => {
          jsonModeFallbackUsed = true;
        }
      }
    });

    if (includeAudioProbe) {
      const jsonFallbackNote = jsonModeFallbackUsed ? " · JSON 모드 미지원 자동 우회 적용" : "";
      return {
        status: "audio_unsupported",
        runtime,
        syncedModels,
        probeModel,
        textProbeOk: true,
        textProbeModel,
        jsonModeSupported: !jsonModeFallbackUsed,
        message: "텍스트 초안 생성 정상 · 게이트웨이 오디오 직접 입력 미지원",
        detail: `게이트웨이가 16kHz WAV 직접 전송을 받지 않지만, ${textProbeModel} 텍스트 초안 생성은 정상 동작합니다${jsonFallbackNote}.`,
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
    const prefix = includeAudioProbe ? "오디오 입력 미지원 확인 후 " : "";
    return {
      status: "text_probe_failed",
      httpStatus: textErr.status || null,
      runtime,
      syncedModels,
      probeModel,
      textProbeOk: false,
      textProbeModel,
      message: `텍스트 초안 생성 호출 실패 (HTTP ${textErr.status || "?"})`,
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

  onProgress?.({ step: 3, stepText: `3/3 · 16kHz WAV 오디오 입력 테스트 중 (${probeModel})...` });

  const silentWav = createSilentWavBlob(0.4, TARGET_WAV_SAMPLE_RATE);
  const silentB64 = await blobToBase64(silentWav);

  try {
    await callGatewayOpenAiEndpoint({
      baseUrl,
      apiKey,
      localProxyAvailable: true,
      modelId: probeModel,
      promptText: "Reply with OK.",
      audioPayload: { base64: silentB64, cleanMime: "audio/wav" },
      options: { useJsonMode: false, maxTokens: 16 }
    });

    return {
      status: "audio_supported",
      runtime: proxy.runtime,
      syncedModels,
      probeModel,
      message: "연결 및 음성 직접 분석 준비 완료",
      detail: `로컬 프록시(${proxy.runtime}) · OpenAI 호환 키 · ${probeModel} 16kHz WAV 오디오 입력이 정상 동작합니다.`,
      nextAction: "이제 아래 '녹음 시작' 버튼을 눌러 동료평가 대화를 바로 녹음하세요."
    };
  } catch (err) {
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
      return await runTextCompatibilityProbe({
        baseUrl,
        apiKey,
        runtime: proxy.runtime,
        syncedModels,
        probeModel,
        textProbeModel,
        includeAudioProbe: true,
        onProgress
      });
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
  promptTextAudio,
  promptTextTranscript,
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
      promptText: promptTextTranscript,
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
      promptText: promptTextTranscript,
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
      promptText: promptTextTranscript,
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
      promptText: promptTextTranscript,
      audioPayload: null,
      onLog,
      onModelUsed,
      onProtocolDetected
    });
  }

  // 4) 표준 16kHz 모노 WAV 변환 후 인라인 전송 시도
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
        promptText: promptTextTranscript,
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
      promptText: promptTextAudio,
      audioPayload: { base64: b64, cleanMime },
      allowAudioJsonFallback: gatewayAudioSupport === "supported",
      onLog,
      onModelUsed,
      onProtocolDetected
    });
    if (gatewayAudioSupport === "unknown") {
      onAudioSupportDetected?.("supported");
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
          promptText: promptTextTranscript,
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
