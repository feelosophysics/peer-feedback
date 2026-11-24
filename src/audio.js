import { AUDIO_BITRATE_BPS, TARGET_WAV_SAMPLE_RATE } from "./constants.js";
import { normalizeAudioMimeType } from "./utils.js";

export function encodeMonoPcmToWavBuffer(float32Samples, sampleRate = TARGET_WAV_SAMPLE_RATE) {
  const numSamples = float32Samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  function writeAscii(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * 1 * 2
  view.setUint16(32, 2, true); // BlockAlign = 1 * 2
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

export function encodeMonoPcmToWavBlob(float32Samples, sampleRate = TARGET_WAV_SAMPLE_RATE) {
  const buffer = encodeMonoPcmToWavBuffer(float32Samples, sampleRate);
  return new Blob([buffer], { type: "audio/wav" });
}

export function createSilentWavBlob(durationSec = 0.4, sampleRate = TARGET_WAV_SAMPLE_RATE) {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  return encodeMonoPcmToWavBlob(new Float32Array(numSamples), sampleRate);
}

// 음성 전달 점검용 신호음 WAV. 무음은 중간에서 잘려도 티가 나지 않으므로 소리가 있는 신호를 쓴다.
export function createToneWavBlob(durationSec = 2, sampleRate = TARGET_WAV_SAMPLE_RATE, freqHz = 440) {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.25;
  }
  return encodeMonoPcmToWavBlob(samples, sampleRate);
}

export async function convertAudioBlobToWav16kMono(blob, onWarn) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioCtx || !OfflineCtx) {
    return { blob, cleanMime: normalizeAudioMimeType(blob.type), converted: false };
  }

  let tempCtx = null;
  try {
    const arrBuf = await blob.arrayBuffer();
    tempCtx = new AudioCtx();
    const decoded = await tempCtx.decodeAudioData(arrBuf);
    const targetLength = Math.max(1, Math.round(decoded.duration * TARGET_WAV_SAMPLE_RATE));
    const offline = new OfflineCtx(1, targetLength, TARGET_WAV_SAMPLE_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    const wavBlob = encodeMonoPcmToWavBlob(pcm, TARGET_WAV_SAMPLE_RATE);
    return { blob: wavBlob, cleanMime: "audio/wav", converted: true };
  } catch (err) {
    if (typeof onWarn === "function") {
      onWarn(`16kHz WAV 변환 실패 (원본 형식으로 전송 시도): ${err.message}`);
    }
    return { blob, cleanMime: normalizeAudioMimeType(blob.type), converted: false };
  } finally {
    if (tempCtx) {
      tempCtx.close().catch(() => {});
    }
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const commaIdx = typeof dataUrl === "string" ? dataUrl.indexOf(",") : -1;
      if (commaIdx === -1) {
        reject(new Error("Base64 인코딩 변환 실패"));
        return;
      }
      resolve(dataUrl.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("파일 읽기 오류"));
    reader.readAsDataURL(blob);
  });
}

export function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function createMediaRecorderForStream(stream, mimeType) {
  const attempts = [];
  if (mimeType) {
    attempts.push({ mimeType, audioBitsPerSecond: AUDIO_BITRATE_BPS });
    attempts.push({ mimeType });
  }
  attempts.push({ audioBitsPerSecond: AUDIO_BITRATE_BPS });
  attempts.push({});

  for (const opts of attempts) {
    try {
      return Object.keys(opts).length > 0 ? new MediaRecorder(stream, opts) : new MediaRecorder(stream);
    } catch {
      // Try next fallback options
    }
  }
  throw new Error("이 브라우저에서 MediaRecorder를 시작할 수 없습니다.");
}
