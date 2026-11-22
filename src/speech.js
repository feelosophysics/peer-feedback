export function createSpeechController({ onFinalChunk, onInterim, onStatusChange, onLog }) {
  let recognition = null;
  let allowRestart = false;
  let networkErrorCount = 0;
  let disabledReason = "";
  let lastInterim = "";
  let currentSegmentTranscript = "";
  let committedSegments = {};
  let isRecordingActive = false;

  function setActive(active) {
    isRecordingActive = Boolean(active);
  }

  function start() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      disabledReason = "브라우저 음성인식 미지원 (오디오 녹음만 진행)";
      onStatusChange?.("unsupported", disabledReason);
      onLog?.("이 브라우저는 Web Speech API를 지원하지 않아 오디오 녹음만 수행합니다.", "warn");
      return;
    }

    allowRestart = true;
    networkErrorCount = 0;
    disabledReason = "";
    lastInterim = "";

    if (recognition) {
      try { recognition.abort(); } catch { /* ignore */ }
      recognition = null;
    }

    const rec = new SpeechRec();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      if (!disabledReason) {
        onStatusChange?.("active", "실시간 한국어 받아적기 중");
      }
    };

    rec.onresult = (event) => {
      networkErrorCount = 0;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = (res[0] && res[0].transcript) ? res[0].transcript.trim() : "";
        if (!txt) continue;
        if (res.isFinal) {
          currentSegmentTranscript = currentSegmentTranscript
            ? `${currentSegmentTranscript}\n${txt}`
            : txt;
          onFinalChunk?.(txt);
        } else {
          interim = interim ? `${interim} ${txt}` : txt;
        }
      }
      lastInterim = interim;
      onInterim?.(interim);
    };

    rec.onerror = (event) => {
      const errCode = event.error || "unknown";
      if (errCode === "no-speech" || errCode === "aborted") {
        return;
      }
      if (errCode === "not-allowed" || errCode === "service-not-allowed") {
        allowRestart = false;
        disabledReason = `음성인식 제한됨 (${errCode})`;
        onStatusChange?.("unsupported", disabledReason);
        onLog?.(`Web Speech API 사용 불가(${errCode}) — 오디오 녹음은 계속 진행됩니다.`, "warn");
        return;
      }
      if (errCode === "network") {
        networkErrorCount += 1;
        if (networkErrorCount >= 2) {
          allowRestart = false;
          disabledReason = "음성인식 연결 불가 (일반 Google Chrome 필요)";
          onStatusChange?.("unsupported", disabledReason);
          onLog?.(
            "실시간 음성인식 연결 실패(network) 2회 연속 — 내장 웹뷰 등 비-Chrome 브라우저에서는 음성인식 서버에 연결되지 않아 자동 재시도를 중단했습니다. (오디오 녹음은 정상 유지)",
            "warn"
          );
        }
        return;
      }
      onLog?.(`실시간 음성인식 일시 경고(${errCode}) — 오디오 녹음 정상 유지`, "warn");
    };

    rec.onend = () => {
      onInterim?.("");
      if (disabledReason) {
        onStatusChange?.("unsupported", disabledReason);
      } else if (allowRestart && isRecordingActive) {
        setTimeout(() => {
          if (allowRestart && isRecordingActive) {
            try { rec.start(); } catch { /* ignore */ }
          }
        }, 250);
      } else {
        onStatusChange?.("", isRecordingActive ? "음성인식 일시정지" : "대기");
      }
    };

    recognition = rec;
    try {
      rec.start();
    } catch (err) {
      disabledReason = "음성인식 시작 실패 (오디오만 진행)";
      onStatusChange?.("unsupported", disabledReason);
      onLog?.(`Web Speech API 시작 실패: ${err.message}`, "warn");
    }
  }

  function stop(flushInterim = true, nextBadgeText = "대기") {
    allowRestart = false;
    if (flushInterim && lastInterim) {
      const tail = lastInterim.trim();
      if (tail) {
        currentSegmentTranscript = currentSegmentTranscript
          ? `${currentSegmentTranscript}\n${tail}`
          : tail;
        onFinalChunk?.(tail);
      }
    }
    lastInterim = "";
    onInterim?.("");

    if (recognition) {
      try { recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
    if (!disabledReason) {
      onStatusChange?.("", nextBadgeText);
    }
  }

  function consumeSegmentTranscript(segmentIndex) {
    const text = (currentSegmentTranscript || "").trim();
    committedSegments[segmentIndex] = text;
    currentSegmentTranscript = "";
    return text;
  }

  function reset() {
    currentSegmentTranscript = "";
    lastInterim = "";
    committedSegments = {};
    networkErrorCount = 0;
    disabledReason = "";
    onInterim?.("");
    onStatusChange?.("", "대기");
  }

  return {
    setActive,
    start,
    stop,
    consumeSegmentTranscript,
    reset
  };
}
