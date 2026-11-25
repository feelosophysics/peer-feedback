import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  extractGatewayUrlParam,
  formatBytes,
  formatDuration,
  formatMMSS,
  isGatewayAudioCapableModel,
  isGatewayChatModelAllowed,
  isNetworkOrCorsError,
  isOpenAiProtocolDisallowedError,
  mimeToAudioFormat,
  normalizeAudioMimeType,
  normalizeGatewayBaseUrl,
  parseGeminiVersion,
  parseModelJson,
  sanitizeDraftText,
  sortAllowedGatewayModels
} from "../src/utils.js";
import { createSilentWavBlob, encodeMonoPcmToWavBuffer } from "../src/audio.js";
import {
  buildFullAnalysisPrompt,
  buildRefinePrompt,
  buildSegmentPrompt,
  buildSynthesizePrompt,
  getLengthInstruction,
  getToneInstruction,
  parseChecklistItems
} from "../src/prompts.js";
import {
  buildChatMessages,
  buildGatewayFetchRequest,
  buildModelCandidates,
  callGatewayOpenAiEndpoint,
  callLLMWithFallback,
  formatCorsOrNetworkMessage,
  isJsonModeUnsupportedCached,
  judgeAudioProbe,
  resetGatewayFeatureCache,
  runGatewayDiagnostics,
  sendAudioOrTranscriptAndDispose
} from "../src/api.js";
import {
  clearTranscriptBackup,
  loadTranscriptBackup,
  saveTranscriptBackup
} from "../src/storage.js";
import { createSpeechController } from "../src/speech.js";
import {
  alignTranscriptTimes,
  buildTimeline,
  computeConversationMetrics,
  mergeChecklistCoverage,
  normalizeConversationPoints,
  numberTranscriptLines,
  resolveUtterances,
  splitTranscriptLines,
  swapUtteranceSpeakers
} from "../src/metrics.js";

test("normalizeGatewayBaseUrl strips endpoints and ensures https", () => {
  assert.equal(normalizeGatewayBaseUrl(""), "");
  assert.equal(normalizeGatewayBaseUrl("api.example.com/"), "https://api.example.com");
  assert.equal(normalizeGatewayBaseUrl("https://api.example.com/v1"), "https://api.example.com");
  assert.equal(normalizeGatewayBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com");
  assert.equal(normalizeGatewayBaseUrl("https://api.example.com/v1/models/"), "https://api.example.com");
  assert.equal(normalizeGatewayBaseUrl("http://localhost:8000/v1/messages"), "http://localhost:8000");
});

test("extractGatewayUrlParam reads api/url/base from hash or query", () => {
  assert.equal(extractGatewayUrlParam("#api=api.example.com/v1", ""), "https://api.example.com");
  assert.equal(extractGatewayUrlParam("", "?base=https://gw.example.org/v1/models"), "https://gw.example.org");
  assert.equal(extractGatewayUrlParam("#other=1", "?url=gw2.example.net"), "https://gw2.example.net");
  assert.equal(extractGatewayUrlParam("", ""), "");
});

test("model filtering excludes legacy <= 2.5 and non-chat models", () => {
  assert.deepEqual(parseGeminiVersion("models/gemini-3.1-pro"), { major: 3, minor: 1, id: "gemini-3.1-pro" });
  assert.equal(isGatewayChatModelAllowed("gemini-3-flash"), true);
  assert.equal(isGatewayChatModelAllowed("claude-sonnet-4"), true);
  assert.equal(isGatewayChatModelAllowed("gpt-5.4-mini"), true);

  assert.equal(isGatewayChatModelAllowed("gemini-2.5-flash"), false);
  assert.equal(isGatewayChatModelAllowed("gemini-2.0-pro"), false);
  assert.equal(isGatewayChatModelAllowed("claude-3-5-sonnet"), false);
  assert.equal(isGatewayChatModelAllowed("gpt-4o"), false);
  assert.equal(isGatewayChatModelAllowed("whisper-1"), false);
  assert.equal(isGatewayChatModelAllowed("gpt-image-1"), false);

  assert.equal(isGatewayAudioCapableModel("gemini-3-flash"), true);
  assert.equal(isGatewayAudioCapableModel("claude-sonnet-4"), false);
});

test("sortAllowedGatewayModels filters, deduplicates, and preserves catalog order", () => {
  const sorted = sortAllowedGatewayModels([
    "gpt-4o",
    "custom-alpha",
    "claude-sonnet-4",
    "gemini-2.5-pro",
    "models/gemini-3-flash",
    "gemini-3-flash"
  ]);
  assert.deepEqual(sorted, ["gemini-3-flash", "claude-sonnet-4", "custom-alpha"]);
});

test("parseModelJson handles raw JSON, fenced code blocks, and wrapped prose", () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":2,"b":"ok"}\n```'), { a: 2, b: "ok" });
  assert.deepEqual(parseModelJson('Here is the result:\n{"a":3}\nDone.'), { a: 3 });
  assert.throws(() => parseModelJson("not json at all"));
});

test("error helpers and formatters behave consistently", () => {
  assert.equal(
    isOpenAiProtocolDisallowedError({ status: 403, message: "Key is not allowed for the OpenAI endpoint" }),
    true
  );
  assert.equal(isOpenAiProtocolDisallowedError({ status: 401, message: "unauthorized" }), false);
  assert.equal(isNetworkOrCorsError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkOrCorsError(new Error("CORS blocked")), true);

  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatDuration(3661), "01:01:01");
  assert.equal(formatMMSS(125), "02:05");
  assert.equal(mimeToAudioFormat("audio/mpeg"), "mp3");
  assert.equal(normalizeAudioMimeType("audio/x-m4a; codecs=aac"), "audio/mp4");
  assert.equal(escapeHtml('<script>"x"</script>'), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
});

test("encodeMonoPcmToWavBuffer writes valid 16kHz mono 16-bit RIFF/WAVE PCM", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 2.0, -2.0]);
  const buf = encodeMonoPcmToWavBuffer(samples, 16000);
  const view = new DataView(buf);

  assert.equal(buf.byteLength, 44 + samples.length * 2);
  const ascii = (start, len) => String.fromCharCode(...new Uint8Array(buf, start, len));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // Mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint32(40, true), samples.length * 2);

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(50, true), 0x7fff);
  assert.equal(view.getInt16(52, true), -0x8000);

  const silentBlob = createSilentWavBlob(0.4, 16000);
  assert.equal(silentBlob.type, "audio/wav");
  assert.equal(silentBlob.size, 44 + 6400 * 2);
});

test("tone and length instructions match the new options", () => {
  assert.match(getToneInstruction("warm_casual"), /다정한 대화체/);
  assert.match(getToneInstruction(undefined), /다정한 대화체/); // 기본값
  assert.match(getToneInstruction("polite_haeyo"), /정중한 해요체/);
  assert.match(getToneInstruction("plain_bullets"), /개조식/);
  assert.match(getLengthInstruction("short"), /약 300자/);
  assert.match(getLengthInstruction("medium"), /400–900자/);
  assert.match(getLengthInstruction("long"), /2000자를 넘기지/);
});

test("every prompt builder splits role/rules (system) from conversation material (user)", () => {
  const transcript = "[1] 이 함수는 왜 나눴어요?\n[2] 테스트하기 쉬우려고요";
  const full = buildFullAnalysisPrompt({
    memo: "감성 분석 미션",
    checklistItems: ["예외 처리", "README"],
    numberedTranscript: transcript
  });
  const synth = buildSynthesizePrompt({ memo: "감성 분석 미션", notesArray: [{ segmentIndex: 1, points: [], utterances: [{ from: 1 }] }] });
  const seg = buildSegmentPrompt({ segmentIndex: 2, previousRoleHint: "A: 평가자", numberedTranscript: transcript });
  const refine = buildRefinePrompt({
    activePoints: [{ speaker: "평가자", topic: "함수 분리", kind: "설명", quote: "테스트하기 쉬우려고요", summary: "분리 이유" }],
    inferredRoles: { speakerA: "평가자", speakerB: "피평가자" }
  });

  for (const p of [full, synth, seg, refine]) {
    assert.equal(typeof p.system, "string");
    assert.equal(typeof p.user, "string");
    // 공통 상황 블록은 system에만
    assert.match(p.system, /대면 동료평가 대화/);
    assert.match(p.system, /마크다운은 렌더링되지 않습니다/);
    assert.match(p.system, /2000자/);
    assert.doesNotMatch(p.system, /NDA/);
    assert.doesNotMatch(p.user, /\[상황\]/);
  }

  // 자료는 user에만
  assert.match(full.user, /감성 분석 미션/);
  assert.match(full.user, /테스트하기 쉬우려고요/);
  assert.match(full.user, /- 예외 처리/);
  assert.doesNotMatch(full.system, /감성 분석 미션/);
  assert.doesNotMatch(full.system, /테스트하기 쉬우려고요/);
  assert.match(seg.user, /제2구간/);
  assert.match(seg.user, /A: 평가자/);
  assert.match(refine.user, /함수 분리/);

  // 초안 규칙: 형식적 필수 칸 없음, 가이드라인 중심 아님, 마크다운 금지
  for (const p of [full, synth, refine]) {
    assert.match(p.system, /반드시 채워야 하는 칸은 없습니다/);
    assert.match(p.system, /가이드라인·미션·평가 항목 중심으로 쓰지 않습니다/);
    assert.match(p.system, /\*\*, #/);
    assert.match(p.system, /reviewerToRevieweeDraft/);
    assert.match(p.system, /revieweeToReviewerDraft/);
  }
  // 구간 분석은 초안을 쓰지 않고 말 묶음만 표시
  assert.doesNotMatch(seg.system, /reviewerToRevieweeDraft/);
  assert.match(seg.system, /"utterances"/);

  // 새 포인트 구조와 체크 항목
  assert.match(full.system, /"topic"/);
  assert.match(full.system, /"relation"/);
  assert.match(full.system, /"quote"/);
  assert.match(full.system, /"checklistCoverage"/);
  assert.doesNotMatch(buildFullAnalysisPrompt({ numberedTranscript: transcript }).system, /checklistCoverage/);

  // 합성 단계에는 말 묶음(utterances)을 보내지 않는다
  assert.doesNotMatch(synth.user, /"utterances"/);

  // 음성 경로: 보조 대본이 없으면 받아적기 텍스트로 묶음을 표시
  const audioOnly = buildFullAnalysisPrompt({ source: "audio" });
  assert.match(audioOnly.user, /\[첨부\] 대화 음성/);
  assert.match(audioOnly.system, /"text"/);
});

test("parseChecklistItems keeps one item per line and strips list markers", () => {
  assert.deepEqual(parseChecklistItems(""), []);
  assert.deepEqual(parseChecklistItems("- 예외 처리\n\n2. README 구성\n  * 테스트  "), ["예외 처리", "README 구성", "테스트"]);
});

test("sanitizeDraftText strips markdown the feedback box cannot render", () => {
  const raw = "## 오늘 이야기\n**정말** 좋았어요\n* 첫째\n• 둘째\n- 셋째\n\n\n\n끝  ";
  assert.equal(sanitizeDraftText(raw), "오늘 이야기\n정말 좋았어요\n- 첫째\n- 둘째\n- 셋째\n\n끝");
  assert.equal(sanitizeDraftText("`코드`는 유지"), "`코드`는 유지");
});

test("buildChatMessages sends rules as system and material (+audio) as user", () => {
  assert.deepEqual(buildChatMessages("plain"), [{ role: "user", content: "plain" }]);

  const split = buildChatMessages({ system: "규칙", user: "자료" });
  assert.deepEqual(split, [
    { role: "system", content: "규칙" },
    { role: "user", content: "자료" }
  ]);

  const withAudio = buildChatMessages({ system: "규칙", user: "자료" }, { base64: "AAA=", cleanMime: "audio/wav" });
  assert.equal(withAudio[0].role, "system");
  assert.equal(withAudio[1].role, "user");
  assert.deepEqual(withAudio[1].content[0], { type: "text", text: "자료" });
  assert.deepEqual(withAudio[1].content[1], { type: "input_audio", input_audio: { data: "AAA=", format: "wav" } });
});

test("API request builder and model candidate selection behave cleanly", () => {
  const proxied = buildGatewayFetchRequest({
    path: "/v1/models",
    baseUrl: "https://api.example.com",
    localProxyAvailable: true,
    extraHeaders: { Authorization: "Bearer sk-test" }
  });
  assert.equal(proxied.url, "/api/proxy/v1/models");
  assert.equal(proxied.headers["X-Proxy-Target-Base"], "https://api.example.com");

  const direct = buildGatewayFetchRequest({
    path: "v1/chat/completions",
    baseUrl: "https://api.example.com",
    localProxyAvailable: false
  });
  assert.equal(direct.url, "https://api.example.com/v1/chat/completions");
  assert.equal(direct.headers["X-Proxy-Target-Base"], undefined);

  const audioAuto = buildModelCandidates({
    selectedModel: "auto",
    syncedModels: ["claude-sonnet-4", "gemini-3-flash"],
    requireAudio: true
  });
  assert.ok(audioAuto.includes("gemini-3-flash"));
  assert.equal(audioAuto.includes("claude-sonnet-4"), false);

  assert.throws(
    () => buildModelCandidates({ selectedModel: "claude-sonnet-4", requireAudio: true }),
    (err) => Boolean(err.isTextOnlyModel)
  );
  assert.throws(() => buildModelCandidates({ selectedModel: "__custom__", customModel: "  " }));

  const customFirst = buildModelCandidates({ selectedModel: "__custom__", customModel: "models/gemini-3-pro" });
  assert.equal(customFirst[0], "gemini-3-pro");

  assert.match(formatCorsOrNetworkMessage("https://api.example.com", "Failed to fetch", false), /node server\.mjs/);
  assert.match(formatCorsOrNetworkMessage("https://api.example.com", "Failed to fetch", true), /로컬 프록시/);
});

async function withStubbedGlobals({ fetchImpl, withLocalhostWindow = false }, fn) {
  const prevFetch = globalThis.fetch;
  const hasWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const prevWindow = globalThis.window;
  const hasFileReader = Object.prototype.hasOwnProperty.call(globalThis, "FileReader");
  const prevFileReader = globalThis.FileReader;

  globalThis.fetch = fetchImpl;
  if (withLocalhostWindow) {
    globalThis.window = {
      location: {
        protocol: "http:",
        hostname: "localhost"
      }
    };
    globalThis.FileReader = class MockFileReader {
      readAsDataURL(blob) {
        blob
          .arrayBuffer()
          .then((buf) => {
            const mime = blob.type || "application/octet-stream";
            this.result = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
            this.onload?.();
          })
          .catch((err) => {
            this.error = err;
            this.onerror?.();
          });
      }
    };
  }

  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (withLocalhostWindow) {
      if (hasWindow) globalThis.window = prevWindow;
      else delete globalThis.window;

      if (hasFileReader) globalThis.FileReader = prevFileReader;
      else delete globalThis.FileReader;
    }
    resetGatewayFeatureCache();
  }
}

function makeJsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    },
    async text() {
      return JSON.stringify(obj);
    }
  };
}

test("callGatewayOpenAiEndpoint retries without response_format on 400 unsupported_feature and caches per (baseUrl, modelId)", async () => {
  resetGatewayFeatureCache();
  const calls = [];
  const fallbackEvents = [];

  await withStubbedGlobals(
    {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        if (body.response_format) {
          return makeJsonResponse(400, {
            error: {
              message: "Requested feature is not supported.",
              type: "invalid_request_error",
              code: "unsupported_feature"
            }
          });
        }
        return makeJsonResponse(200, {
          choices: [{ message: { content: '{"ok":true}' } }]
        });
      }
    },
    async () => {
      const baseUrl = "https://gw1.example.com";
      const modelId = "gemini-3-flash";

      const first = await callGatewayOpenAiEndpoint({
        baseUrl,
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId,
        prompt: "hello",
        options: {
          onJsonModeFallback: (id) => fallbackEvents.push(id)
        }
      });
      assert.equal(first, '{"ok":true}');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
      assert.equal(calls[1].body.response_format, undefined);
      assert.deepEqual(fallbackEvents, [modelId]);
      assert.equal(isJsonModeUnsupportedCached(baseUrl, modelId), true);

      // Second call for the same (baseUrl, modelId) skips response_format directly (1 roundtrip)
      const second = await callGatewayOpenAiEndpoint({
        baseUrl,
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId,
        prompt: "hello again"
      });
      assert.equal(second, '{"ok":true}');
      assert.equal(calls.length, 3);
      assert.equal(calls[2].body.response_format, undefined);

      // Different modelId or different baseUrl is not affected by the cached entry
      await callGatewayOpenAiEndpoint({
        baseUrl,
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId: "claude-sonnet-4",
        prompt: "other model"
      });
      assert.equal(calls.length, 5);
      assert.deepEqual(calls[3].body.response_format, { type: "json_object" });
      assert.equal(calls[4].body.response_format, undefined);

      await callGatewayOpenAiEndpoint({
        baseUrl: "https://gw2.example.com",
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId,
        prompt: "other base"
      });
      assert.equal(calls.length, 7);
      assert.deepEqual(calls[5].body.response_format, { type: "json_object" });

      // Resetting cache restores initial response_format attempt
      resetGatewayFeatureCache();
      assert.equal(isJsonModeUnsupportedCached(baseUrl, modelId), false);
      await callGatewayOpenAiEndpoint({
        baseUrl,
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId,
        prompt: "after reset"
      });
      assert.equal(calls.length, 9);
      assert.deepEqual(calls[7].body.response_format, { type: "json_object" });
      assert.equal(calls[8].body.response_format, undefined);
    }
  );
});

test("audio payload handles 400 unsupported_feature according to allowAudioJsonFallback", async () => {
  resetGatewayFeatureCache();

  await withStubbedGlobals(
    {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.response_format) {
          return makeJsonResponse(400, {
            error: {
              message: "Requested feature is not supported.",
              type: "invalid_request_error",
              code: "unsupported_feature"
            }
          });
        }
        return makeJsonResponse(200, {
          choices: [{ message: { content: '{"ok":"audio"}' } }]
        });
      }
    },
    async () => {
      const audioPayload = { base64: "UklGRg==", cleanMime: "audio/wav" };
      let callCount = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        callCount += 1;
        return origFetch(url, init);
      };

      // Without allowAudioJsonFallback, ambiguous 400 rejects audio immediately in 1 request
      await assert.rejects(
        () =>
          callLLMWithFallback({
            baseUrl: "https://gw-audio.example.com",
            apiKey: "sk-test-key",
            localProxyAvailable: false,
            selectedModel: "gemini-3-flash",
            prompt: "analyze",
            audioPayload
          }),
        (err) => Boolean(err.isAudioRejected)
      );
      assert.equal(callCount, 1);

      // With allowAudioJsonFallback: true, retries without response_format and caches
      const res = await callLLMWithFallback({
        baseUrl: "https://gw-audio.example.com",
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        selectedModel: "gemini-3-flash",
        prompt: "analyze",
        audioPayload,
        allowAudioJsonFallback: true
      });
      assert.equal(res.text, '{"ok":"audio"}');
      assert.equal(callCount, 3); // 1 rejected + 2 for fallback retry
      assert.equal(isJsonModeUnsupportedCached("https://gw-audio.example.com", "gemini-3-flash"), true);
    }
  );
});

test("runGatewayDiagnostics verifies text compatibility and caches json_object fallback when audio is unsupported", async () => {
  resetGatewayFeatureCache();
  const baseUrl = "https://gw-diag.example.com";

  await withStubbedGlobals(
    {
      withLocalhostWindow: true,
      fetchImpl: async (url, init) => {
        if (url === "/api/health") {
          return makeJsonResponse(200, { ok: true, proxy: true, runtime: "node" });
        }
        if (url === "/api/proxy/v1/models") {
          return makeJsonResponse(200, {
            data: [{ id: "gemini-3-flash" }, { id: "claude-sonnet-4" }]
          });
        }
        if (url === "/api/proxy/v1/chat/completions") {
          const body = JSON.parse(init.body);
          const msgContent = body.messages?.[0]?.content;
          if (Array.isArray(msgContent)) {
            return makeJsonResponse(400, {
              error: {
                message: "Requested feature is not supported.",
                type: "invalid_request_error",
                code: "unsupported_feature"
              }
            });
          }
          if (body.response_format) {
            return makeJsonResponse(400, {
              error: {
                message: "Requested feature is not supported.",
                type: "invalid_request_error",
                code: "unsupported_feature"
              }
            });
          }
          return makeJsonResponse(200, {
            choices: [{ message: { content: '{"ok":true}' } }]
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
    async () => {
      const diag = await runGatewayDiagnostics({
        baseUrl,
        apiKey: "sk-test-key",
        includeAudioProbe: true
      });
      assert.equal(diag.status, "audio_unsupported");
      assert.equal(diag.textProbeOk, true);
      assert.equal(diag.textProbeModel, "gemini-3-flash");
      assert.equal(diag.jsonModeSupported, false);
      assert.equal(isJsonModeUnsupportedCached(baseUrl, "gemini-3-flash"), true);
    }
  );
});

test("runGatewayDiagnostics reports text_probe_failed when both audio and text probes fail", async () => {
  resetGatewayFeatureCache();
  const baseUrl = "https://gw-fail.example.com";

  await withStubbedGlobals(
    {
      withLocalhostWindow: true,
      fetchImpl: async (url, init) => {
        if (url === "/api/health") {
          return makeJsonResponse(200, { ok: true, proxy: true, runtime: "node" });
        }
        if (url === "/api/proxy/v1/models") {
          return makeJsonResponse(200, { data: [{ id: "gemini-3-flash" }] });
        }
        if (url === "/api/proxy/v1/chat/completions") {
          const body = JSON.parse(init.body);
          if (Array.isArray(body.messages?.[0]?.content)) {
            return makeJsonResponse(400, {
              error: {
                message: "Requested feature is not supported.",
                type: "invalid_request_error",
                code: "unsupported_feature"
              }
            });
          }
          if (body.response_format) {
            return makeJsonResponse(400, {
              error: { code: "unsupported_feature", message: "Unsupported" }
            });
          }
          return makeJsonResponse(500, {
            error: { message: "Upstream model unavailable" }
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
    async () => {
      const diag = await runGatewayDiagnostics({
        baseUrl,
        apiKey: "sk-test-key",
        includeAudioProbe: true
      });
      assert.equal(diag.status, "text_probe_failed");
      assert.equal(diag.textProbeOk, false);
      assert.equal(diag.textProbeModel, "gemini-3-flash");
    }
  );
});

test("runGatewayDiagnostics skips WAV probe by default and returns text_ready", async () => {
  resetGatewayFeatureCache();
  const baseUrl = "https://gw-text-only.example.com";
  let chatCalls = 0;
  let audioCalls = 0;

  await withStubbedGlobals(
    {
      withLocalhostWindow: true,
      fetchImpl: async (url, init) => {
        if (url === "/api/health") {
          return makeJsonResponse(200, { ok: true, proxy: true, runtime: "node" });
        }
        if (url === "/api/proxy/v1/models") {
          return makeJsonResponse(200, {
            data: [{ id: "gemini-3-flash" }, { id: "claude-sonnet-4" }]
          });
        }
        if (url === "/api/proxy/v1/chat/completions") {
          chatCalls += 1;
          const body = JSON.parse(init.body);
          if (Array.isArray(body.messages?.[0]?.content)) {
            audioCalls += 1;
          }
          if (body.response_format) {
            return makeJsonResponse(400, {
              error: {
                message: "Requested feature is not supported.",
                type: "invalid_request_error",
                code: "unsupported_feature"
              }
            });
          }
          return makeJsonResponse(200, {
            choices: [{ message: { content: '{"ok":true}' } }]
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
    async () => {
      const diag = await runGatewayDiagnostics({
        baseUrl,
        apiKey: "sk-test-key"
      });
      assert.equal(diag.status, "text_ready");
      assert.equal(diag.textProbeOk, true);
      assert.equal(diag.textProbeModel, "gemini-3-flash");
      assert.equal(diag.jsonModeSupported, false);
      assert.equal(audioCalls, 0);
      assert.equal(chatCalls, 2);
      assert.equal(isJsonModeUnsupportedCached(baseUrl, "gemini-3-flash"), true);
    }
  );
});

test("runGatewayDiagnostics text probe sends max_tokens: 256 and formats empty HTTP 200 errors without (HTTP ?)", async () => {
  resetGatewayFeatureCache();
  const baseUrl = "https://gw-thinking.example.com";
  const observedMaxTokens = [];

  await withStubbedGlobals(
    {
      withLocalhostWindow: true,
      fetchImpl: async (url, init) => {
        if (url === "/api/health") {
          return makeJsonResponse(200, { ok: true, proxy: true, runtime: "python" });
        }
        if (url === "/api/proxy/v1/models") {
          return makeJsonResponse(200, {
            data: [{ id: "gemini-3-flash" }]
          });
        }
        if (url === "/api/proxy/v1/chat/completions") {
          const body = JSON.parse(init.body);
          observedMaxTokens.push(body.max_tokens);
          return makeJsonResponse(200, {
            choices: [{ message: { content: "" }, finish_reason: "length" }]
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }
    },
    async () => {
      const diag = await runGatewayDiagnostics({
        baseUrl,
        apiKey: "sk-test-key"
      });
      assert.deepEqual(observedMaxTokens, [256]);
      assert.equal(diag.status, "text_probe_failed");
      assert.equal(diag.message, "텍스트 초안 생성 호출 실패");
      assert.doesNotMatch(diag.message, /HTTP \?/);
      assert.match(diag.detail, /응답 텍스트 없음 \(length\)/);
    }
  );
});

test("transcript backup helpers save, load, and clear localStorage cleanly", () => {
  const store = new Map();
  const prevLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  try {
    assert.equal(loadTranscriptBackup(), null);

    const saved = saveTranscriptBackup({
      transcriptText: "  평가자: 설계 의도가 무엇인가요?\n피평가자: 상태 분리를 위함입니다.  ",
      missionMemo: "A3-2 미션",
      totalActiveSeconds: 1840
    });
    assert.ok(saved);
    assert.equal(saved.transcriptText, "평가자: 설계 의도가 무엇인가요?\n피평가자: 상태 분리를 위함입니다.");
    assert.equal(saved.missionMemo, "A3-2 미션");
    assert.equal(saved.totalActiveSeconds, 1840);

    const loaded = loadTranscriptBackup();
    assert.ok(loaded);
    assert.equal(loaded.transcriptText, saved.transcriptText);
    assert.equal(loaded.missionMemo, "A3-2 미션");
    assert.equal(loaded.totalActiveSeconds, 1840);

    // Saving empty text automatically clears the backup
    assert.equal(saveTranscriptBackup({ transcriptText: "   " }), null);
    assert.equal(loadTranscriptBackup(), null);

    saveTranscriptBackup({ transcriptText: "임시 대본", totalActiveSeconds: 60 });
    assert.ok(loadTranscriptBackup());
    clearTranscriptBackup();
    assert.equal(loadTranscriptBackup(), null);
  } finally {
    if (prevLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLocalStorage;
  }
});

test("createSpeechController recovers from InvalidStateError on restart, backs off on network errors after speech, and stops after 5 initial network errors", async () => {
  const prevWindow = globalThis.window;
  let lastInstance = null;
  let startAttempts = 0;
  let throwOnNextStart = false;

  class MockSpeechRecognition {
    constructor() {
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      lastInstance = this;
    }
    start() {
      startAttempts += 1;
      if (throwOnNextStart) {
        throwOnNextStart = false;
        const err = new Error("InvalidStateError");
        err.name = "InvalidStateError";
        throw err;
      }
      this.onstart?.();
    }
    stop() {}
    abort() {}
  }

  globalThis.window = { SpeechRecognition: MockSpeechRecognition };

  try {
    const statuses = [];
    const chunks = [];
    const logs = [];
    const speech = createSpeechController({
      onFinalChunk: (txt) => chunks.push(txt),
      onInterim: () => {},
      onStatusChange: (mode, text) => statuses.push({ mode, text }),
      onLog: (msg, level) => logs.push({ msg, level })
    });

    // 1) Initial 5 consecutive network errors without any prior speech -> stops auto-restart (non-Chrome webview)
    speech.setActive(true);
    speech.start();
    assert.equal(startAttempts, 1);

    for (let i = 1; i <= 5; i++) {
      lastInstance.onerror({ error: "network" });
    }
    assert.equal(statuses[statuses.length - 1].mode, "unsupported");
    assert.match(statuses[statuses.length - 1].text, /일반 Google Chrome 필요/);

    // 2) Active session with recognized speech -> survives >=3 network errors with warn badge and recovers on next result, plus survives InvalidStateError on onend restart
    speech.reset();
    statuses.length = 0;
    startAttempts = 0;

    speech.setActive(true);
    speech.start();
    assert.equal(startAttempts, 1);

    // Simulate recognized speech
    lastInstance.onresult({
      resultIndex: 0,
      results: [{ 0: { transcript: "첫 번째 문장" }, isFinal: true }]
    });
    assert.deepEqual(chunks, ["첫 번째 문장"]);

    // Simulate 1-minute Chrome cutoff where first rec.start() throws InvalidStateError
    throwOnNextStart = true;
    lastInstance.onend();
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(startAttempts >= 3, `Expected retry after InvalidStateError, got startAttempts=${startAttempts}`);

    // Simulate 3 consecutive temporary Wi-Fi network errors during 1-hour session
    lastInstance.onerror({ error: "network" });
    lastInstance.onerror({ error: "network" });
    lastInstance.onerror({ error: "network" });
    assert.equal(statuses[statuses.length - 1].mode, "warn");
    assert.match(statuses[statuses.length - 1].text, /네트워크 재연결 중 \(3회\)/);

    // Speech resumes -> badge immediately recovers to active
    lastInstance.onresult({
      resultIndex: 0,
      results: [{ 0: { transcript: "두 번째 문장" }, isFinal: true }]
    });
    assert.equal(statuses[statuses.length - 1].mode, "active");
    assert.equal(statuses[statuses.length - 1].text, "실시간 한국어 받아적기 중");

    speech.stop(false, "대기");
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test("transcript lines are numbered for the model and aligned to recorded times", () => {
  const lines = splitTranscriptLines("  첫 줄 \n\n둘째 줄\n셋째 줄\n");
  assert.deepEqual(lines, ["첫 줄", "둘째 줄", "셋째 줄"]);
  assert.equal(numberTranscriptLines(lines), "[1] 첫 줄\n[2] 둘째 줄\n[3] 셋째 줄");

  // 사용자가 둘째 줄을 고친 경우: 고친 줄만 시각을 잃는다
  const timed = [
    { t: 3, text: "첫 줄" },
    { t: 9, text: "둘쨰 줄" },
    { t: 15, text: "셋째 줄" }
  ];
  assert.deepEqual(alignTranscriptTimes(lines, timed), [3, null, 15]);
  // 시각 기록이 없으면(붙여넣은 대본) 모두 null
  assert.deepEqual(alignTranscriptTimes(lines, []), [null, null, null]);
  // 구간 대본(뒷부분만)도 앞 기록을 건너뛰고 맞춘다
  assert.deepEqual(alignTranscriptTimes(["셋째 줄"], timed), [15]);
});

test("resolveUtterances turns model line ranges into countable chunks and fills unmarked lines", () => {
  const lines = ["이거 왜 나눴어요", "테스트하려고요 함수 단위로", "아 그렇구나", "점심 뭐 드셨어요"];
  const times = [0, 5, 12, 20];
  const resolved = resolveUtterances(
    [
      { from: 1, to: 1, speaker: "평가자", question: true, relation: "미션 관련" },
      { from: 2, to: 2, speaker: "피평가자", question: false, relation: "미션 관련" },
      { from: 4, to: 9, speaker: "평가자", question: "true", relation: "잡담" } // 범위 밖 줄 번호는 잘라냄
    ],
    lines,
    times
  );
  assert.equal(resolved.length, 4);
  assert.deepEqual(resolved.map((u) => u.speaker), ["평가자", "피평가자", "불명", "평가자"]);
  assert.deepEqual(resolved.map((u) => u.chars), [7, 12, 5, 7]); // 공백 제외 글자 수
  assert.deepEqual(resolved.map((u) => u.t), [0, 5, 12, 20]);
  assert.equal(resolved[3].isQuestion, true);
  assert.equal(resolved[2].relation, null);

  // 대본 줄이 없으면(음성만) 받아적기 text 길이를 쓴다
  const audioOnly = resolveUtterances([{ text: "안녕 하세요", speaker: "reviewer", relation: "off-topic" }], []);
  assert.deepEqual(audioOnly, [{ speaker: "평가자", isQuestion: false, relation: "잡담", chars: 5, t: null, firstLine: null }]);

  // 모델이 아무것도 표시하지 않으면 전부 불명 한 묶음
  const unmarked = resolveUtterances(undefined, ["가", "나"], [null, null]);
  assert.deepEqual(unmarked.map((u) => [u.speaker, u.chars]), [["불명", 2]]);
});

test("computeConversationMetrics counts share, questions, turns, longest run, and relation share", () => {
  const u = (speaker, chars, extra = {}) => ({ speaker, chars, isQuestion: false, relation: "미션 관련", t: null, ...extra });
  const metrics = computeConversationMetrics([
    u("평가자", 20, { isQuestion: true, t: 0 }),
    u("피평가자", 100, { t: 10 }),
    u("피평가자", 80, { t: 40, relation: "미션 밖 탐구" }),
    u("불명", 10, { t: 60, relation: null }),
    u("평가자", 30, { isQuestion: true, t: 70, relation: "잡담" }),
    u("피평가자", 60, { t: 80 })
  ]);

  assert.equal(metrics.totalChars, 300);
  assert.deepEqual(metrics.speakerChars, { 평가자: 50, 피평가자: 240, 불명: 10 });
  assert.equal(metrics.speakerShare.피평가자, 0.8);
  assert.deepEqual(metrics.questionCount, { 평가자: 2, 피평가자: 0, 불명: 0, total: 2 });
  // 평→피, (불명 건너뜀) 피→평, 평→피 = 3번
  assert.equal(metrics.turnCount, 3);
  assert.equal(metrics.longestRun.speaker, "피평가자");
  assert.equal(metrics.longestRun.chars, 180);
  assert.equal(metrics.longestRun.utteranceCount, 2);
  assert.equal(metrics.longestRun.startT, 10);
  assert.equal(metrics.longestRun.endT, 60); // 다음 묶음이 시작한 시각
  // 대화 성격은 표시 있는 글자(290자)만 기준
  assert.equal(metrics.relationLabeledChars, 290);
  assert.equal(metrics.relationChars["미션 관련"], 180);
  assert.ok(Math.abs(metrics.relationShare.잡담 - 30 / 290) < 1e-9);
  assert.equal(metrics.timeline.basis, "time");

  const empty = computeConversationMetrics([]);
  assert.equal(empty.utteranceCount, 0);
  assert.equal(empty.longestRun, null);
  assert.equal(empty.timeline.basis, "none");
});

test("buildTimeline uses seconds when most chunks are timed, otherwise falls back to order", () => {
  const timed = buildTimeline([
    { speaker: "평가자", chars: 10, relation: "미션 관련", t: 0 },
    { speaker: "피평가자", chars: 10, relation: "잡담", t: 30 },
    { speaker: "평가자", chars: 10, relation: "미션 관련", t: 60 }
  ]);
  assert.equal(timed.basis, "time");
  assert.equal(timed.durationSec, 90); // 마지막 묶음은 평균 간격(30초)만큼
  assert.deepEqual(timed.segments.map((s) => [s.start, s.width]), [[0, 1 / 3], [1 / 3, 1 / 3], [2 / 3, 1 / 3]]);
  assert.equal(timed.segments[1].relation, "잡담");

  const ordered = buildTimeline([
    { speaker: "평가자", chars: 30, relation: "미션 관련", t: null },
    { speaker: "피평가자", chars: 10, relation: "잡담", t: null }
  ]);
  assert.equal(ordered.basis, "order");
  assert.deepEqual(ordered.segments.map((s) => [s.start, s.width]), [[0, 0.75], [0.75, 0.25]]);
});

test("swapUtteranceSpeakers and normalizeConversationPoints", () => {
  assert.deepEqual(
    swapUtteranceSpeakers([{ speaker: "평가자" }, { speaker: "피평가자" }, { speaker: "불명" }]).map((x) => x.speaker),
    ["피평가자", "평가자", "불명"]
  );

  const points = normalizeConversationPoints([
    { speaker: "피평가자", topic: "상태 분리", kind: "설명", quote: "“화면과 데이터는 따로 살아요”", relation: "미션 관련", summary: "상태를 나눈 이유" },
    { speaker: "공통", category: "개선제안/놓친점", summary: "옛 형식 포인트" },
    { speaker: "평가자", summary: "" } // 내용 없으면 버림
  ]);
  assert.equal(points.length, 2);
  assert.equal(points[0].quote, "화면과 데이터는 따로 살아요");
  assert.equal(points[0].relation, "미션 관련");
  assert.equal(points[1].kind, "개선");
  assert.equal(points[1].speaker, "공통");
  assert.ok(points.every((p) => p.checked === true));
});

test("mergeChecklistCoverage matches by text or order and leaves unknowns as null", () => {
  const merged = mergeChecklistCoverage(
    ["예외 처리 이유", "README 구성", "테스트"],
    [
      { item: "README  구성", covered: true, evidence: "실행 명령 위치" },
      { item: "예외 처리 이유", covered: "false", evidence: "" }
    ]
  );
  assert.deepEqual(merged, [
    { item: "예외 처리 이유", covered: false, evidence: "" },
    { item: "README 구성", covered: true, evidence: "실행 명령 위치" },
    { item: "테스트", covered: null, evidence: "" }
  ]);
  assert.deepEqual(mergeChecklistCoverage([], [{ item: "x", covered: true }]), []);
});

test("transcript backup keeps timed lines and checklist, and still reads old backups", () => {
  const store = new Map();
  const prevLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  try {
    saveTranscriptBackup({
      transcriptText: "첫 줄\n둘째 줄",
      timedLines: [{ t: 1.23, text: "첫 줄" }, { t: "x", text: "버려짐" }, { t: 4, text: "둘째 줄" }],
      checklistText: "예외 처리"
    });
    const loaded = loadTranscriptBackup();
    assert.deepEqual(loaded.timedLines, [{ t: 1.2, text: "첫 줄" }, { t: 4, text: "둘째 줄" }]);
    assert.equal(loaded.checklistText, "예외 처리");

    // 이전 형식(시각·체크 항목 없음)
    store.set("peer_feedback_transcript_backup_v1", JSON.stringify({ transcriptText: "옛 대본", totalActiveSeconds: 30 }));
    const old = loadTranscriptBackup();
    assert.equal(old.transcriptText, "옛 대본");
    assert.deepEqual(old.timedLines, []);
    assert.equal(old.checklistText, "");
  } finally {
    clearTranscriptBackup();
    if (prevLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLocalStorage;
  }
});

test("createSpeechController reports elapsed seconds with each finalized result", () => {
  const prevWindow = globalThis.window;
  let instance = null;
  class MockSpeechRecognition {
    constructor() { instance = this; }
    start() { this.onstart?.(); }
    stop() {}
    abort() {}
  }
  globalThis.window = { SpeechRecognition: MockSpeechRecognition };
  try {
    let elapsed = 42;
    const finals = [];
    const speech = createSpeechController({
      getElapsedSeconds: () => elapsed,
      onFinalChunk: (txt, meta) => finals.push({ txt, t: meta.elapsedSec })
    });
    speech.setActive(true);
    speech.start();
    instance.onresult({ resultIndex: 0, results: [{ 0: { transcript: "하나" }, isFinal: true }] });
    elapsed = 50;
    instance.onresult({ resultIndex: 0, results: [{ 0: { transcript: "둘 중간" }, isFinal: false }] });
    speech.stop(true); // 남은 중간 결과도 시각과 함께 확정
    assert.deepEqual(finals, [{ txt: "하나", t: 42 }, { txt: "둘 중간", t: 50 }]);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test("judgeAudioProbe compares prompt_tokens with and without audio", () => {
  assert.equal(judgeAudioProbe({ controlTokens: 40, audioTokens: 104, audioSeconds: 2 }).verdict, "delivered");
  const dropped = judgeAudioProbe({ controlTokens: 40, audioTokens: 41, audioSeconds: 2 });
  assert.equal(dropped.verdict, "dropped");
  assert.equal(dropped.diff, 1);
  assert.equal(dropped.expected, 64);
  assert.equal(judgeAudioProbe({ controlTokens: 40, audioTokens: undefined }).verdict, "inconclusive");
  assert.equal(judgeAudioProbe({ controlTokens: 0, audioTokens: 0 }).verdict, "inconclusive");
});

function makeAudioProbeFetch({ controlUsage, audioUsage }) {
  const seen = { control: 0, audio: 0, text: 0 };
  const fetchImpl = async (url, init) => {
    if (url === "/api/health") return makeJsonResponse(200, { ok: true, proxy: true, runtime: "node" });
    if (url === "/api/proxy/v1/models") return makeJsonResponse(200, { data: [{ id: "gemini-3-flash" }] });
    if (url === "/api/proxy/v1/chat/completions") {
      const body = JSON.parse(init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      if (Array.isArray(userMsg.content)) {
        seen.audio += 1;
        assert.equal(userMsg.content[1].type, "input_audio");
        // 2초 16kHz 16bit WAV → base64 약 85KB (무음 0.4초 프로브보다 큼)
        assert.ok(userMsg.content[1].input_audio.data.length > 80000);
        return makeJsonResponse(200, { choices: [{ message: { content: "삐" } }], ...(audioUsage ? { usage: audioUsage } : {}) });
      }
      if (body.response_format || /JSON/.test(userMsg.content)) {
        seen.text += 1;
        return makeJsonResponse(200, { choices: [{ message: { content: '{"ok":true}' } }] });
      }
      seen.control += 1;
      assert.equal(body.temperature, 0);
      return makeJsonResponse(200, { choices: [{ message: { content: "없음" } }], ...(controlUsage ? { usage: controlUsage } : {}) });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  return { fetchImpl, seen };
}

test("runGatewayDiagnostics marks audio supported only when audio adds prompt tokens", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, seen } = makeAudioProbeFetch({
    controlUsage: { prompt_tokens: 38 },
    audioUsage: { prompt_tokens: 102 }
  });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const diag = await runGatewayDiagnostics({ baseUrl: "https://gw-probe1.example.com", apiKey: "sk-test-key", includeAudioProbe: true });
    assert.equal(diag.status, "audio_supported");
    assert.equal(diag.audioProbe.diff, 64);
    assert.match(diag.detail, /38토큰 → 음성 2초 포함 102토큰/);
    assert.deepEqual(seen, { control: 1, audio: 1, text: 0 });
  });
});

test("runGatewayDiagnostics reports silently dropped audio as unsupported (HTTP 200 but no token increase)", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, seen } = makeAudioProbeFetch({
    controlUsage: { prompt_tokens: 38 },
    audioUsage: { prompt_tokens: 39 }
  });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const diag = await runGatewayDiagnostics({ baseUrl: "https://gw-probe2.example.com", apiKey: "sk-test-key", includeAudioProbe: true });
    assert.equal(diag.status, "audio_unsupported");
    assert.equal(diag.audioDropped, true);
    assert.match(diag.message, /전달되지 않음/);
    assert.equal(diag.textProbeOk, true);
    assert.deepEqual(seen, { control: 1, audio: 1, text: 1 });
  });
});

test("runGatewayDiagnostics withholds a verdict when the gateway returns no usage", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl } = makeAudioProbeFetch({ controlUsage: null, audioUsage: null });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const diag = await runGatewayDiagnostics({ baseUrl: "https://gw-probe3.example.com", apiKey: "sk-test-key", includeAudioProbe: true });
    assert.equal(diag.status, "audio_inconclusive");
    assert.match(diag.message, /판정 보류/);
    assert.match(diag.nextAction, /tools\/audio-probe\.mjs/);
  });
});

// 녹음 전송 경로: 음성 지원 여부를 모를 때 실제 녹음보다 먼저 토큰 비교 점검을 한다.
function makeSendFetch({ probeAudioTokens, probeControlTokens = 38, withUsage = true }) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const userMsg = body.messages.find((m) => m.role === "user");
    const hasAudio = Array.isArray(userMsg.content);
    const text = hasAudio ? userMsg.content[0].text : userMsg.content;
    const isProbe = /첨부된 오디오에 들리는 소리/.test(text);
    log.push(`${isProbe ? "probe" : "main"}:${hasAudio ? "audio" : "text"}`);
    const usage = withUsage ? { usage: { prompt_tokens: isProbe ? (hasAudio ? probeAudioTokens : probeControlTokens) : 900 } } : {};
    return makeJsonResponse(200, { choices: [{ message: { content: isProbe ? "없음" : `{"from":"${hasAudio ? "audio" : "transcript"}"}` } }], ...usage });
  };
  return { fetchImpl, log };
}

function sendArgs(overrides = {}) {
  const detected = [];
  const logs = [];
  return {
    detected,
    logs,
    args: {
      blob: new Blob([new Uint8Array(4096)], { type: "audio/wav" }),
      rawMime: "audio/wav",
      promptAudio: { system: "규칙", user: "음성 분석 자료" },
      promptTranscript: { system: "규칙", user: "대본 분석 자료" },
      label: "single_1",
      transcriptText: "[1] 대본 한 줄",
      uploadMode: "hybrid_auto",
      gatewayAudioSupport: "unknown",
      keyProtocolScope: "openai_ok",
      selectedModel: "gemini-3-flash",
      customModel: "",
      syncedModels: [],
      baseUrl: "https://gw-send.example.com",
      apiKey: "sk-test-key",
      localProxyAvailable: false,
      onLog: (msg, level) => logs.push({ msg, level }),
      onAudioSupportDetected: (s) => detected.push(s),
      ...overrides
    }
  };
}

test("recording path falls back to the transcript when the gateway silently drops audio", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, log } = makeSendFetch({ probeAudioTokens: 39 });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const { args, detected } = sendArgs();
    const res = await sendAudioOrTranscriptAndDispose(args);
    assert.equal(res.text, '{"from":"transcript"}');
    assert.deepEqual(detected, ["unsupported"]);
    assert.deepEqual(log, ["probe:text", "probe:audio", "main:text"]); // 실제 녹음은 보내지 않음
  });
});

test("recording path marks audio supported only after the token check passes", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, log } = makeSendFetch({ probeAudioTokens: 102 });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const { args, detected } = sendArgs();
    const res = await sendAudioOrTranscriptAndDispose(args);
    assert.equal(res.text, '{"from":"audio"}');
    assert.deepEqual(detected, ["supported"]);
    assert.deepEqual(log, ["probe:text", "probe:audio", "main:audio"]);

    // 이미 확인된 뒤(supported)에는 다시 점검하지 않는다
    log.length = 0;
    const again = sendArgs({ gatewayAudioSupport: "supported" });
    await sendAudioOrTranscriptAndDispose(again.args);
    assert.deepEqual(log, ["main:audio"]);
  });
});

test("audio-only mode refuses to analyze when audio is dropped and there is no transcript", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, log } = makeSendFetch({ probeAudioTokens: 38 });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const { args, detected } = sendArgs({ uploadMode: "audio_only_force", transcriptText: "" });
    await assert.rejects(() => sendAudioOrTranscriptAndDispose(args), /모델까지 전달하지 않아/);
    assert.deepEqual(detected, ["unsupported"]);
    assert.deepEqual(log, ["probe:text", "probe:audio"]);
  });
});

test("without usage info the recording is still sent after one check, but never marked supported", async () => {
  resetGatewayFeatureCache();
  const { fetchImpl, log } = makeSendFetch({ withUsage: false });
  await withStubbedGlobals({ withLocalhostWindow: true, fetchImpl }, async () => {
    const first = sendArgs();
    const res = await sendAudioOrTranscriptAndDispose(first.args);
    assert.equal(res.text, '{"from":"audio"}');
    assert.deepEqual(first.detected, []);
    assert.ok(first.logs.some((l) => /확인하지 못했습니다/.test(l.msg)));

    // 같은 게이트웨이·모델은 판정 보류를 기억해 구간마다 다시 점검하지 않는다
    log.length = 0;
    const second = sendArgs();
    await sendAudioOrTranscriptAndDispose(second.args);
    assert.deepEqual(log, ["main:audio"]);
  });
});
