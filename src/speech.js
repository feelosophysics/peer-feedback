export function createSpeechController({ onFinalChunk, onInterim, onStatusChange, onLog }) {
  let recognition = null;
  let allowRestart = false;
  let networkErrorCount = 0;
  let hasEverReceivedSpeech = false;
  let restartTimer = null;
  let lastErrorCode = "";
  let disabledReason = "";
  let lastInterim = "";
  let currentSegmentTranscript = "";
  let committedSegments = {};
  let isRecordingActive = false;

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function scheduleRestart(delayMs = 250) {
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!allowRestart || !isRecordingActive || disabledReason || !recognition) {
        return;
      }
      try {
        recognition.start();
      } catch {
        if (allowRestart && isRecordingActive && !disabledReason) {
          scheduleRestart(Math.min(delayMs * 2, 2000));
        }
      }
    }, delayMs);
  }

  function setActive(active) {
    isRecordingActive = Boolean(active);
  }

  function start() {
    clearRestartTimer();
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      disabledReason = "브라우저 음성인식 미지원 (오디오 녹음만 진행)";
      onStatusChange?.("unsupported", disabledReason);
      onLog?.("이 브라우저는 Web Speech API를 지원하지 않아 오디오 녹음만 수행합니다.", "warn");
      return;
    }

    allowRestart = true;
    networkErrorCount = 0;
    lastErrorCode = "";
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
      if (!disabledReason && networkErrorCount === 0) {
        onStatusChange?.("active", "실시간 한국어 받아적기 중");
      }
    };

    rec.onresult = (event) => {
      hasEverReceivedSpeech = true;
      if (networkErrorCount > 0) {
        networkErrorCount = 0;
        if (!disabledReason) {
          onStatusChange?.("active", "실시간 한국어 받아적기 중");
        }
      }
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
      lastErrorCode = errCode;
      if (errCode === "no-speech" || errCode === "aborted") {
        return;
      }
      if (errCode === "not-allowed" || errCode === "service-not-allowed" || errCode === "audio-capture") {
        allowRestart = false;
        clearRestartTimer();
        disabledReason = `음성인식 제한됨 (${errCode})`;
        onStatusChange?.("unsupported", disabledReason);
        onLog?.(`Web Speech API 사용 불가(${errCode}) — 마이크 권한 또는 브라우저 설정을 확인하세요.`, "warn");
        return;
      }
      if (errCode === "network") {
        networkErrorCount += 1;
        if (!hasEverReceivedSpeech && networkErrorCount >= 5) {
          allowRestart = false;
          clearRestartTimer();
          disabledReason = "음성인식 연결 불가 (일반 Google Chrome 필요)";
          onStatusChange?.("unsupported", disabledReason);
          onLog?.(
            "실시간 음성인식 연결 실패(network) 5회 연속 — 내장 웹뷰 등 비-Chrome 브라우저에서는 음성인식 서버에 연결되지 않아 자동 재시도를 중단했습니다.",
            "warn"
          );
          return;
        }
        if (networkErrorCount >= 3) {
          onStatusChange?.("warn", `네트워크 재연결 중 (${networkErrorCount}회)`);
          onLog?.(
            `실시간 음성인식 네트워크 일시 끊김 (${networkErrorCount}회 연속) — 자동 재연결을 계속 시도합니다.`,
            "warn"
          );
        }
        return;
      }
      onLog?.(`실시간 음성인식 일시 경고(${errCode}) — 자동 재시작 대기`, "warn");
    };

    rec.onend = () => {
      onInterim?.("");
      if (disabledReason) {
        onStatusChange?.("unsupported", disabledReason);
      } else if (allowRestart && isRecordingActive) {
        const delay = lastErrorCode === "network"
          ? Math.min(1000 * Math.pow(2, Math.max(0, networkErrorCount - 1)), 5000)
          : 250;
        lastErrorCode = "";
        scheduleRestart(delay);
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
    clearRestartTimer();
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
    clearRestartTimer();
    currentSegmentTranscript = "";
    lastInterim = "";
    committedSegments = {};
    networkErrorCount = 0;
    hasEverReceivedSpeech = false;
    lastErrorCode = "";
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
