export const DB_NAME = "peer_feedback_temp_db";
export const DB_VERSION = 1;
export const STORE_CHUNKS = "active_chunks";
export const STORE_NOTES = "extracted_notes";

export const GATEWAY_BASE_URL_STORAGE = "peer_feedback_gateway_base_url";
export const GATEWAY_KEY_STORAGE = "peer_feedback_key_gateway";

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

export const PEER_FEEDBACK_CRITERIA = `[좋은 동료평가 피드백 기준]
- 확인한 기능·코드의 What(무엇을)뿐 아니라 Why(설계 의도, 트레이드오프, 방법론 선택 이유)를 구체적으로 기술하세요.
- 평가를 진행하며 평가자·피평가자가 서로 새롭게 배우거나 인사이트를 얻은 점을 담으세요.
- 문제나 엣지 케이스를 발견했다면 함께 원인을 추적하고 해결 방안을 토의한 과정을 서술하세요.
- 개선 제안이나 판정에는 대화에서 나온 코드·동작의 구체적 근거를 밝히고, 존중과 격려의 표현을 담으세요.
- 금지 표현: "모든 기능이 정상 작동했습니다", "코드가 깔끔하고 인상 깊었습니다", "Awesome", "Good!!", "수고하셨습니다!"처럼 근거 없는 상투어나 일방적 지적은 절대 쓰지 마세요.`;
