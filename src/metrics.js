// '대화 돌아보기' 지표 계산. 모두 순수 함수다.
// 모델은 대본 줄마다 화자·질문 여부·미션 관련도만 표시하고, 숫자는 여기서 센다.

export const SPEAKERS = ["평가자", "피평가자", "불명"];
export const RELATION_KEYS = ["미션 관련", "미션 밖 탐구", "잡담"];

export function splitTranscriptLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function numberTranscriptLines(lines) {
  return lines.map((line, idx) => `[${idx + 1}] ${line}`).join("\n");
}

/**
 * 대본 줄마다 녹음 경과 초를 찾아 붙인다.
 * timedLines는 음성인식이 확정한 순서대로의 { t, text } 목록이다. 사용자가 대본을 고쳤을 수 있으므로
 * 같은 글자의 다음 기록을 앞에서부터 찾아 맞추고, 못 찾은 줄은 null로 둔다.
 */
export function alignTranscriptTimes(lines, timedLines = []) {
  const entries = Array.isArray(timedLines) ? timedLines : [];
  let cursor = 0;
  return lines.map((line) => {
    const target = String(line || "").trim();
    for (let i = cursor; i < entries.length; i++) {
      if (String(entries[i]?.text || "").trim() === target && Number.isFinite(entries[i]?.t)) {
        cursor = i + 1;
        return entries[i].t;
      }
    }
    return null;
  });
}

export function normalizeSpeaker(raw) {
  const s = String(raw || "").trim();
  if (/^피평가자|reviewee/i.test(s)) return "피평가자";
  if (/^평가자|reviewer/i.test(s)) return "평가자";
  return "불명";
}

export function normalizeRelation(raw) {
  const s = String(raw || "").trim();
  if (/잡담|off[-\s]?topic|chit/i.test(s)) return "잡담";
  if (/탐구|밖|explor/i.test(s)) return "미션 밖 탐구";
  if (/미션|관련|mission|related/i.test(s)) return "미션 관련";
  return null;
}

function toBool(v) {
  return v === true || v === "true" || v === 1 || v === "yes";
}

function toLineNo(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 모델이 표시한 말 묶음을 브라우저에서 셀 수 있는 형태로 바꾼다.
 * - 대본 줄이 있으면 from–to 줄 번호로 글자 수와 시작 시각을 구한다. 표시되지 않은 줄은 '불명'으로 채운다.
 * - 대본 줄이 없으면(음성만 보낸 경우) 묶음의 받아적기 text 길이를 쓴다.
 * 결과: [{ speaker, isQuestion, relation, chars, t, firstLine }]
 */
export function resolveUtterances(rawUtterances, lines = [], times = []) {
  const raw = Array.isArray(rawUtterances) ? rawUtterances : [];

  if (lines.length === 0) {
    return raw
      .map((u) => ({
        speaker: normalizeSpeaker(u?.speaker),
        isQuestion: toBool(u?.question),
        relation: normalizeRelation(u?.relation),
        chars: String(u?.text || "").replace(/\s+/g, "").length,
        t: null,
        firstLine: null
      }))
      .filter((u) => u.chars > 0);
  }

  // 줄마다 어느 묶음에 속하는지 표시(먼저 표시된 묶음이 우선)
  const owner = new Array(lines.length).fill(-1);
  raw.forEach((u, idx) => {
    let from = toLineNo(u?.from);
    let to = toLineNo(u?.to ?? u?.from);
    if (from === null || to === null) return;
    if (from > to) [from, to] = [to, from];
    from = Math.max(1, from);
    to = Math.min(lines.length, to);
    for (let ln = from; ln <= to; ln++) {
      if (owner[ln - 1] === -1) owner[ln - 1] = idx;
    }
  });

  // 같은 묶음(또는 표시 안 된 줄끼리)이 이어지는 구간을 하나의 말 묶음으로 만든다
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const ownerIdx = owner[i];
    let j = i;
    while (j + 1 < lines.length && owner[j + 1] === ownerIdx) j++;
    const src = ownerIdx >= 0 ? raw[ownerIdx] : null;
    let chars = 0;
    for (let k = i; k <= j; k++) chars += lines[k].replace(/\s+/g, "").length;
    const startTime = times.slice(i, j + 1).find((t) => Number.isFinite(t));
    result.push({
      speaker: src ? normalizeSpeaker(src.speaker) : "불명",
      isQuestion: src ? toBool(src.question) : false,
      relation: src ? normalizeRelation(src.relation) : null,
      chars,
      t: Number.isFinite(startTime) ? startTime : null,
      firstLine: i + 1
    });
    i = j + 1;
  }
  return result;
}

export function swapUtteranceSpeakers(utterances = []) {
  return utterances.map((u) => ({
    ...u,
    speaker: u.speaker === "평가자" ? "피평가자" : u.speaker === "피평가자" ? "평가자" : u.speaker
  }));
}

function shareOf(counts, total) {
  const out = {};
  for (const [k, v] of Object.entries(counts)) out[k] = total > 0 ? v / total : 0;
  return out;
}

/**
 * 말 묶음 목록에서 돌아보기 지표를 계산한다.
 * - 발언 비중: 화자별 글자 수(공백 제외)
 * - 질문 수: 화자별 질문 묶음 수
 * - 주고받기: 화자가 알려진 묶음 사이에서 화자가 바뀐 횟수
 * - 가장 길게 이어진 설명: 같은 화자가 끊기지 않고 이어 말한 구간 중 글자 수가 가장 많은 것
 * - 대화 성격: 미션 관련 / 미션 밖 탐구 / 잡담 글자 수 비중(표시 없는 부분은 제외)
 * - 타임라인: 시각 정보가 충분하면 초 단위, 아니면 글자 수 비례의 순서 기반
 */
export function computeConversationMetrics(utterances = []) {
  const list = (Array.isArray(utterances) ? utterances : []).filter((u) => u && u.chars > 0);

  const speakerChars = { 평가자: 0, 피평가자: 0, 불명: 0 };
  const questionCount = { 평가자: 0, 피평가자: 0, 불명: 0 };
  const relationChars = { "미션 관련": 0, "미션 밖 탐구": 0, 잡담: 0 };
  let totalChars = 0;

  for (const u of list) {
    const sp = SPEAKERS.includes(u.speaker) ? u.speaker : "불명";
    speakerChars[sp] += u.chars;
    totalChars += u.chars;
    if (u.isQuestion) questionCount[sp] += 1;
    if (u.relation && relationChars[u.relation] !== undefined) relationChars[u.relation] += u.chars;
  }

  // 주고받기: 불명 묶음은 건너뛰고 알려진 화자끼리 비교
  let turnCount = 0;
  let prevKnown = null;
  for (const u of list) {
    if (u.speaker === "불명") continue;
    if (prevKnown && prevKnown !== u.speaker) turnCount += 1;
    prevKnown = u.speaker;
  }

  // 가장 길게 이어진 설명 구간
  let longestRun = null;
  let runStart = 0;
  for (let i = 0; i <= list.length; i++) {
    const breaks = i === list.length || list[i].speaker !== list[runStart].speaker;
    if (!breaks) continue;
    const run = list.slice(runStart, i);
    const speaker = run[0]?.speaker;
    if (speaker && speaker !== "불명") {
      const chars = run.reduce((acc, u) => acc + u.chars, 0);
      if (!longestRun || chars > longestRun.chars) {
        const nextT = i < list.length ? list[i].t : null;
        longestRun = {
          speaker,
          chars,
          utteranceCount: run.length,
          startT: Number.isFinite(run[0].t) ? run[0].t : null,
          endT: Number.isFinite(nextT) ? nextT : (Number.isFinite(run[run.length - 1].t) ? run[run.length - 1].t : null),
          startIndex: runStart,
          endIndex: i - 1
        };
      }
    }
    runStart = i;
  }

  const relationTotal = Object.values(relationChars).reduce((a, b) => a + b, 0);

  return {
    utteranceCount: list.length,
    totalChars,
    speakerChars,
    speakerShare: shareOf(speakerChars, totalChars),
    questionCount: { ...questionCount, total: questionCount.평가자 + questionCount.피평가자 + questionCount.불명 },
    turnCount,
    longestRun,
    relationChars,
    relationShare: shareOf(relationChars, relationTotal),
    relationLabeledChars: relationTotal,
    timeline: buildTimeline(list)
  };
}

/**
 * 타임라인 띠 조각을 만든다. 각 조각은 0–1 사이의 start·width와 relation·speaker를 가진다.
 * 묶음의 80% 이상에 시각이 있고 전체 길이가 0보다 크면 시간 기반, 아니면 글자 수 비례 순서 기반.
 */
export function buildTimeline(utterances = []) {
  const list = utterances.filter((u) => u && u.chars > 0);
  if (list.length === 0) return { basis: "none", segments: [], durationSec: 0 };

  const timedCount = list.filter((u) => Number.isFinite(u.t)).length;
  const firstT = list.find((u) => Number.isFinite(u.t))?.t ?? null;
  const lastT = [...list].reverse().find((u) => Number.isFinite(u.t))?.t ?? null;
  const span = firstT !== null && lastT !== null ? lastT - firstT : 0;

  if (timedCount / list.length >= 0.8 && span > 0) {
    // 시각 없는 묶음은 앞 묶음 시각을 이어받는다. 마지막 묶음 길이는 평균 묶음 길이로 잡는다.
    const filled = [];
    let lastSeen = firstT;
    for (const u of list) {
      if (Number.isFinite(u.t)) lastSeen = Math.max(lastSeen, u.t);
      filled.push({ ...u, t: lastSeen });
    }
    const avgGap = span / Math.max(1, list.length - 1);
    const endT = lastT + avgGap;
    const total = endT - firstT;
    const segments = filled.map((u, idx) => {
      const start = u.t;
      const end = idx + 1 < filled.length ? filled[idx + 1].t : endT;
      return {
        start: (start - firstT) / total,
        width: Math.max(0, end - start) / total,
        startSec: start,
        endSec: end,
        relation: u.relation,
        speaker: u.speaker
      };
    }).filter((s) => s.width > 0);
    return { basis: "time", segments, durationSec: total, startSec: firstT };
  }

  const totalChars = list.reduce((acc, u) => acc + u.chars, 0);
  let acc = 0;
  const segments = list.map((u) => {
    const seg = {
      start: acc / totalChars,
      width: u.chars / totalChars,
      startSec: null,
      endSec: null,
      relation: u.relation,
      speaker: u.speaker
    };
    acc += u.chars;
    return seg;
  });
  return { basis: "order", segments, durationSec: 0, startSec: null };
}

/**
 * 사용자가 적은 체크 항목과 모델 판정을 맞춘다. 순서가 같으면 순서로, 아니면 글자로 찾는다.
 * covered: true(다룸) | false(안 다룸) | null(모델이 판정하지 않음)
 */
export function mergeChecklistCoverage(items = [], coverage = []) {
  const cov = Array.isArray(coverage) ? coverage : [];
  const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  return items.map((item, idx) => {
    const byText = cov.find((c) => norm(c?.item) === norm(item));
    const byIndex = cov[idx] && (!cov[idx].item || norm(cov[idx].item) === norm(item)) ? cov[idx] : null;
    const hit = byText || byIndex;
    const covered = hit ? (hit.covered === true || hit.covered === "true" ? true : hit.covered === false || hit.covered === "false" ? false : null) : null;
    return { item, covered, evidence: hit ? String(hit.evidence || "") : "" };
  });
}

export function formatSeconds(sec) {
  if (!Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const KIND_FROM_OLD_CATEGORY = {
  "질문/검증": "질문",
  구현설명: "설명",
  "칭찬/강점": "설명",
  "개선제안/놓친점": "개선"
};

/** 모델이 준 대화 포인트를 화면용 형태로 맞춘다(옛 category 필드도 kind로 옮김). */
export function normalizeConversationPoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return [];
  return rawPoints
    .filter((p) => p && (p.summary || p.topic))
    .map((p, idx) => {
      const speaker = normalizeSpeaker(p.speaker);
      return {
        id: p.id || `pt_${idx + 1}`,
        speaker: speaker === "불명" ? "공통" : speaker,
        topic: String(p.topic || "").trim(),
        kind: String(p.kind || KIND_FROM_OLD_CATEGORY[p.category] || "").trim(),
        quote: String(p.quote || "").trim().replace(/^[“"']+|[”"']+$/g, ""),
        relation: normalizeRelation(p.relation) || "",
        summary: String(p.summary || "").trim(),
        checked: true
      };
    });
}
