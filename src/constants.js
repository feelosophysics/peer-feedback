export const DB_NAME = "peer_feedback_temp_db";
export const DB_VERSION = 1;
export const STORE_CHUNKS = "active_chunks";
export const STORE_NOTES = "extracted_notes";

export const GATEWAY_BASE_URL_STORAGE = "peer_feedback_gateway_base_url";
export const GATEWAY_KEY_STORAGE = "peer_feedback_key_gateway";
export const TRANSCRIPT_BACKUP_STORAGE = "peer_feedback_transcript_backup_v1";

export const SEGMENT_ROTATE_SECONDS = 6 * 60; // 6분 단위 자동 구간 분할 (16kHz 모노 WAV 약 11.5MB < 15MB)
export const CHUNK_TIMESLICE_MS = 5000; // 5초마다 IndexedDB 백업 기록
export const INLINE_SAFE_LIMIT_BYTES = 15 * 1024 * 1024; // 15MB (Base64 시 약 20MB)
export const AUDIO_BITRATE_BPS = 24000; // 24kbps 말소리 녹음 최적화
export const TARGET_WAV_SAMPLE_RATE = 16000; // 16kHz 모노 WAV 변환 표준

// OpenAI 호환 게이트웨이 기본 지원 CHAT 모델 카탈로그 (구형 2.5 이하 및 비-CHAT 제외)
export const GATEWAY_MODEL_CATALOG = [
  { id: "gemini-3-flash", label: "gemini-3-flash (Google · 0.5x · 음성/대본 1순위)", weight: 0.5, audioCapable: true },
  { id: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite (Google · 0.5x · 경량)", weight: 0.5, audioCapable: true },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini (OpenAI · 0.5x · 대본 가성비)", weight: 0.5, audioCapable: false },
  { id: "claude-haiku-4", label: "claude-haiku-4 (Anthropic · 0.5x · 대본 가성비)", weight: 0.5, audioCapable: false },
  { id: "gpt-5-mini", label: "gpt-5-mini (OpenAI · 0.5x · 대본 가성비)", weight: 0.5, audioCapable: false },
  { id: "claude-sonnet-4", label: "claude-sonnet-4 (Anthropic · 1.0x · 한국어 피드백 추천)", weight: 1.0, audioCapable: false },
  { id: "gpt-5.4", label: "gpt-5.4 (OpenAI · 1.0x · 대본 표준)", weight: 1.0, audioCapable: false },
  { id: "gemini-3.1-pro", label: "gemini-3.1-pro (Google · 1.5x · 고정밀)", weight: 1.5, audioCapable: true },
  { id: "claude-opus-4-7", label: "claude-opus-4-7 (Anthropic · 1.5x · 최고급)", weight: 1.5, audioCapable: false },
  { id: "claude-opus-4-8", label: "claude-opus-4-8 (Anthropic · 1.5x · 최고급)", weight: 1.5, audioCapable: false },
  { id: "gpt-5.5", label: "gpt-5.5 (OpenAI · 2.0x · 최고급)", weight: 2.0, audioCapable: false }
];

// 동료평가 플랫폼의 피드백 입력란 글자 수 상한
export const DRAFT_CHAR_LIMIT = 2000;
