import {
  CHUNK_TIMESLICE_MS,
  SEGMENT_ROTATE_SECONDS,
  STORE_CHUNKS,
  STORE_NOTES
} from "./constants.js";
import {
  formatBytes,
  formatDuration,
  formatMMSS,
  generateId,
  normalizeGatewayBaseUrl,
  parseModelJson
} from "./utils.js";
import {
  createMediaRecorderForStream,
  getSupportedMimeType
} from "./audio.js";
import {
  buildRefineFromPointsPrompt,
  buildSegmentExtractPrompt,
  buildSegmentTranscriptPrompt,
  buildSingleShotAudioPrompt,
  buildSingleShotTranscriptPrompt,
  buildSynthesizeFromNotesPrompt
} from "./prompts.js";
import {
  calcIdbChunkBytes,
  clearIdbStore,
  clearStoredGatewayConfig,
  deleteSegmentChunksFromIdb,
  getAllIdbRecords,
  loadStoredGatewayConfig,
  openDb,
  replaceSegmentChunksWithFullBlobInIdb,
  saveActiveChunkToIdb,
  saveExtractedNoteToIdb,
  saveStoredGatewayBaseUrl,
  saveStoredGatewayConfig
} from "./storage.js";
import {
  callLLMWithFallback,
  checkLocalProxyHealth,
  fetchAvailableModels,
  resetGatewayFeatureCache,
  runGatewayDiagnostics,
  sendAudioOrTranscriptAndDispose
} from "./api.js";
import { createSpeechController } from "./speech.js";
import {
  addAuditLog,
  collectElements,
  copyTextToClipboard,
  drawIdleWaveform,
  renderChunkPills,
  renderDiagnosticsBox,
  renderModelSelectOptions,
  renderPointsList,
  renderResults,
  setSpeechBadge,
  showError,
  startWaveform,
  updateCharCount,
  updateConnectionIndicators,
  updateRecordingButtons,
  updateStatusBadge,
  updateStorageIndicators
} from "./ui.js";

const el = collectElements();

const state = {
  db: null,
  sessionId: generateId("sess"),
  recordingState: "idle", // idle | recording | paused | stopping
  mediaStream: null,
  mediaRecorder: null,
  activeMimeType: "",
  currentSegmentIndex: 1,
  currentChunkSeq: 0,
  currentRamChunks: [],
  currentRamBytes: 0,
  idbCachedBytes: 0,
  totalActiveSeconds: 0,
  segmentActiveSeconds: 0,
  timerInterval: null,
  stopWaveformFn: null,
  isRotating: false,
  pendingSegmentTasks: [],
  segmentStatuses: [],
  extractedSegmentNotes: [],
  syncedModels: [],
  localProxyAvailable: false,
  localProxyRuntime: "",
  gatewayAudioSupport: "unknown", // unknown | supported | unsupported
  keyProtocolScope: "unknown", // unknown | openai_ok | wrong_protocol
  finalResult: null,
  isBusy: false
};

const speech = createSpeechController({
  onFinalChunk: (txt) => {
    const prevBox = el.liveTranscriptTextarea.value.trim();
    el.liveTranscriptTextarea.value = prevBox ? `${prevBox}\n${txt}` : txt;
    el.liveTranscriptTextarea.scrollTop = el.liveTranscriptTextarea.scrollHeight;
  },
  onInterim: (interim) => {
    el.speechInterimLine.textContent = interim ? `인식 중: ${interim}` : "";
  },
  onStatusChange: (mode, text) => {
    setSpeechBadge(el, mode, text);
  },
  onLog: (msg, level) => addAuditLog(el, msg, level)
});

function getGatewayBaseUrl() {
  return normalizeGatewayBaseUrl(el.gatewayBaseUrlInput.value);
}

function getApiKey() {
  return el.apiKeyInput.value.trim();
}

function getSelectedModelRaw() {
  const val = el.modelSelect.value;
  if (val === "__custom__") {
    return el.customModelInput.value.trim().replace(/^models\//, "");
  }
  return val;
}

function syncStorageIndicators() {
  updateStorageIndicators(el, {
    currentRamBytes: state.currentRamBytes,
    idbCachedBytes: state.idbCachedBytes
  });
}

function syncConnectionIndicators() {
  updateConnectionIndicators(el, {
    localProxyAvailable: state.localProxyAvailable,
    localProxyRuntime: state.localProxyRuntime,
    gatewayAudioSupport: state.gatewayAudioSupport,
    keyProtocolScope: state.keyProtocolScope,
    uploadMode: el.uploadModeSelect.value
  });
}

function syncUploadModeUi() {
  const isTextOnly = el.uploadModeSelect.value === "speech_text_only";
  if (el.bufferMetricItem) el.bufferMetricItem.classList.toggle("hidden", isTextOnly);
  if (el.btnImportFile) el.btnImportFile.classList.toggle("hidden", isTextOnly);
  syncConnectionIndicators();
}

function syncRecordingButtons() {
  updateRecordingButtons(el, {
    recordingState: state.recordingState,
    isBusy: state.isBusy
  });
}

async function recalcIdbBytes() {
  state.idbCachedBytes = await calcIdbChunkBytes(state.db);
  syncStorageIndicators();
}

async function detectLocalProxy(logResult = false) {
  const health = await checkLocalProxyHealth();
  state.localProxyAvailable = health.ok;
  state.localProxyRuntime = health.runtime || "";

  if (health.ok) {
    el.proxyNoticeBanner.classList.remove("visible");
    syncConnectionIndicators();
    if (logResult) {
      addAuditLog(el, `로컬 프록시 연결 확인됨 (CORS 해결됨 · runtime: ${state.localProxyRuntime})`, "ok");
    }
    return true;
  }

  el.proxyNoticeBanner.classList.add("visible");
  syncConnectionIndicators();
  if (logResult) {
    addAuditLog(el, "로컬 프록시(/api/health)가 감지되지 않아 실행 안내 배너를 표시했습니다.", "warn");
  }
  return false;
}

async function handleSyncModels(silent = false) {
  const baseUrl = getGatewayBaseUrl();
  if (!baseUrl) {
    if (!silent) {
      showError(el, "게이트웨이 API Base URL을 먼저 입력해 주세요.");
      el.gatewayBaseUrlInput.focus();
    }
    return [];
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    if (!silent) {
      showError(el, "모델 목록을 동기화하려면 먼저 게이트웨이 OpenAI 호환 Virtual Key를 입력하세요.");
      el.apiKeyInput.focus();
    }
    return [];
  }

  if (!silent) el.modelSyncStatus.textContent = "사용 가능 모델 목록 조회 중...";

  const res = await fetchAvailableModels({
    baseUrl,
    apiKey,
    localProxyAvailable: state.localProxyAvailable
  });

  if (res.ok) {
    state.syncedModels = res.models;
    renderModelSelectOptions(el, state.syncedModels);
    el.modelSyncStatus.textContent = res.models.length > 0
      ? `게이트웨이 동기화 완료: 상위 CHAT 모델 ${res.models.length}개 확인됨`
      : "필터 조건에 맞는 모델이 목록에 없어 기본 게이트웨이 카탈로그를 사용합니다.";
    if (res.models.length > 0) {
      addAuditLog(el, `게이트웨이 상위 CHAT 모델 ${res.models.length}개 동기화 완료`, "ok");
    }
    return res.models;
  }

  if (res.isWrongProtocol) {
    state.keyProtocolScope = "wrong_protocol";
    syncConnectionIndicators();
    el.modelSyncStatus.textContent = "OpenAI 호환 키가 아닙니다 (Anthropic 전용 키 감지).";
    if (!silent) {
      showError(el, "현재 키는 OpenAI 호환 API 권한이 없습니다. OpenAI 호환 Virtual Key를 입력해 주세요.");
    }
    return [];
  }

  if (res.isAuthError) {
    el.modelSyncStatus.textContent = `API 키 인증 실패 (HTTP ${res.status}): Virtual Key를 확인하세요.`;
    if (!silent) {
      showError(el, `API 키 인증 오류 (HTTP ${res.status}): 게이트웨이 Virtual Key가 유효한지 확인하세요.`);
      addAuditLog(el, `모델 목록 동기화 인증 오류: HTTP ${res.status}`, "err");
    }
    return [];
  }

  const corsHint = res.isCorsOrNetwork && !state.localProxyAvailable
    ? " (CORS 차단 — 로컬 실행기 http://localhost:8765 에서 여세요)"
    : "";
  el.modelSyncStatus.textContent = `모델 목록 조회 실패 (기본 목록으로 진행): ${res.error?.message || ""}${corsHint}`;
  if (!silent) {
    addAuditLog(el, `모델 목록 동기화 실패: ${res.error?.message || ""}${corsHint}`, "warn");
  }
  return [];
}

async function handleDiagnoseGateway() {
  showError(el, "");

  const baseUrl = getGatewayBaseUrl();
  if (!baseUrl) {
    renderDiagnosticsBox(el, {
      variant: "error",
      title: "게이트웨이 Base URL을 입력해 주세요",
      detail: "OpenAI 호환 게이트웨이 주소가 비어 있습니다.",
      hint: "예: https://api.example.com (또는 북마크 #api=주소)",
      actionLabel: "URL 입력칸으로 이동",
      onAction: () => el.gatewayBaseUrlInput.focus()
    });
    el.gatewayBaseUrlInput.focus();
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    renderDiagnosticsBox(el, {
      variant: "error",
      title: "OpenAI 호환 Virtual Key를 입력해 주세요",
      detail: "진단을 실행하려면 상단 Virtual Key 입력칸에 키가 필요합니다.",
      actionLabel: "키 입력칸으로 이동",
      onAction: () => el.apiKeyInput.focus()
    });
    el.apiKeyInput.focus();
    return;
  }

  const includeAudioProbe = el.uploadModeSelect.value !== "speech_text_only";
  const stepLabels = includeAudioProbe
    ? ["1. 로컬 프록시", "2. 키·모델 확인", "3. 오디오·텍스트 점검"]
    : ["1. 로컬 프록시", "2. 키·모델 확인", "3. 텍스트 생성 점검"];

  el.btnDiagnoseGateway.disabled = true;
  renderDiagnosticsBox(el, {
    variant: "loading",
    stepIndex: 1,
    stepLabels,
    title: "게이트웨이 연결 테스트 중...",
    detail: includeAudioProbe
      ? "로컬 프록시, OpenAI 호환 키, 오디오·텍스트 호환성을 차례로 확인합니다."
      : "로컬 프록시, OpenAI 호환 키, 텍스트 초안 생성을 차례로 확인합니다."
  });

  try {
    const result = await runGatewayDiagnostics({
      baseUrl,
      apiKey,
      includeAudioProbe,
      onProgress: ({ step, stepText }) => {
        el.statGatewayAudio.textContent = stepText;
        renderDiagnosticsBox(el, {
          variant: "loading",
          stepIndex: step,
          stepLabels,
          title: stepText,
          detail: "잠시만 기다려 주세요 (약 1–2초 소요)."
        });
      }
    });

    if (result.syncedModels && result.syncedModels.length > 0) {
      state.syncedModels = result.syncedModels;
      renderModelSelectOptions(el, state.syncedModels);
      el.modelSyncStatus.textContent = `게이트웨이 동기화 완료: 상위 CHAT 모델 ${result.syncedModels.length}개 확인됨`;
    }

    if (result.status === "proxy_missing") {
      state.localProxyAvailable = false;
      el.proxyNoticeBanner.classList.add("visible");
      syncConnectionIndicators();
      addAuditLog(el, `연결 테스트 중단: ${result.message}`, "err");
      renderDiagnosticsBox(el, {
        variant: "error",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction,
        actionLabel: "로컬 프록시 다시 확인",
        onAction: () => detectLocalProxy(true)
      });
      return;
    }

    state.localProxyAvailable = true;
    state.localProxyRuntime = result.runtime || state.localProxyRuntime;
    el.proxyNoticeBanner.classList.remove("visible");

    if (result.status === "text_ready") {
      state.keyProtocolScope = "openai_ok";
      syncConnectionIndicators();
      addAuditLog(
        el,
        `연결 테스트 완료: 프록시(${result.runtime}) + OpenAI 호환 키 + ${result.textProbeModel} 텍스트 생성 확인됨`,
        "ok"
      );
      renderDiagnosticsBox(el, {
        variant: "success",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction,
        actionLabel: "설정 접고 녹음하기",
        onAction: () => {
          if (el.setupDetails) el.setupDetails.open = false;
          el.btnStartRec.focus();
        }
      });
      return;
    }

    if (result.status === "audio_supported") {
      state.keyProtocolScope = "openai_ok";
      state.gatewayAudioSupport = "supported";
      syncConnectionIndicators();
      addAuditLog(el, `진단 완료: 프록시(${result.runtime}) + OpenAI 호환 키 + ${result.probeModel} 16kHz WAV 입력 확인됨`, "ok");
      renderDiagnosticsBox(el, {
        variant: "success",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction,
        actionLabel: "설정 접고 녹음하기",
        onAction: () => {
          if (el.setupDetails) el.setupDetails.open = false;
          el.btnStartRec.focus();
        }
      });
      return;
    }

    if (result.status === "audio_unsupported") {
      state.keyProtocolScope = "openai_ok";
      state.gatewayAudioSupport = "unsupported";
      syncConnectionIndicators();
      if (el.transcriptDetails) el.transcriptDetails.open = true;
      addAuditLog(el, `진단 결과: ${result.message} — ${result.detail}`, "warn");
      renderDiagnosticsBox(el, {
        variant: "warn",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction,
        actionLabel: "녹음 버튼으로 이동",
        onAction: () => el.btnStartRec.focus()
      });
      return;
    }

    if (result.status === "wrong_key_protocol") {
      state.keyProtocolScope = "wrong_protocol";
      state.gatewayAudioSupport = "unknown";
      syncConnectionIndicators();
      addAuditLog(el, `진단 결과: ${result.message} — ${result.detail}`, "err");
      renderDiagnosticsBox(el, {
        variant: "error",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction,
        actionLabel: "키 입력칸으로 이동",
        onAction: () => el.apiKeyInput.focus()
      });
      return;
    }

    if (
      result.status === "auth_error" ||
      result.status === "network_error" ||
      result.status === "text_probe_failed" ||
      result.status === "unknown_error"
    ) {
      if (result.status === "text_probe_failed") {
        state.keyProtocolScope = "openai_ok";
        state.gatewayAudioSupport = "unsupported";
      }
      syncConnectionIndicators();
      addAuditLog(el, `진단 실패: ${result.message} (${result.detail})`, "err");
      renderDiagnosticsBox(el, {
        variant: result.status === "unknown_error" ? "warn" : "error",
        title: result.message,
        detail: result.detail,
        hint: result.nextAction
      });
    }
  } finally {
    el.btnDiagnoseGateway.disabled = false;
  }
}

async function runLLM(promptText, audioPayload = null) {
  return await callLLMWithFallback({
    baseUrl: getGatewayBaseUrl(),
    apiKey: getApiKey(),
    localProxyAvailable: state.localProxyAvailable,
    selectedModel: el.modelSelect.value,
    customModel: el.customModelInput.value,
    syncedModels: state.syncedModels,
    promptText,
    audioPayload,
    onLog: (msg, level) => addAuditLog(el, msg, level),
    onModelUsed: (modelId) => {
      el.statUsedModel.textContent = modelId;
    },
    onProtocolDetected: (scope) => {
      state.keyProtocolScope = scope;
      syncConnectionIndicators();
    }
  });
}

async function dispatchAudioOrTranscript({ blob, rawMime, promptTextAudio, promptTextTranscript, label, transcriptText }) {
  return await sendAudioOrTranscriptAndDispose({
    blob,
    rawMime,
    promptTextAudio,
    promptTextTranscript,
    label,
    transcriptText,
    uploadMode: el.uploadModeSelect.value,
    gatewayAudioSupport: state.gatewayAudioSupport,
    keyProtocolScope: state.keyProtocolScope,
    selectedModel: getSelectedModelRaw(),
    customModel: el.customModelInput.value,
    syncedModels: state.syncedModels,
    baseUrl: getGatewayBaseUrl(),
    apiKey: getApiKey(),
    localProxyAvailable: state.localProxyAvailable,
    onLog: (msg, level) => addAuditLog(el, msg, level),
    onModelUsed: (modelId) => {
      el.statUsedModel.textContent = modelId;
    },
    onAudioSupportDetected: (support) => {
      state.gatewayAudioSupport = support;
      if (support === "unsupported" && el.transcriptDetails) {
        el.transcriptDetails.open = true;
      }
      syncConnectionIndicators();
    },
    onProtocolDetected: (scope) => {
      state.keyProtocolScope = scope;
      syncConnectionIndicators();
    }
  });
}

function attachRecorderAndStart(segmentIndex) {
  return new Promise((resolveStart) => {
    const recorder = createMediaRecorderForStream(state.mediaStream, state.activeMimeType);
    state.mediaRecorder = recorder;
    const detectedMime = recorder.mimeType || state.activeMimeType || "audio/webm";
    state.activeMimeType = detectedMime;

    state.currentRamChunks = [];
    state.currentRamBytes = 0;
    state.currentChunkSeq = 0;
    syncStorageIndicators();

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        const seq = state.currentChunkSeq++;
        state.currentRamChunks.push(event.data);
        state.currentRamBytes += event.data.size;
        syncStorageIndicators();
        saveActiveChunkToIdb(state.db, {
          sessionId: state.sessionId,
          segmentIndex,
          chunkSeq: seq,
          mime: detectedMime,
          blob: event.data
        })
          .then(() => recalcIdbBytes())
          .catch((e) => {
            addAuditLog(el, `IndexedDB 임시 저장 경고: ${e.message}`, "warn");
          });
      }
    };

    recorder.start(CHUNK_TIMESLICE_MS);
    resolveStart(recorder);
  });
}

function stopCurrentRecorderAndCollectBlob() {
  return new Promise((resolve) => {
    const recorder = state.mediaRecorder;
    if (!recorder || recorder.state === "inactive") {
      const blob = state.currentRamChunks.length > 0
        ? new Blob(state.currentRamChunks, { type: state.activeMimeType || "audio/webm" })
        : null;
      const mime = state.activeMimeType || "audio/webm";
      state.currentRamChunks = [];
      state.currentRamBytes = 0;
      syncStorageIndicators();
      resolve({ blob, mime });
      return;
    }

    const capturedMime = recorder.mimeType || state.activeMimeType || "audio/webm";
    recorder.onstop = () => {
      const blob = state.currentRamChunks.length > 0
        ? new Blob(state.currentRamChunks, { type: capturedMime })
        : null;
      state.currentRamChunks.length = 0;
      state.currentRamChunks = [];
      state.currentRamBytes = 0;
      syncStorageIndicators();
      resolve({ blob, mime: capturedMime });
    };
    recorder.stop();
  });
}

function clearLiveTranscriptUi() {
  speech.reset();
  el.speechInterimLine.textContent = "";
  el.liveTranscriptTextarea.value = "";
}

function stopMicStreamAndTimers() {
  speech.setActive(false);
  speech.stop(true, "대기");
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.stopWaveformFn) {
    state.stopWaveformFn();
    state.stopWaveformFn = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
}

async function processSegmentInBackground(segmentIndex, blob, mime, segmentTranscript = "") {
  const mode = el.uploadModeSelect.value;
  const cleanTranscript = (segmentTranscript || "").trim();

  if ((!blob || blob.size < 1024) && !cleanTranscript) {
    await deleteSegmentChunksFromIdb(state.db, segmentIndex);
    await recalcIdbBytes();
    return;
  }

  if (blob && blob.size >= 1024 && mode !== "speech_text_only") {
    await replaceSegmentChunksWithFullBlobInIdb(state.db, state.sessionId, segmentIndex, mime, blob);
  } else {
    await deleteSegmentChunksFromIdb(state.db, segmentIndex);
  }
  await recalcIdbBytes();

  const statusEntry = { index: segmentIndex, status: "processing", summaryCount: 0 };
  state.segmentStatuses.push(statusEntry);
  renderChunkPills(el, state.segmentStatuses);

  try {
    const prevNote = state.extractedSegmentNotes[state.extractedSegmentNotes.length - 1];
    const prevRoleHint = prevNote && prevNote.inferredRoles
      ? `화자 A: ${prevNote.inferredRoles.speakerA} / 화자 B: ${prevNote.inferredRoles.speakerB}`
      : "";

    const memo = el.missionMemoInput.value;
    const promptAudio = buildSegmentExtractPrompt({
      memo,
      segmentIndex,
      previousRoleHint: prevRoleHint,
      supplementalTranscript: cleanTranscript
    });
    const promptTranscript = buildSegmentTranscriptPrompt({
      memo,
      segmentIndex,
      previousRoleHint: prevRoleHint,
      transcriptText: cleanTranscript
    });

    const { text } = await dispatchAudioOrTranscript({
      blob,
      rawMime: mime,
      promptTextAudio: promptAudio,
      promptTextTranscript: promptTranscript,
      label: `segment_${segmentIndex}`,
      transcriptText: cleanTranscript
    });
    const parsed = parseModelJson(text);

    const noteRecord = {
      segmentIndex,
      inferredRoles: parsed.inferredRoles || { speakerA: "평가자", speakerB: "피평가자" },
      points: Array.isArray(parsed.points) ? parsed.points : [],
      segmentSummary: parsed.segmentSummary || ""
    };

    state.extractedSegmentNotes.push(noteRecord);
    await saveExtractedNoteToIdb(state.db, noteRecord);
    await deleteSegmentChunksFromIdb(state.db, segmentIndex);
    await recalcIdbBytes();

    statusEntry.status = "done";
    statusEntry.summaryCount = noteRecord.points.length;
    el.completedSegmentCount.textContent = `${state.extractedSegmentNotes.length}개`;
    renderChunkPills(el, state.segmentStatuses);
    addAuditLog(el, `구간 #${segmentIndex} 요약 추출 완료 (${noteRecord.points.length}개 포인트) 및 로컬 음성 폐기 완료`, "ok");
  } catch (err) {
    statusEntry.status = "error";
    renderChunkPills(el, state.segmentStatuses);
    addAuditLog(el, `구간 #${segmentIndex} 백그라운드 추출 실패 (복구 버퍼 유지됨): ${err.message}`, "err");
    throw err;
  } finally {
    blob = null;
  }
}

async function rotateSegmentNow(isManual = false) {
  if (state.isRotating || state.recordingState === "idle") return;
  state.isRotating = true;
  try {
    const isTextOnly = el.uploadModeSelect.value === "speech_text_only";
    const finishingIndex = state.currentSegmentIndex;
    const wasPaused = state.recordingState === "paused";
    const segTranscript = speech.consumeSegmentTranscript(finishingIndex);
    const { blob, mime } = isTextOnly
      ? { blob: null, mime: "" }
      : await stopCurrentRecorderAndCollectBlob();

    state.currentSegmentIndex += 1;
    state.segmentActiveSeconds = 0;
    el.nextRotateCountdown.textContent = formatMMSS(SEGMENT_ROTATE_SECONDS);

    if (!isTextOnly) {
      await attachRecorderAndStart(state.currentSegmentIndex);
      if (wasPaused && state.mediaRecorder && state.mediaRecorder.state === "recording") {
        state.mediaRecorder.pause();
      }
    }

    addAuditLog(
      el,
      isTextOnly
        ? `${isManual ? "수동 구간 분할" : "6분 자동 구간 분할"}: 구간 #${finishingIndex} 대본 확정(${segTranscript.length}자) → 구간 #${state.currentSegmentIndex} 실시간 받아적기 중`
        : `${isManual ? "수동 구간 분할" : "6분 자동 구간 분할"}: 구간 #${finishingIndex} 확정(${formatBytes(blob ? blob.size : 0)}) → 구간 #${state.currentSegmentIndex} 연속 녹음 중`,
      "info"
    );

    const task = processSegmentInBackground(finishingIndex, blob, mime, segTranscript);
    state.pendingSegmentTasks.push(task);
  } finally {
    state.isRotating = false;
  }
}

function applyFinalResult(raw) {
  const points = Array.isArray(raw.conversationPoints)
    ? raw.conversationPoints.map((p, idx) => ({
        id: p.id || `pt_${idx + 1}`,
        speaker: p.speaker || "공통",
        category: p.category || "구현설명",
        summary: p.summary || "",
        checked: true
      }))
    : [];

  state.finalResult = {
    inferredRoles: raw.inferredRoles || { speakerA: "평가자", speakerB: "피평가자" },
    conversationPoints: points,
    reviewerToRevieweeDraft: raw.reviewerToRevieweeDraft || "",
    revieweeToReviewerDraft: raw.revieweeToReviewerDraft || ""
  };

  renderResults(el, state.finalResult);
}

async function generateFromSingleAudioBlob(blob, mime, segmentIndex, transcriptText = "") {
  try {
    const memo = el.missionMemoInput.value;
    const tone = el.toneSelect.value;
    const length = el.lengthSelect.value;

    const promptAudio = buildSingleShotAudioPrompt({
      memo,
      tone,
      length,
      supplementalTranscript: transcriptText
    });
    const promptTranscript = buildSingleShotTranscriptPrompt({
      memo,
      tone,
      length,
      transcriptText
    });

    const { text } = await dispatchAudioOrTranscript({
      blob,
      rawMime: mime,
      promptTextAudio: promptAudio,
      promptTextTranscript: promptTranscript,
      label: `single_${segmentIndex}`,
      transcriptText
    });
    const parsed = parseModelJson(text);

    applyFinalResult(parsed);
    await deleteSegmentChunksFromIdb(state.db, segmentIndex);
    await clearIdbStore(state.db, STORE_NOTES);
    await recalcIdbBytes();
    addAuditLog(el, "단일 구간 초안 생성 및 로컬·IndexedDB 음성 즉시 영구 폐기 완료", "ok");
  } finally {
    blob = null;
  }
}

async function synthesizeFinalResultFromNotes() {
  state.extractedSegmentNotes.sort((a, b) => a.segmentIndex - b.segmentIndex);
  if (state.extractedSegmentNotes.length === 0) {
    throw new Error("추출된 구간 대화 노트가 없어 초안을 만들 수 없습니다.");
  }

  const prompt = buildSynthesizeFromNotesPrompt({
    memo: el.missionMemoInput.value,
    tone: el.toneSelect.value,
    length: el.lengthSelect.value,
    notesArray: state.extractedSegmentNotes
  });
  addAuditLog(el, `추출된 ${state.extractedSegmentNotes.length}개 구간 노트를 종합해 3단 상호 피드백 생성 중...`, "info");

  const { text } = await runLLM(prompt, null);
  const parsed = parseModelJson(text);
  applyFinalResult(parsed);
  addAuditLog(el, "전체 구간 종합 피드백 초안 생성 완료 (모든 음성 파일 이미 폐기됨)", "ok");
}

function validateCredentialsOrAlert(actionName) {
  if (!getGatewayBaseUrl()) {
    showError(el, `${actionName} 전에 상단 연결 설정에서 게이트웨이 API Base URL을 입력해 주세요.`);
    if (el.setupDetails) el.setupDetails.open = true;
    el.gatewayBaseUrlInput.focus();
    return false;
  }
  if (!getApiKey()) {
    showError(el, `${actionName} 전에 상단 연결 설정에서 OpenAI 호환 Virtual Key를 입력해 주세요.`);
    if (el.setupDetails) el.setupDetails.open = true;
    el.apiKeyInput.focus();
    return false;
  }
  return true;
}

async function startRecording() {
  showError(el, "");
  if (!validateCredentialsOrAlert("녹음 시작")) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const isTextOnly = el.uploadModeSelect.value === "speech_text_only";
    state.mediaStream = stream;
    state.activeMimeType = isTextOnly ? "" : getSupportedMimeType();
    state.sessionId = generateId("sess");
    state.currentSegmentIndex = 1;
    state.totalActiveSeconds = 0;
    state.segmentActiveSeconds = 0;
    state.segmentStatuses = [];
    state.extractedSegmentNotes = [];
    state.pendingSegmentTasks = [];
    clearLiveTranscriptUi();
    el.recoveryBanner.classList.remove("visible");
    await clearIdbStore(state.db, STORE_CHUNKS);
    await clearIdbStore(state.db, STORE_NOTES);
    await recalcIdbBytes();
    renderChunkPills(el, state.segmentStatuses);

    if (!isTextOnly) {
      await attachRecorderAndStart(state.currentSegmentIndex);
    } else {
      state.mediaRecorder = null;
      state.currentRamChunks = [];
      state.currentRamBytes = 0;
      syncStorageIndicators();
    }
    state.stopWaveformFn = startWaveform(el.waveformCanvas, stream, () => state.recordingState);

    state.recordingState = "recording";
    speech.setActive(true);
    speech.start();
    syncRecordingButtons();
    updateStatusBadge(el, "recording", "녹음 중");
    el.timerDisplay.textContent = "00:00:00";
    el.nextRotateCountdown.textContent = formatMMSS(SEGMENT_ROTATE_SECONDS);
    el.completedSegmentCount.textContent = "0개";

    addAuditLog(
      el,
      isTextOnly
        ? "마이크 녹음 시작 (실시간 받아적기 전용 · 음성 로컬 무저장/외부 무전송)"
        : `마이크 녹음 시작 (모드: ${el.uploadModeSelect.value} · 코덱: ${state.activeMimeType || "브라우저 기본"})`,
      "info"
    );

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      if (state.recordingState === "recording") {
        state.totalActiveSeconds += 1;
        state.segmentActiveSeconds += 1;
        el.timerDisplay.textContent = formatDuration(state.totalActiveSeconds);
        const remain = Math.max(0, SEGMENT_ROTATE_SECONDS - state.segmentActiveSeconds);
        el.nextRotateCountdown.textContent = formatMMSS(remain);

        if (state.segmentActiveSeconds >= SEGMENT_ROTATE_SECONDS && !state.isRotating) {
          rotateSegmentNow(false).catch((e) => showError(el, `구간 분할 중 오류: ${e.message}`));
        }
      }
    }, 1000);
  } catch (err) {
    showError(el, `마이크 접근 또는 녹음 시작 실패: ${err.message}\n브라우저 및 OS 개인정보 설정에서 마이크 권한을 확인하세요.`);
    addAuditLog(el, `마이크 시작 실패: ${err.message}`, "err");
  }
}

function togglePauseRecording() {
  if (state.recordingState !== "recording" && state.recordingState !== "paused") return;
  if (state.recordingState === "recording") {
    state.mediaRecorder?.pause();
    state.recordingState = "paused";
    speech.setActive(true);
    speech.stop(true, "음성인식 일시정지");
    el.btnPauseRec.textContent = "▶ 녹음 재개";
    updateStatusBadge(el, "paused", "일시정지");
    addAuditLog(el, "녹음 일시정지", "info");
  } else if (state.recordingState === "paused") {
    state.mediaRecorder?.resume();
    state.recordingState = "recording";
    speech.setActive(true);
    speech.start();
    el.btnPauseRec.textContent = "❚❚ 일시정지";
    updateStatusBadge(el, "recording", "녹음 중");
    addAuditLog(el, "녹음 재개", "info");
  }
}

async function stopAndGenerateAll() {
  showError(el, "");
  if (!validateCredentialsOrAlert("초안 생성")) return;

  state.recordingState = "stopping";
  state.isBusy = true;
  syncRecordingButtons();
  updateStatusBadge(el, "processing", "분석 및 음성 폐기 중...");

  try {
    const finalSegIdx = state.currentSegmentIndex;
    const { blob, mime } = await stopCurrentRecorderAndCollectBlob();
    stopMicStreamAndTimers();

    const finalSegTranscript = speech.consumeSegmentTranscript(finalSegIdx);
    const fullTextareaTranscript = el.liveTranscriptTextarea.value.trim();

    if (state.extractedSegmentNotes.length === 0 && state.pendingSegmentTasks.length === 0) {
      const effectiveTranscript = fullTextareaTranscript || finalSegTranscript;
      if ((!blob || blob.size < 1024) && !effectiveTranscript) {
        throw new Error("녹음된 음성과 인식된 대본이 모두 비어 있습니다.");
      }
      await generateFromSingleAudioBlob(blob, mime, finalSegIdx, effectiveTranscript);
    } else {
      if ((blob && blob.size >= 1024) || finalSegTranscript) {
        const lastTask = processSegmentInBackground(finalSegIdx, blob, mime, finalSegTranscript);
        state.pendingSegmentTasks.push(lastTask);
      } else {
        await deleteSegmentChunksFromIdb(state.db, finalSegIdx);
      }

      addAuditLog(el, "모든 구간의 백그라운드 요약 및 로컬 음성 폐기 완료를 대기 중...", "info");
      const settled = await Promise.allSettled(state.pendingSegmentTasks);
      const rejected = settled.filter((r) => r.status === "rejected");
      if (rejected.length > 0 && state.extractedSegmentNotes.length === 0) {
        throw new Error(rejected[0].reason?.message || "구간 분석에 실패했습니다.");
      }

      await synthesizeFinalResultFromNotes();
      await clearIdbStore(state.db, STORE_NOTES);
    }

    clearLiveTranscriptUi();
    state.recordingState = "idle";
    updateStatusBadge(el, "done", "초안 생성 · 음성 폐기 완료");
  } catch (err) {
    state.recordingState = "idle";
    updateStatusBadge(el, "idle", "오류 발생 (복구 버퍼 확인)");
    showError(el, `초안 생성 중 오류가 발생했습니다:\n${err.message}`);
    addAuditLog(el, `초안 생성 실패: ${err.message}`, "err");
  } finally {
    state.isBusy = false;
    syncRecordingButtons();
    await recalcIdbBytes();
  }
}

async function generateFromTranscriptOnly() {
  showError(el, "");
  if (!validateCredentialsOrAlert("대본 초안 생성")) return;

  const transcriptText = el.liveTranscriptTextarea.value.trim();
  if (!transcriptText) {
    showError(el, "보조 대본 칸이 비어 있습니다. 녹음을 진행하거나 대화 내용을 붙여넣은 뒤 누르세요.");
    el.liveTranscriptTextarea.focus();
    return;
  }

  state.isBusy = true;
  syncRecordingButtons();
  updateStatusBadge(el, "processing", "대본으로 초안 생성 중...");

  try {
    const prompt = buildSingleShotTranscriptPrompt({
      memo: el.missionMemoInput.value,
      tone: el.toneSelect.value,
      length: el.lengthSelect.value,
      transcriptText
    });
    const { text } = await runLLM(prompt, null);
    const parsed = parseModelJson(text);
    applyFinalResult(parsed);
    updateStatusBadge(el, "done", "대본 기반 초안 생성 완료");
    addAuditLog(el, `보조 대본(${transcriptText.length}자)으로 화자분리 및 3단 초안 생성 완료`, "ok");
  } catch (err) {
    updateStatusBadge(el, "idle", "오류");
    showError(el, `대본 기반 초안 생성 실패:\n${err.message}`);
    addAuditLog(el, `대본 기반 초안 생성 실패: ${err.message}`, "err");
  } finally {
    state.isBusy = false;
    syncRecordingButtons();
  }
}

async function handleAudioFileImport(file) {
  if (!file) return;
  showError(el, "");
  if (!validateCredentialsOrAlert("음성 파일 분석")) {
    el.audioFileInput.value = "";
    return;
  }

  state.isBusy = true;
  syncRecordingButtons();
  updateStatusBadge(el, "processing", `파일 분석 중 (${formatBytes(file.size)})...`);
  addAuditLog(el, `외부 음성 파일 불러오기 (${file.name}, ${formatBytes(file.size)}) — 분석 후 참조 즉시 폐기 예정`, "info");

  try {
    state.extractedSegmentNotes = [];
    state.segmentStatuses = [];
    state.pendingSegmentTasks = [];
    renderChunkPills(el, state.segmentStatuses);

    const mime = file.type || (file.name.endsWith(".m4a") ? "audio/mp4" : "audio/mpeg");
    const backupText = el.liveTranscriptTextarea.value.trim();
    const memo = el.missionMemoInput.value;
    const tone = el.toneSelect.value;
    const length = el.lengthSelect.value;

    const promptAudio = buildSingleShotAudioPrompt({
      memo,
      tone,
      length,
      supplementalTranscript: backupText
    });
    const promptTranscript = buildSingleShotTranscriptPrompt({
      memo,
      tone,
      length,
      transcriptText: backupText
    });

    const { text } = await dispatchAudioOrTranscript({
      blob: file,
      rawMime: mime,
      promptTextAudio: promptAudio,
      promptTextTranscript: promptTranscript,
      label: "imported_file",
      transcriptText: backupText
    });
    const parsed = parseModelJson(text);
    applyFinalResult(parsed);

    updateStatusBadge(el, "done", "파일 초안 생성 · 참조 폐기 완료");
    addAuditLog(el, "불러온 음성 파일 분석 완료 및 메모리 참조 즉시 폐기 완료", "ok");
  } catch (err) {
    updateStatusBadge(el, "idle", "오류");
    showError(el, `파일 분석 실패:\n${err.message}`);
    addAuditLog(el, `파일 분석 실패: ${err.message}`, "err");
  } finally {
    el.audioFileInput.value = "";
    state.isBusy = false;
    syncRecordingButtons();
  }
}

async function checkCrashRecoveryOnLoad() {
  const chunks = await getAllIdbRecords(state.db, STORE_CHUNKS);
  const notes = await getAllIdbRecords(state.db, STORE_NOTES);
  await recalcIdbBytes();

  if (chunks.length === 0 && notes.length === 0) return;

  const totalChunkBytes = chunks.reduce((acc, c) => acc + (c.size || (c.blob ? c.blob.size : 0)), 0);
  const segCount = new Set(chunks.map((c) => c.segmentIndex)).size;
  el.recoveryDesc.textContent =
    `미처리 음성 버퍼 ${segCount}개 구간 (${formatBytes(totalChunkBytes)}) 및 추출된 구간 노트 ${notes.length}개가 남아 있습니다. 복구해 초안을 만든 뒤 음성을 즉시 폐기할 수 있습니다.`;
  el.recoveryBanner.classList.add("visible");
  addAuditLog(el, `이전 비정상 종료 버퍼 감지: 음성 ${formatBytes(totalChunkBytes)}, 노트 ${notes.length}개`, "warn");
}

async function recoverInterruptedSession() {
  showError(el, "");
  if (!validateCredentialsOrAlert("세션 복구")) return;

  state.isBusy = true;
  syncRecordingButtons();
  updateStatusBadge(el, "processing", "중단된 세션 복구 및 음성 폐기 중...");

  try {
    const allNotes = await getAllIdbRecords(state.db, STORE_NOTES);
    const allChunks = await getAllIdbRecords(state.db, STORE_CHUNKS);

    state.extractedSegmentNotes = allNotes.sort((a, b) => a.segmentIndex - b.segmentIndex);
    state.segmentStatuses = state.extractedSegmentNotes.map((n) => ({
      index: n.segmentIndex,
      status: "done",
      summaryCount: (n.points || []).length
    }));
    renderChunkPills(el, state.segmentStatuses);

    const bySeg = new Map();
    for (const c of allChunks) {
      if (!bySeg.has(c.segmentIndex)) bySeg.set(c.segmentIndex, []);
      bySeg.get(c.segmentIndex).push(c);
    }

    const sortedSegs = Array.from(bySeg.keys()).sort((a, b) => a - b);

    if (state.extractedSegmentNotes.length === 0 && sortedSegs.length === 1) {
      const segIdx = sortedSegs[0];
      const list = bySeg.get(segIdx).sort((a, b) => a.chunkSeq - b.chunkSeq);
      const mime = list[0]?.mime || "audio/webm";
      const fullBlob = list.length === 1 && list[0].isCompleteSegment
        ? list[0].blob
        : new Blob(list.map((x) => x.blob), { type: mime });
      await generateFromSingleAudioBlob(fullBlob, mime, segIdx, el.liveTranscriptTextarea.value.trim());
    } else {
      for (const segIdx of sortedSegs) {
        const list = bySeg.get(segIdx).sort((a, b) => a.chunkSeq - b.chunkSeq);
        const mime = list[0]?.mime || "audio/webm";
        const fullBlob = list.length === 1 && list[0].isCompleteSegment
          ? list[0].blob
          : new Blob(list.map((x) => x.blob), { type: mime });
        await processSegmentInBackground(segIdx, fullBlob, mime, "");
      }
      await synthesizeFinalResultFromNotes();
      await clearIdbStore(state.db, STORE_NOTES);
    }

    el.recoveryBanner.classList.remove("visible");
    updateStatusBadge(el, "done", "복구 초안 생성 · 음성 폐기 완료");
    addAuditLog(el, "중단 세션 복구 완료 및 모든 임시 음성 파기 완료", "ok");
  } catch (err) {
    updateStatusBadge(el, "idle", "복구 오류");
    showError(el, `세션 복구 중 오류:\n${err.message}`);
    addAuditLog(el, `세션 복구 실패: ${err.message}`, "err");
  } finally {
    state.isBusy = false;
    syncRecordingButtons();
    await recalcIdbBytes();
  }
}

async function regenerateDraftsFromPoints() {
  if (!state.finalResult) return;
  showError(el, "");
  const checkedPoints = state.finalResult.conversationPoints.filter((p) => p.checked !== false);
  if (checkedPoints.length === 0) {
    showError(el, "초안에 반영할 핵심 포인트를 1개 이상 체크해 주세요.");
    return;
  }

  state.isBusy = true;
  syncRecordingButtons();
  el.btnSwapRoles.disabled = true;
  el.btnRegenerateDrafts.disabled = true;
  updateStatusBadge(el, "processing", "포인트 기반 초안 재작성 중...");

  try {
    const prompt = buildRefineFromPointsPrompt({
      memo: el.missionMemoInput.value,
      tone: el.toneSelect.value,
      length: el.lengthSelect.value,
      activePoints: checkedPoints,
      inferredRoles: state.finalResult.inferredRoles
    });
    const { text } = await runLLM(prompt, null);
    const parsed = parseModelJson(text);

    state.finalResult.reviewerToRevieweeDraft = parsed.reviewerToRevieweeDraft || "";
    state.finalResult.revieweeToReviewerDraft = parsed.revieweeToReviewerDraft || "";

    el.reviewerDraftTextarea.value = state.finalResult.reviewerToRevieweeDraft;
    el.revieweeDraftTextarea.value = state.finalResult.revieweeToReviewerDraft;
    updateCharCount(el.reviewerDraftTextarea, el.reviewerCharCount);
    updateCharCount(el.revieweeDraftTextarea, el.revieweeCharCount);

    updateStatusBadge(el, "done", "초안 재작성 완료 (음성 데이터 없음)");
    addAuditLog(el, "음성 재전송 없이 텍스트 포인트만으로 양쪽 피드백 초안 재작성 완료", "ok");
  } catch (err) {
    updateStatusBadge(el, "done", "재작성 오류");
    showError(el, `초안 재작성 실패:\n${err.message}`);
    addAuditLog(el, `초안 재작성 실패: ${err.message}`, "err");
  } finally {
    state.isBusy = false;
    syncRecordingButtons();
    el.btnSwapRoles.disabled = false;
    el.btnRegenerateDrafts.disabled = false;
  }
}

async function swapSpeakerRolesAndRegenerate() {
  if (!state.finalResult) return;
  const roles = state.finalResult.inferredRoles;
  const prevA = roles.speakerA || "";
  const prevB = roles.speakerB || "";
  roles.speakerA = prevB;
  roles.speakerB = prevA;

  for (const pt of state.finalResult.conversationPoints) {
    if (pt.speaker === "평가자") pt.speaker = "피평가자";
    else if (pt.speaker === "피평가자") pt.speaker = "평가자";
  }

  el.roleSpeakerA.textContent = roles.speakerA;
  el.roleSpeakerB.textContent = roles.speakerB;
  renderPointsList(el, state.finalResult);
  addAuditLog(el, "평가자 ↔ 피평가자 역할 반전 적용 → 초안 즉시 재작성 시작", "info");

  await regenerateDraftsFromPoints();
}

function addCustomPoint() {
  if (!state.finalResult) return;
  const text = el.customPointInput.value.trim();
  if (!text) return;
  state.finalResult.conversationPoints.push({
    id: generateId("pt"),
    speaker: el.customPointSpeaker.value,
    category: el.customPointCategory.value,
    summary: text,
    checked: true
  });
  el.customPointInput.value = "";
  renderPointsList(el, state.finalResult);
}

async function purgeAllDataNow() {
  showError(el, "");
  if (state.recordingState === "recording" || state.recordingState === "paused") {
    await stopCurrentRecorderAndCollectBlob();
    stopMicStreamAndTimers();
    state.recordingState = "idle";
  } else {
    speech.setActive(false);
    speech.stop(false, "대기");
  }

  state.currentRamChunks.length = 0;
  state.currentRamChunks = [];
  state.currentRamBytes = 0;
  state.extractedSegmentNotes = [];
  state.segmentStatuses = [];
  state.pendingSegmentTasks = [];
  state.finalResult = null;
  state.totalActiveSeconds = 0;
  state.segmentActiveSeconds = 0;
  clearLiveTranscriptUi();

  await clearIdbStore(state.db, STORE_CHUNKS);
  await clearIdbStore(state.db, STORE_NOTES);
  await recalcIdbBytes();

  el.timerDisplay.textContent = "00:00:00";
  el.nextRotateCountdown.textContent = formatMMSS(SEGMENT_ROTATE_SECONDS);
  el.completedSegmentCount.textContent = "0개";
  el.audioFileInput.value = "";
  el.recoveryBanner.classList.remove("visible");
  el.reviewerDraftTextarea.value = "";
  el.revieweeDraftTextarea.value = "";
  el.resultsSection.classList.remove("visible");
  renderChunkPills(el, state.segmentStatuses);
  syncRecordingButtons();
  syncStorageIndicators();
  syncConnectionIndicators();
  updateStatusBadge(el, "idle", "모든 데이터 완전 파기됨");

  addAuditLog(el, "사용자 요청으로 모든 로컬 RAM, IndexedDB, 대본, 결과 초안을 즉시 영구 파기했습니다.", "ok");
}

function bindEvents() {
  if (el.connectionChip) {
    el.connectionChip.addEventListener("click", () => {
      if (el.setupDetails) {
        el.setupDetails.open = true;
        el.setupDetails.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  el.btnCopyNodeCmd.addEventListener("click", () =>
    copyTextToClipboard("node server.mjs", el.btnCopyNodeCmd, "복사")
  );
  el.btnCopyPythonCmd.addEventListener("click", () =>
    copyTextToClipboard("python3 server.py", el.btnCopyPythonCmd, "복사")
  );
  el.btnRecheckProxy.addEventListener("click", () => detectLocalProxy(true));

  const persistInputs = () => {
    saveStoredGatewayConfig({
      baseUrl: el.gatewayBaseUrlInput.value,
      apiKey: el.apiKeyInput.value,
      remember: el.rememberKeyCheckbox.checked
    });
  };

  el.apiKeyInput.addEventListener("input", () => {
    state.keyProtocolScope = "unknown";
    state.gatewayAudioSupport = "unknown";
    resetGatewayFeatureCache();
    renderDiagnosticsBox(el, null);
    syncConnectionIndicators();
    persistInputs();
  });

  el.gatewayBaseUrlInput.addEventListener("input", () => {
    state.keyProtocolScope = "unknown";
    state.gatewayAudioSupport = "unknown";
    resetGatewayFeatureCache();
    renderDiagnosticsBox(el, null);
    syncConnectionIndicators();
    saveStoredGatewayBaseUrl({
      baseUrl: el.gatewayBaseUrlInput.value,
      remember: el.rememberKeyCheckbox.checked
    });
  });

  el.gatewayBaseUrlInput.addEventListener("blur", () => {
    const raw = el.gatewayBaseUrlInput.value.trim();
    el.gatewayBaseUrlInput.value = raw ? normalizeGatewayBaseUrl(raw) : "";
    saveStoredGatewayBaseUrl({
      baseUrl: el.gatewayBaseUrlInput.value,
      remember: el.rememberKeyCheckbox.checked
    });
  });

  el.rememberKeyCheckbox.addEventListener("change", persistInputs);

  el.btnToggleKey.addEventListener("click", () => {
    const isPw = el.apiKeyInput.type === "password";
    el.apiKeyInput.type = isPw ? "text" : "password";
    el.btnToggleKey.textContent = isPw ? "숨기기" : "보기";
  });

  el.btnClearKey.addEventListener("click", () => {
    el.apiKeyInput.value = "";
    el.gatewayBaseUrlInput.value = "";
    el.rememberKeyCheckbox.checked = false;
    clearStoredGatewayConfig();
    resetGatewayFeatureCache();
    state.syncedModels = [];
    state.gatewayAudioSupport = "unknown";
    state.keyProtocolScope = "unknown";
    renderModelSelectOptions(el, []);
    renderDiagnosticsBox(el, null);
    syncConnectionIndicators();
    el.modelSyncStatus.textContent = "저장된 모든 API 키와 게이트웨이 주소가 삭제되었습니다.";
    addAuditLog(el, "저장된 API 키와 게이트웨이 주소를 즉시 삭제했습니다.", "ok");
  });

  el.btnDiagnoseGateway.addEventListener("click", handleDiagnoseGateway);
  el.btnSyncModels.addEventListener("click", () => handleSyncModels(false));

  el.modelSelect.addEventListener("change", () => {
    if (el.modelSelect.value === "__custom__") {
      el.customModelInput.classList.remove("hidden");
      el.customModelInput.focus();
    } else {
      el.customModelInput.classList.add("hidden");
    }
  });
  el.uploadModeSelect.addEventListener("change", syncUploadModeUi);

  el.btnStartRec.addEventListener("click", startRecording);
  el.btnPauseRec.addEventListener("click", togglePauseRecording);
  el.btnRotateChunk.addEventListener("click", () => rotateSegmentNow(true));
  el.btnStopAndGenerate.addEventListener("click", stopAndGenerateAll);
  el.btnGenerateFromTranscript.addEventListener("click", generateFromTranscriptOnly);

  el.btnImportFile.addEventListener("click", () => el.audioFileInput.click());
  el.audioFileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleAudioFileImport(file);
  });

  el.btnRecoverProcess.addEventListener("click", recoverInterruptedSession);
  el.btnRecoverDiscard.addEventListener("click", async () => {
    await purgeAllDataNow();
    el.recoveryBanner.classList.remove("visible");
  });

  el.btnPurgeAll.addEventListener("click", purgeAllDataNow);

  el.btnSwapRoles.addEventListener("click", swapSpeakerRolesAndRegenerate);
  el.btnRegenerateDrafts.addEventListener("click", regenerateDraftsFromPoints);

  el.btnAddCustomPoint.addEventListener("click", addCustomPoint);
  el.customPointInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomPoint();
    }
  });

  el.reviewerDraftTextarea.addEventListener("input", () =>
    updateCharCount(el.reviewerDraftTextarea, el.reviewerCharCount)
  );
  el.revieweeDraftTextarea.addEventListener("input", () =>
    updateCharCount(el.revieweeDraftTextarea, el.revieweeCharCount)
  );

  el.btnCopyReviewer.addEventListener("click", () =>
    copyTextToClipboard(el.reviewerDraftTextarea.value, el.btnCopyReviewer, "복사")
  );
  el.btnCopyReviewee.addEventListener("click", () =>
    copyTextToClipboard(el.revieweeDraftTextarea.value, el.btnCopyReviewee, "복사")
  );

  window.addEventListener("beforeunload", (e) => {
    const hasUnfinished =
      state.recordingState === "recording" ||
      state.recordingState === "paused" ||
      state.isBusy ||
      state.currentRamBytes > 0 ||
      state.idbCachedBytes > 0 ||
      el.liveTranscriptTextarea.value.trim().length > 0 ||
      state.finalResult !== null;

    if (hasUnfinished) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

async function init() {
  const stored = loadStoredGatewayConfig({
    hash: window.location.hash,
    search: window.location.search
  });
  el.gatewayBaseUrlInput.value = stored.baseUrl;
  el.apiKeyInput.value = stored.apiKey;
  el.rememberKeyCheckbox.checked = stored.remember;

  if (stored.fromLocation) {
    addAuditLog(el, `URL 파라미터에서 게이트웨이 Base URL을 자동 설정했습니다 (${stored.baseUrl}).`, "info");
  }
  if (stored.fromLocalKey) {
    addAuditLog(el, "로컬 저장소에 기억된 게이트웨이 API 키를 불러왔습니다.", "info");
  }

  renderModelSelectOptions(el, []);
  drawIdleWaveform(el.waveformCanvas);
  bindEvents();
  syncUploadModeUi();
  syncRecordingButtons();
  syncStorageIndicators();
  addAuditLog(el, "초기화 완료 (OpenAI 호환 게이트웨이 · 구형 2.5 이하 모델 제외 · 버퍼 비어 있음)", "info");

  await detectLocalProxy(true);

  try {
    state.db = await openDb();
    await checkCrashRecoveryOnLoad();
  } catch (err) {
    addAuditLog(el, `IndexedDB 초기화 실패 (메모리 단독 모드로 동작): ${err.message}`, "warn");
  }

  if (getApiKey() && getGatewayBaseUrl() && state.localProxyAvailable) {
    handleSyncModels(true);
  }
}

init();
