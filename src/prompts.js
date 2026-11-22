import { PEER_FEEDBACK_CRITERIA } from "./constants.js";

export function getToneInstruction(tone) {
  if (tone === "formal_hapsyo") {
    return "정중한 격식체('~했습니다', '~해주셨습니다', '~보완하면 좋겠습니다')로 작성하세요.";
  }
  if (tone === "plain_concise") {
    return "담백하고 핵심만 짚는 평어·요약체('~함이 좋았음', '~부분 보완 필요')로 작성하세요.";
  }
  return "따뜻하면서도 구체적인 정중한 해요체('~해주셔서 좋았어요', '~부분을 더 다듬으면 좋겠습니다')로 작성하세요.";
}

export function getLengthInstruction(length) {
  if (length === "short") {
    return "각 초안은 3–4문장 내외(약 150–250자)로 핵심만 간결하게 작성하세요.";
  }
  if (length === "long") {
    return "각 초안은 대화 속 구체적 사례·질문·기술 키워드를 충실히 담아 2–3문단(약 450–700자)으로 상세하게 작성하세요.";
  }
  return "각 초안은 동료평가 입력란에 바로 붙여넣기 좋은 1–2문단(약 250–450자) 분량으로 작성하세요.";
}

export function buildSingleShotAudioPrompt({ memo = "", tone = "polite_haeyo", length = "medium", supplementalTranscript = "" } = {}) {
  const cleanMemo = memo.trim();
  const toneDesc = getToneInstruction(tone);
  const lenDesc = getLengthInstruction(length);
  const extraNote = supplementalTranscript && supplementalTranscript.trim()
    ? `\n[보조 실시간 음성인식 대본(참고용 — 실제 오디오를 우선하되 기술 용어 파악에 참고)]\n${supplementalTranscript.trim()}\n`
    : "";

  return `당신은 소프트웨어 학습 과정의 동료평가 대화 분석 도우미입니다.
첨부된 음성 대화는 두 명의 학습자(평가자/리뷰어와 피평가자/리뷰이)가 과제 결과물을 두고 나눈 동료평가 대화입니다.

[사용자 사전 메모]
${cleanMemo ? cleanMemo : "(별도 메모 없음 — 대화 내용과 문맥으로 미션과 화자 역할을 추론하세요.)"}${extraNote}
${PEER_FEEDBACK_CRITERIA}

[수행 지시]
1. 목소리 특징과 대화 역할(질문·코드 검증·채점 기준 확인 쪽이 '평가자', 자신의 구현 의도·트러블슈팅을 설명하고 답변하는 쪽이 '피평가자')을 구분해 화자를 분리하세요.
2. 대화에서 실제로 언급된 코드/기술/설계 의도(Why)/질문/해결 과정과 "피드백 적을 때 미처 떠올리지 못해 빠뜨리기 쉬운 세부 사항"까지 포인트로 추출하세요.
3. 아래 JSON 스키마로만 정확히 응답하세요.
   - reviewerToRevieweeDraft: 평가자가 피평가자에게 남기는 주 피드백 초안 (좋은 피드백 기준 반영)
   - revieweeToReviewerDraft: 피평가자가 평가자에게 남기는 감사·상호 피드백 초안 (질문·함께 짚은 관점·배운 점 포함)
   - 말투 규칙: ${toneDesc}
   - 분량 규칙: ${lenDesc}

[출력 JSON 스키마]
{
  "inferredRoles": {
    "speakerA": "예: 평가자 (질문과 예외 케이스 검증을 주도)",
    "speakerB": "예: 피평가자 (구현 구조와 에러 처리 과정을 설명)"
  },
  "conversationPoints": [
    {
      "id": "p1",
      "speaker": "평가자" | "피평가자" | "공통",
      "category": "질문/검증" | "구현설명" | "칭찬/강점" | "개선제안/놓친점",
      "summary": "구체적인 대화 핵심 내용 1문장"
    }
  ],
  "reviewerToRevieweeDraft": "평가자 -> 피평가자 피드백 줄글 초안",
  "revieweeToReviewerDraft": "피평가자 -> 평가자 피드백 줄글 초안"
}`;
}

export function buildSingleShotTranscriptPrompt({ memo = "", tone = "polite_haeyo", length = "medium", transcriptText = "" } = {}) {
  const cleanMemo = memo.trim();
  const toneDesc = getToneInstruction(tone);
  const lenDesc = getLengthInstruction(length);

  return `당신은 소프트웨어 학습 과정의 동료평가 대화 분석 도우미입니다.
아래는 두 명의 학습자(평가자/리뷰어와 피평가자/리뷰이)가 과제 결과물을 두고 나눈 대화를 브라우저 실시간 음성인식(또는 사용자 메모)으로 받아적은 대본입니다.
음성인식 특성상 화자 구분 표시가 없고 띄어쓰기·동음이의어·개발 용어 오탈자가 있을 수 있으므로 문맥으로 자연스럽게 보정해 해석하세요.

[사용자 사전 메모]
${cleanMemo ? cleanMemo : "(별도 메모 없음 — 대화 내용과 문맥으로 미션과 화자 역할을 추론하세요.)"}

[대화 대본]
${transcriptText}

${PEER_FEEDBACK_CRITERIA}

[수행 지시]
1. 문맥상 질문·코드 검증·채점 기준 확인·개선 제안을 하는 쪽을 '평가자', 자신의 구현 의도·트러블슈팅·답변을 설명하는 쪽을 '피평가자'로 구분해 화자를 분리하세요.
2. 대화에서 언급된 구체적인 기술/설계 의도(Why)/질문/해결 과정과 "피드백 적을 때 미처 떠올리지 못해 빠뜨리기 쉬운 세부 사항"을 포인트로 추출하세요. 대본에 없는 내용은 지어내지 마세요.
3. 아래 JSON 스키마로만 정확히 응답하세요.
   - 말투 규칙: ${toneDesc}
   - 분량 규칙: ${lenDesc}

[출력 JSON 스키마]
{
  "inferredRoles": {
    "speakerA": "예: 평가자 (질문과 예외 케이스 검증을 주도)",
    "speakerB": "예: 피평가자 (구현 구조와 에러 처리 과정을 설명)"
  },
  "conversationPoints": [
    {
      "id": "p1",
      "speaker": "평가자" | "피평가자" | "공통",
      "category": "질문/검증" | "구현설명" | "칭찬/강점" | "개선제안/놓친점",
      "summary": "구체적인 대화 핵심 내용 1문장"
    }
  ],
  "reviewerToRevieweeDraft": "평가자 -> 피평가자 피드백 줄글 초안",
  "revieweeToReviewerDraft": "피평가자 -> 평가자 피드백 줄글 초안"
}`;
}

export function buildSegmentExtractPrompt({ memo = "", segmentIndex, previousRoleHint = "", supplementalTranscript = "" }) {
  const cleanMemo = memo.trim();
  const extraNote = supplementalTranscript && supplementalTranscript.trim()
    ? `\n[이 구간의 보조 실시간 음성인식 대본]\n${supplementalTranscript.trim()}\n`
    : "";

  return `당신은 소프트웨어 학습 과정의 동료평가 대화 중간 구간 분석 도우미입니다.
이 음성은 긴 동료평가 대화의 [제${segmentIndex}구간]입니다.

[사용자 사전 메모]
${cleanMemo ? cleanMemo : "(별도 메모 없음)"}

[이전 구간 화자 역할 단서]
${previousRoleHint ? previousRoleHint : "(첫 번째 구간입니다. 질문·검증을 주도하는 쪽을 '평가자', 구현·답변을 설명하는 쪽을 '피평가자'로 추론하세요.)"}${extraNote}
[수행 지시]
1. 이전 구간의 화자 역할 일관성을 유지하면서 이 구간 오디오에서 오간 핵심 대화 포인트를 빠짐없이 추출하세요.
2. 확인한 기능의 근거(What/Why), 구체적 질문, 함께 찾은 문제 해결 과정, 개선 제안 및 배운 점을 포함하세요.
3. 반드시 아래 JSON 형식으로만 응답하세요.

{
  "inferredRoles": {
    "speakerA": "화자 A 역할 및 특징 요약",
    "speakerB": "화자 B 역할 및 특징 요약"
  },
  "points": [
    {
      "speaker": "평가자" | "피평가자" | "공통",
      "category": "질문/검증" | "구현설명" | "칭찬/강점" | "개선제안/놓친점",
      "summary": "구체적인 대화 핵심 내용 1문장"
    }
  ],
  "segmentSummary": "이 구간 대화 요약 2–3문장"
}`;
}

export function buildSegmentTranscriptPrompt({ memo = "", segmentIndex, previousRoleHint = "", transcriptText = "" }) {
  const cleanMemo = memo.trim();
  return `당신은 소프트웨어 학습 과정의 동료평가 대화 중간 구간 분석 도우미입니다.
아래는 긴 동료평가 대화 중 [제${segmentIndex}구간]의 실시간 음성인식 대본입니다. 오탈자와 개발 용어 동음이의어는 문맥으로 보정해 해석하세요.

[사용자 사전 메모]
${cleanMemo ? cleanMemo : "(별도 메모 없음)"}

[이전 구간 화자 역할 단서]
${previousRoleHint ? previousRoleHint : "(첫 번째 구간입니다. 질문·검증을 주도하는 쪽을 '평가자', 구현·답변을 설명하는 쪽을 '피평가자'로 추론하세요.)"}

[구간 대본]
${transcriptText}

[수행 지시]
1. 이전 구간의 화자 역할 일관성을 유지하면서 이 구간 대화에서 오간 핵심 포인트(기능·코드의 Why, 질문, 문제 해결 과정, 배운 점)를 빠짐없이 추출하세요.
2. 반드시 아래 JSON 형식으로만 응답하세요.

{
  "inferredRoles": {
    "speakerA": "화자 A 역할 및 특징 요약",
    "speakerB": "화자 B 역할 및 특징 요약"
  },
  "points": [
    {
      "speaker": "평가자" | "피평가자" | "공통",
      "category": "질문/검증" | "구현설명" | "칭찬/강점" | "개선제안/놓친점",
      "summary": "구체적인 대화 핵심 내용 1문장"
    }
  ],
  "segmentSummary": "이 구간 대화 요약 2–3문장"
}`;
}

export function buildSynthesizeFromNotesPrompt({ memo = "", tone = "polite_haeyo", length = "medium", notesArray = [] }) {
  const cleanMemo = memo.trim();
  const toneDesc = getToneInstruction(tone);
  const lenDesc = getLengthInstruction(length);

  return `당신은 소프트웨어 학습 과정의 동료평가 상호 피드백 작성 전문가입니다.
아래는 장시간 동료평가 대화를 구간별로 나누어 추출하고 음성은 이미 폐기한 뒤 남은 텍스트 대화 노트입니다.

[사용자 사전 메모]
${cleanMemo ? cleanMemo : "(없음)"}

[구간별 추출 노트 JSON]
${JSON.stringify(notesArray, null, 2)}

${PEER_FEEDBACK_CRITERIA}

[수행 지시]
1. 전 구간에 걸쳐 중복되는 포인트를 깔끔하게 합치되, 놓치기 쉬운 기술적 디테일은 보존하여 conversationPoints를 정리하세요.
2. 이를 바탕으로 평가자 입장과 피평가자 입장의 피드백 초안을 각각 작성하세요.
   - 말투 규칙: ${toneDesc}
   - 분량 규칙: ${lenDesc}

[출력 JSON 스키마]
{
  "inferredRoles": {
    "speakerA": "화자 A 역할 추론 종합",
    "speakerB": "화자 B 역할 추론 종합"
  },
  "conversationPoints": [
    {
      "id": "p1",
      "speaker": "평가자" | "피평가자" | "공통",
      "category": "질문/검증" | "구현설명" | "칭찬/강점" | "개선제안/놓친점",
      "summary": "핵심 내용"
    }
  ],
  "reviewerToRevieweeDraft": "평가자 -> 피평가자 피드백 초안",
  "revieweeToReviewerDraft": "피평가자 -> 평가자 피드백 초안"
}`;
}

export function buildRefineFromPointsPrompt({ memo = "", tone = "polite_haeyo", length = "medium", activePoints = [], inferredRoles = {} }) {
  const cleanMemo = memo.trim();
  const toneDesc = getToneInstruction(tone);
  const lenDesc = getLengthInstruction(length);

  return `당신은 동료평가 상호 피드백 편집기입니다.
사용자가 확정한 화자 역할과 체크된 핵심 대화 포인트를 바탕으로 양쪽의 피드백 초안을 다시 작성하세요.

[사전 메모]
${cleanMemo ? cleanMemo : "(없음)"}

[확정된 화자 역할]
${JSON.stringify(inferredRoles)}

[반영할 핵심 대화 포인트 목록]
${JSON.stringify(activePoints, null, 2)}

${PEER_FEEDBACK_CRITERIA}

[작성 규칙]
- 말투: ${toneDesc}
- 분량: ${lenDesc}
- 위에 나열된 포인트만 근거로 삼아 자연스러운 줄글로 엮고, 사실에 없는 내용을 지어내지 마세요.
- 아래 JSON으로만 응답하세요.

{
  "reviewerToRevieweeDraft": "평가자 -> 피평가자 피드백 초안",
  "revieweeToReviewerDraft": "피평가자 -> 평가자 피드백 초안"
}`;
}
