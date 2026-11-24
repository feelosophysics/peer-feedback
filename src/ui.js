import { DRAFT_CHAR_LIMIT, GATEWAY_MODEL_CATALOG } from "./constants.js";
import { formatSeconds } from "./metrics.js";
import { escapeHtml, formatBytes, nowTimeStr } from "./utils.js";

export function collectElements() {
  return {
    connectionChip: document.getElementById("connectionChip"),

    proxyNoticeBanner: document.getElementById("proxyNoticeBanner"),
    btnCopyNodeCmd: document.getElementById("btnCopyNodeCmd"),
    btnCopyPythonCmd: document.getElementById("btnCopyPythonCmd"),
    btnRecheckProxy: document.getElementById("btnRecheckProxy"),

    recoveryBanner: document.getElementById("recoveryBanner"),
    recoveryDesc: document.getElementById("recoveryDesc"),
    btnRecoverProcess: document.getElementById("btnRecoverProcess"),
    btnRecoverRestoreOnly: document.getElementById("btnRecoverRestoreOnly"),
    btnRecoverDiscard: document.getElementById("btnRecoverDiscard"),
    globalError: document.getElementById("globalError"),

    setupDetails: document.getElementById("setupDetails"),
    setupSummaryBadge: document.getElementById("setupSummaryBadge"),
    gatewayBaseUrlInput: document.getElementById("gatewayBaseUrlInput"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    btnToggleKey: document.getElementById("btnToggleKey"),
    rememberKeyCheckbox: document.getElementById("rememberKeyCheckbox"),
    btnClearKey: document.getElementById("btnClearKey"),
    btnDiagnoseGateway: document.getElementById("btnDiagnoseGateway"),
    diagnosticsResultBox: document.getElementById("diagnosticsResultBox"),
    btnSyncModels: document.getElementById("btnSyncModels"),
    modelSelect: document.getElementById("modelSelect"),
    customModelInput: document.getElementById("customModelInput"),
    modelSyncStatus: document.getElementById("modelSyncStatus"),
    uploadModeSelect: document.getElementById("uploadModeSelect"),
    missionMemoInput: document.getElementById("missionMemoInput"),
    checklistInput: document.getElementById("checklistInput"),

    timerDisplay: document.getElementById("timerDisplay"),
    recStatusBadge: document.getElementById("recStatusBadge"),
    textModeBatchMetric: document.getElementById("textModeBatchMetric"),
    bufferMetricItem: document.getElementById("bufferMetricItem"),
    currentBufferSize: document.getElementById("currentBufferSize"),
    rotateCountdownMetricItem: document.getElementById("rotateCountdownMetricItem"),
    nextRotateCountdown: document.getElementById("nextRotateCountdown"),
    completedSegmentMetricItem: document.getElementById("completedSegmentMetricItem"),
    completedSegmentCount: document.getElementById("completedSegmentCount"),
    waveformCanvas: document.getElementById("waveformCanvas"),

    btnStartRec: document.getElementById("btnStartRec"),
    btnPauseRec: document.getElementById("btnPauseRec"),
    btnRotateChunk: document.getElementById("btnRotateChunk"),
    btnStopAndGenerate: document.getElementById("btnStopAndGenerate"),
    btnImportFile: document.getElementById("btnImportFile"),
    audioFileInput: document.getElementById("audioFileInput"),
    chunkStatusBox: document.getElementById("chunkStatusBox"),
    chunkPills: document.getElementById("chunkPills"),

    transcriptDetails: document.getElementById("transcriptDetails"),
    speechStatusBadge: document.getElementById("speechStatusBadge"),
    speechInterimLine: document.getElementById("speechInterimLine"),
    liveTranscriptTextarea: document.getElementById("liveTranscriptTextarea"),
    btnGenerateFromTranscript: document.getElementById("btnGenerateFromTranscript"),

    btnPurgeAll: document.getElementById("btnPurgeAll"),
    statRamBytes: document.getElementById("statRamBytes"),
    statIdbBytes: document.getElementById("statIdbBytes"),
    statGatewayAudio: document.getElementById("statGatewayAudio"),
    statUsedModel: document.getElementById("statUsedModel"),
    auditLogCount: document.getElementById("auditLogCount"),
    auditLog: document.getElementById("auditLog"),

    resultsSection: document.getElementById("resultsSection"),
    btnSwapRoles: document.getElementById("btnSwapRoles"),
    roleSpeakerA: document.getElementById("roleSpeakerA"),
    roleSpeakerB: document.getElementById("roleSpeakerB"),
    toneSelect: document.getElementById("toneSelect"),
    lengthSelect: document.getElementById("lengthSelect"),
    btnRegenerateDrafts: document.getElementById("btnRegenerateDrafts"),
    pointsList: document.getElementById("pointsList"),
    customPointSpeaker: document.getElementById("customPointSpeaker"),
    customPointKind: document.getElementById("customPointKind"),
    customPointInput: document.getElementById("customPointInput"),
    btnAddCustomPoint: document.getElementById("btnAddCustomPoint"),

    reviewerDraftTextarea: document.getElementById("reviewerDraftTextarea"),
    revieweeDraftTextarea: document.getElementById("revieweeDraftTextarea"),
    btnCopyReviewer: document.getElementById("btnCopyReviewer"),
    btnCopyReviewee: document.getElementById("btnCopyReviewee"),
    reviewerCharCount: document.getElementById("reviewerCharCount"),
    revieweeCharCount: document.getElementById("revieweeCharCount"),

    reflectionCard: document.getElementById("reflectionCard"),
    reflectionBody: document.getElementById("reflectionBody")
  };
}

export function addAuditLog(el, message, level = "info") {
  const div = document.createElement("div");
  div.className = `log-entry ${level}`;
  div.textContent = `[${nowTimeStr()}] ${message}`;
  el.auditLog.appendChild(div);
  el.auditLog.scrollTop = el.auditLog.scrollHeight;
  if (el.auditLogCount) {
    el.auditLogCount.textContent = `${el.auditLog.children.length}`;
  }
}

export function showError(el, msg) {
  if (!msg) {
    el.globalError.textContent = "";
    el.globalError.classList.remove("visible");
    return;
  }
  el.globalError.textContent = msg;
  el.globalError.classList.add("visible");
}

export function updateStorageIndicators(el, { currentRamBytes, idbCachedBytes }) {
  el.currentBufferSize.textContent = `${(currentRamBytes / (1024 * 1024)).toFixed(2)} MB`;

  if (currentRamBytes === 0) {
    el.statRamBytes.textContent = "0 B";
    el.statRamBytes.className = "footer-stat-val safe";
  } else {
    el.statRamBytes.textContent = formatBytes(currentRamBytes);
    el.statRamBytes.className = "footer-stat-val warn";
  }

  if (idbCachedBytes === 0) {
    el.statIdbBytes.textContent = "0 B";
    el.statIdbBytes.className = "footer-stat-val safe";
  } else {
    el.statIdbBytes.textContent = formatBytes(idbCachedBytes);
    el.statIdbBytes.className = "footer-stat-val warn";
  }
}

export function updateConnectionIndicators(
  el,
  { localProxyAvailable, localProxyRuntime, gatewayAudioSupport, keyProtocolScope, uploadMode = "speech_text_only" }
) {
  let summaryText = "프록시 연결됨 · 테스트 권장";
  let chipClass = "conn-chip";

  if (!localProxyAvailable) {
    summaryText = "프록시 미연결 (CORS 차단 가능)";
    chipClass = "conn-chip warn";
  } else if (keyProtocolScope === "wrong_protocol") {
    summaryText = "OpenAI 호환 키 필요";
    chipClass = "conn-chip danger";
  } else if (uploadMode === "speech_text_only" && keyProtocolScope === "openai_ok") {
    summaryText = "연결됨 · 실시간 받아적기 준비 완료";
    chipClass = "conn-chip ok";
  } else if (gatewayAudioSupport === "supported") {
    summaryText = "연결됨 · 음성 직접 분석 가능";
    chipClass = "conn-chip ok";
  } else if (gatewayAudioSupport === "unsupported") {
    summaryText = "연결됨 · Chrome 실시간 받아적기";
    chipClass = "conn-chip warn";
  } else {
    summaryText = `프록시 연결됨 (${localProxyRuntime || "local"}) · 테스트 권장`;
  }

  el.statGatewayAudio.textContent = summaryText;
  el.statGatewayAudio.className =
    (uploadMode === "speech_text_only" && keyProtocolScope === "openai_ok") || gatewayAudioSupport === "supported"
      ? "footer-stat-val safe"
      : !localProxyAvailable || keyProtocolScope === "wrong_protocol"
        ? "footer-stat-val danger"
        : "footer-stat-val";

  if (el.connectionChip) {
    el.connectionChip.textContent = summaryText;
    el.connectionChip.className = chipClass;
  }
  if (el.setupSummaryBadge) {
    el.setupSummaryBadge.textContent = summaryText;
    el.setupSummaryBadge.className = chipClass;
  }
}

export function renderDiagnosticsBox(el, payload) {
  const box = el.diagnosticsResultBox;
  if (!box) return;

  if (!payload) {
    box.className = "diag-box hidden";
    box.innerHTML = "";
    return;
  }

  const {
    variant = "loading",
    stepIndex = 0,
    stepLabels = ["1. 로컬 프록시", "2. 키·모델 확인", "3. 텍스트 생성 점검"],
    title = "",
    detail = "",
    hint = "",
    actionLabel = "",
    onAction = null
  } = payload;

  box.className = `diag-box is-${variant}`;
  box.innerHTML = "";

  if (variant === "loading") {
    const stepsRow = document.createElement("div");
    stepsRow.className = "diag-steps";
    stepLabels.forEach((lbl, idx) => {
      const span = document.createElement("span");
      const num = idx + 1;
      span.className = `diag-step ${num < stepIndex ? "done" : num === stepIndex ? "active" : ""}`;
      span.textContent = lbl;
      stepsRow.appendChild(span);
    });
    box.appendChild(stepsRow);
  }

  const head = document.createElement("div");
  head.className = "diag-head";

  const badge = document.createElement("span");
  badge.className = "diag-badge";
  badge.textContent =
    variant === "loading" ? "진단 중"
      : variant === "success" ? "정상"
        : variant === "warn" ? "대체 경로"
          : "확인 필요";

  const titleEl = document.createElement("strong");
  titleEl.className = "diag-title";
  titleEl.textContent = title;

  head.appendChild(badge);
  head.appendChild(titleEl);
  box.appendChild(head);

  if (detail) {
    const detailEl = document.createElement("p");
    detailEl.className = "diag-detail";
    detailEl.textContent = detail;
    box.appendChild(detailEl);
  }

  if (hint || actionLabel) {
    const foot = document.createElement("div");
    foot.className = "diag-foot";

    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "diag-hint";
      hintEl.textContent = hint;
      foot.appendChild(hintEl);
    }

    if (actionLabel && typeof onAction === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = variant === "success" ? "btn-primary btn-sm" : "btn-secondary btn-sm";
      btn.textContent = actionLabel;
      btn.addEventListener("click", onAction);
      foot.appendChild(btn);
    }

    box.appendChild(foot);
  }
}

export function updateStatusBadge(el, mode, text) {
  el.recStatusBadge.className = `status-badge ${mode}`;
  if (mode === "recording") {
    el.recStatusBadge.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
  } else {
    el.recStatusBadge.textContent = text;
  }
}

export function setSpeechBadge(el, mode, text) {
  el.speechStatusBadge.className = `speech-badge ${mode}`;
  el.speechStatusBadge.textContent = text;
}

export function updateCharCount(textarea, counterEl) {
  const text = textarea.value || "";
  const withSpaces = text.length;
  const withoutSpaces = text.replace(/\s+/g, "").length;
  const over = withSpaces > DRAFT_CHAR_LIMIT;
  counterEl.textContent = over
    ? `${withSpaces}/${DRAFT_CHAR_LIMIT}자 · ${withSpaces - DRAFT_CHAR_LIMIT}자 초과 — 붙여넣기 전에 줄여 주세요`
    : `${withSpaces}/${DRAFT_CHAR_LIMIT}자 (공백 제외 ${withoutSpaces}자)`;
  counterEl.classList.toggle("char-over", over);
}

export function renderModelSelectOptions(el, syncedModels = []) {
  const prevVal = el.modelSelect.value;
  el.modelSelect.innerHTML = "";

  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = "자동 (0.5x 가성비 상위 모델 우선 · gemini-3-flash 등)";
  el.modelSelect.appendChild(autoOpt);

  const catalogMap = new Map(GATEWAY_MODEL_CATALOG.map((m) => [m.id, m]));
  const listIds = syncedModels.length > 0
    ? Array.from(new Set([...GATEWAY_MODEL_CATALOG.map((m) => m.id).filter((id) => syncedModels.includes(id)), ...syncedModels]))
    : GATEWAY_MODEL_CATALOG.map((m) => m.id);

  listIds.forEach((id) => {
    const info = catalogMap.get(id);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = info ? info.label : id;
    el.modelSelect.appendChild(opt);
  });

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "직접 모델 ID 입력...";
  el.modelSelect.appendChild(customOpt);

  const exists = Array.from(el.modelSelect.options).some((o) => o.value === prevVal);
  el.modelSelect.value = exists ? prevVal : "auto";
}

export function renderChunkPills(el, segmentStatuses = []) {
  if (segmentStatuses.length === 0) {
    el.chunkStatusBox.classList.remove("visible");
    el.chunkPills.innerHTML = "";
    return;
  }
  el.chunkStatusBox.classList.add("visible");
  el.chunkPills.innerHTML = "";
  for (const s of segmentStatuses) {
    const span = document.createElement("span");
    span.className = `chunk-pill ${s.status}`;
    if (s.status === "processing") {
      span.textContent = `구간 #${s.index}: 요약 & 음성 폐기 중...`;
    } else if (s.status === "done") {
      span.textContent = `구간 #${s.index}: 포인트 ${s.summaryCount}개 · 음성 폐기됨`;
    } else {
      span.textContent = `구간 #${s.index}: 처리 오류 (복구 버퍼 유지)`;
    }
    el.chunkPills.appendChild(span);
  }
}

export function renderPointsList(el, finalResult) {
  el.pointsList.innerHTML = "";
  const points = finalResult?.conversationPoints || [];
  if (points.length === 0) {
    el.pointsList.innerHTML = `<div class="help-text">추출된 대화 포인트가 없습니다. 아래 입력칸에서 직접 추가할 수 있습니다.</div>`;
    return;
  }

  points.forEach((pt) => {
    const item = document.createElement("label");
    item.className = "point-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pt.checked !== false;
    cb.addEventListener("change", () => {
      pt.checked = cb.checked;
    });

    const body = document.createElement("div");
    body.className = "point-body";

    const tags = document.createElement("div");
    tags.className = "point-tags";

    const spTag = document.createElement("span");
    spTag.className = `tag ${pt.speaker === "평가자" ? "tag-reviewer" : pt.speaker === "피평가자" ? "tag-reviewee" : "tag-common"}`;
    spTag.textContent = pt.speaker;

    tags.appendChild(spTag);
    if (pt.kind) {
      const kindTag = document.createElement("span");
      kindTag.className = "tag tag-cat";
      kindTag.textContent = pt.kind;
      tags.appendChild(kindTag);
    }
    if (pt.relation) {
      const relTag = document.createElement("span");
      relTag.className = `tag ${RELATION_CLASS[pt.relation] || "tag-common"}`;
      relTag.textContent = pt.relation;
      tags.appendChild(relTag);
    }

    body.appendChild(tags);

    if (pt.topic) {
      const topicDiv = document.createElement("strong");
      topicDiv.className = "point-topic";
      topicDiv.textContent = pt.topic;
      body.appendChild(topicDiv);
    }

    const textDiv = document.createElement("div");
    textDiv.textContent = pt.summary;
    body.appendChild(textDiv);

    if (pt.quote) {
      const quoteDiv = document.createElement("div");
      quoteDiv.className = "point-quote";
      quoteDiv.textContent = `“${pt.quote}”`;
      body.appendChild(quoteDiv);
    }

    item.appendChild(cb);
    item.appendChild(body);
    el.pointsList.appendChild(item);
  });
}

const RELATION_CLASS = {
  "미션 관련": "rel-mission",
  "미션 밖 탐구": "rel-explore",
  잡담: "rel-chat"
};
const SPEAKER_CLASS = {
  평가자: "sp-reviewer",
  피평가자: "sp-reviewee",
  불명: "sp-unknown"
};

function pct(share) {
  return `${Math.round((share || 0) * 100)}%`;
}

function makeEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 비중 막대 한 줄: [{ label, share, cls }]
function makeShareBar(title, parts, note = "") {
  const wrap = makeEl("div", "refl-block");
  const head = makeEl("div", "refl-head");
  head.appendChild(makeEl("span", "refl-title", title));
  if (note) head.appendChild(makeEl("span", "help-text", note));
  wrap.appendChild(head);

  const bar = makeEl("div", "share-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${title}: ${parts.map((p) => `${p.label} ${pct(p.share)}`).join(", ")}`);
  for (const p of parts) {
    if (!(p.share > 0)) continue;
    const seg = makeEl("span", `share-seg ${p.cls}`);
    seg.style.width = `${p.share * 100}%`;
    seg.title = `${p.label} ${pct(p.share)}`;
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);

  const legend = makeEl("div", "share-legend");
  for (const p of parts) {
    const item = makeEl("span", "legend-item");
    item.appendChild(makeEl("span", `legend-swatch ${p.cls}`));
    item.appendChild(document.createTextNode(`${p.label} ${pct(p.share)}`));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * '대화 돌아보기' 영역을 그린다. reflection = { metrics, checklist, timelineNote }
 * 모델이 준 글자는 모두 textContent로만 넣는다.
 */
export function renderReflection(el, reflection) {
  if (!el.reflectionBody) return;
  el.reflectionBody.innerHTML = "";
  const metrics = reflection?.metrics;
  const checklist = reflection?.checklist || [];

  if (!metrics || metrics.utteranceCount === 0) {
    el.reflectionBody.appendChild(
      makeEl("div", "help-text", "말 단위 표시를 받지 못해 지표를 계산하지 못했습니다. 초안과 포인트는 그대로 쓸 수 있습니다.")
    );
  } else {
    el.reflectionBody.appendChild(
      makeShareBar(
        "발언 비중",
        [
          { label: "평가자", share: metrics.speakerShare.평가자, cls: SPEAKER_CLASS.평가자 },
          { label: "피평가자", share: metrics.speakerShare.피평가자, cls: SPEAKER_CLASS.피평가자 },
          { label: "화자 불명", share: metrics.speakerShare.불명, cls: SPEAKER_CLASS.불명 }
        ],
        `글자 수 기준 · 총 ${metrics.totalChars.toLocaleString("ko-KR")}자`
      )
    );

    const stats = makeEl("div", "refl-stats");
    const addStat = (label, value, sub = "") => {
      const box = makeEl("div", "refl-stat");
      box.appendChild(makeEl("span", "refl-stat-label", label));
      box.appendChild(makeEl("strong", "refl-stat-value", value));
      if (sub) box.appendChild(makeEl("span", "help-text", sub));
      stats.appendChild(box);
    };
    const q = metrics.questionCount;
    addStat("질문", `${q.total}번`, `평가자 ${q.평가자} · 피평가자 ${q.피평가자}${q.불명 ? ` · 불명 ${q.불명}` : ""}`);
    addStat("주고받기", `${metrics.turnCount}번`, "화자가 바뀐 횟수");
    const run = metrics.longestRun;
    if (run) {
      const range = Number.isFinite(run.startT) && Number.isFinite(run.endT)
        ? ` · ${formatSeconds(run.startT)}–${formatSeconds(run.endT)}`
        : "";
      addStat("가장 길게 이어진 설명", `${run.speaker} 약 ${run.chars.toLocaleString("ko-KR")}자`, `말 묶음 ${run.utteranceCount}개${range}`);
    }
    el.reflectionBody.appendChild(stats);

    if (metrics.relationLabeledChars > 0) {
      el.reflectionBody.appendChild(
        makeShareBar(
          "대화 성격",
          [
            { label: "미션 관련", share: metrics.relationShare["미션 관련"], cls: RELATION_CLASS["미션 관련"] },
            { label: "미션 밖 탐구", share: metrics.relationShare["미션 밖 탐구"], cls: RELATION_CLASS["미션 밖 탐구"] },
            { label: "잡담", share: metrics.relationShare.잡담, cls: RELATION_CLASS.잡담 }
          ],
          "글자 수 기준"
        )
      );
    }

    const tl = metrics.timeline;
    if (tl && tl.segments.length > 0) {
      const block = makeEl("div", "refl-block");
      const head = makeEl("div", "refl-head");
      head.appendChild(makeEl("span", "refl-title", tl.basis === "time" ? "시간 흐름" : "발언 순서 흐름"));
      head.appendChild(
        makeEl(
          "span",
          "help-text",
          tl.basis === "time"
            ? `녹음 경과 ${formatSeconds(tl.startSec)}–${formatSeconds(tl.startSec + tl.durationSec)} · 위: 대화 성격, 아래: 화자`
            : "시각 정보가 없어 글자 수 비례로 그렸습니다 · 위: 대화 성격, 아래: 화자"
        )
      );
      block.appendChild(head);

      for (const lane of ["relation", "speaker"]) {
        const strip = makeEl("div", `timeline-strip lane-${lane}`);
        // 같은 색이 이어지는 조각은 하나로 합쳐 경계선이 생기지 않게 한다
        const merged = [];
        for (const seg of tl.segments) {
          const label = lane === "relation" ? (seg.relation || "표시 없음") : seg.speaker;
          const last = merged[merged.length - 1];
          if (last && last.label === label) {
            last.width = seg.start + seg.width - last.start;
          } else {
            merged.push({ label, start: seg.start, width: seg.width, startSec: seg.startSec });
          }
        }
        for (const seg of merged) {
          const cls = lane === "relation"
            ? (RELATION_CLASS[seg.label] || "rel-none")
            : (SPEAKER_CLASS[seg.label] || "sp-unknown");
          const piece = makeEl("span", `timeline-seg ${cls}`);
          piece.style.left = `${seg.start * 100}%`;
          piece.style.width = `${seg.width * 100}%`;
          const when = Number.isFinite(seg.startSec) ? `${formatSeconds(seg.startSec)} ` : "";
          piece.title = `${when}${seg.label}`;
          strip.appendChild(piece);
        }
        block.appendChild(strip);
      }
      el.reflectionBody.appendChild(block);
    }
  }

  if (checklist.length > 0) {
    const block = makeEl("div", "refl-block");
    const head = makeEl("div", "refl-head");
    head.appendChild(makeEl("span", "refl-title", "체크 항목"));
    const coveredCount = checklist.filter((c) => c.covered === true).length;
    head.appendChild(makeEl("span", "help-text", `${checklist.length}개 중 ${coveredCount}개 다룸`));
    block.appendChild(head);
    const list = makeEl("ul", "checklist-result");
    for (const c of checklist) {
      const li = makeEl("li", "checklist-row");
      const badgeText = c.covered === true ? "다룸" : c.covered === false ? "안 다룸" : "확인 못 함";
      const badgeCls = c.covered === true ? "cov-yes" : c.covered === false ? "cov-no" : "cov-unknown";
      li.appendChild(makeEl("span", `cov-badge ${badgeCls}`, badgeText));
      const txt = makeEl("span", "checklist-item");
      txt.textContent = c.item;
      li.appendChild(txt);
      if (c.evidence) li.appendChild(makeEl("span", "help-text checklist-evidence", c.evidence));
      list.appendChild(li);
    }
    block.appendChild(list);
    el.reflectionBody.appendChild(block);
  }
}

export function renderResults(el, finalResult) {
  if (!finalResult) {
    el.resultsSection.classList.remove("visible");
    return;
  }
  el.resultsSection.classList.add("visible");

  el.roleSpeakerA.textContent = finalResult.inferredRoles.speakerA || "-";
  el.roleSpeakerB.textContent = finalResult.inferredRoles.speakerB || "-";

  renderPointsList(el, finalResult);
  renderReflection(el, finalResult.reflection);

  el.reviewerDraftTextarea.value = finalResult.reviewerToRevieweeDraft || "";
  el.revieweeDraftTextarea.value = finalResult.revieweeToReviewerDraft || "";
  updateCharCount(el.reviewerDraftTextarea, el.reviewerCharCount);
  updateCharCount(el.revieweeDraftTextarea, el.revieweeCharCount);

  el.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function updateRecordingButtons(el, { recordingState, isBusy }) {
  el.btnStartRec.disabled = isBusy || recordingState !== "idle";
  el.btnPauseRec.disabled = isBusy || (recordingState !== "recording" && recordingState !== "paused");
  el.btnRotateChunk.disabled = isBusy || (recordingState !== "recording" && recordingState !== "paused");
  el.btnStopAndGenerate.disabled = isBusy || (recordingState !== "recording" && recordingState !== "paused");
  el.btnImportFile.disabled = isBusy || recordingState !== "idle";
  el.btnGenerateFromTranscript.disabled = isBusy || recordingState !== "idle";

  if (recordingState === "idle") {
    el.btnPauseRec.textContent = "❚❚ 일시정지";
  }
}

export async function copyTextToClipboard(text, btn, originalLabel) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard API unavailable");
    }
  } catch {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.style.position = "fixed";
    temp.style.opacity = "0";
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    document.body.removeChild(temp);
  }

  btn.textContent = "복사됨";
  setTimeout(() => {
    btn.textContent = originalLabel;
  }, 1600);
}

export function drawIdleWaveform(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(12, canvas.height / 2 - 1, canvas.width - 24, 2);
}

export function startWaveform(canvas, stream, getRecordingState) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  const audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);

  const ctx = canvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  let animFrameId = null;

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (getRecordingState() !== "recording") {
      ctx.fillStyle = "#cbd5e1";
      ctx.fillRect(12, canvas.height / 2 - 1, canvas.width - 24, 2);
      return;
    }

    analyser.getByteFrequencyData(dataArray);
    const barWidth = Math.max(4, (canvas.width - 24) / bufferLength - 4);
    let x = 12;
    for (let i = 0; i < bufferLength; i++) {
      const val = dataArray[i] / 255;
      const barHeight = Math.max(3, val * (canvas.height - 14));
      const y = (canvas.height - barHeight) / 2;
      ctx.fillStyle = val > 0.65 ? "#1d4ed8" : val > 0.25 ? "#3b82f6" : "#94a3b8";
      ctx.fillRect(x, y, barWidth, barHeight);
      x += barWidth + 4;
    }
  }
  draw();

  return () => {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    audioCtx.close().catch(() => {});
    drawIdleWaveform(canvas);
  };
}
