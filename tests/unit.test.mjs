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
  sortAllowedGatewayModels
} from "../src/utils.js";
import { createSilentWavBlob, encodeMonoPcmToWavBuffer } from "../src/audio.js";
import {
  buildRefineFromPointsPrompt,
  buildSegmentExtractPrompt,
  buildSegmentTranscriptPrompt,
  buildSingleShotAudioPrompt,
  buildSingleShotTranscriptPrompt,
  buildSynthesizeFromNotesPrompt,
  getLengthInstruction,
  getToneInstruction
} from "../src/prompts.js";
import {
  buildGatewayFetchRequest,
  buildModelCandidates,
  callGatewayOpenAiEndpoint,
  callLLMWithFallback,
  formatCorsOrNetworkMessage,
  isJsonModeUnsupportedCached,
  resetGatewayFeatureCache,
  runGatewayDiagnostics
} from "../src/api.js";
import {
  clearTranscriptBackup,
  loadTranscriptBackup,
  saveTranscriptBackup
} from "../src/storage.js";
import { createSpeechController } from "../src/speech.js";

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

test("prompts include peer feedback criteria, tone, length, and JSON keys", () => {
  assert.match(getToneInstruction("formal_hapsyo"), /격식체/);
  assert.match(getLengthInstruction("short"), /3–4문장/);

  const audioPrompt = buildSingleShotAudioPrompt({
    memo: "A3-2 테스트",
    tone: "plain_concise",
    length: "long",
    supplementalTranscript: "예외 처리 설명"
  });
  assert.match(audioPrompt, /A3-2 테스트/);
  assert.match(audioPrompt, /Why\(설계 의도/);
  assert.match(audioPrompt, /reviewerToRevieweeDraft/);
  assert.match(audioPrompt, /revieweeToReviewerDraft/);
  assert.match(audioPrompt, /예외 처리 설명/);

  const trPrompt = buildSingleShotTranscriptPrompt({ transcriptText: "테스트 대본" });
  assert.match(trPrompt, /테스트 대본/);

  const segPrompt = buildSegmentExtractPrompt({ segmentIndex: 2, previousRoleHint: "A: 평가자" });
  assert.match(segPrompt, /제2구간/);
  assert.match(segPrompt, /A: 평가자/);

  const segTrPrompt = buildSegmentTranscriptPrompt({ segmentIndex: 3, transcriptText: "구간 내용" });
  assert.match(segTrPrompt, /제3구간/);
  assert.match(segTrPrompt, /구간 내용/);

  const synthPrompt = buildSynthesizeFromNotesPrompt({ notesArray: [{ segmentIndex: 1, points: [] }] });
  assert.match(synthPrompt, /segmentIndex/);

  const refinePrompt = buildRefineFromPointsPrompt({
    activePoints: [{ speaker: "평가자", category: "칭찬/강점", summary: "설계 이유 설명" }],
    inferredRoles: { speakerA: "평가자", speakerB: "피평가자" }
  });
  assert.match(refinePrompt, /설계 이유 설명/);
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
        promptText: "hello",
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
        promptText: "hello again"
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
        promptText: "other model"
      });
      assert.equal(calls.length, 5);
      assert.deepEqual(calls[3].body.response_format, { type: "json_object" });
      assert.equal(calls[4].body.response_format, undefined);

      await callGatewayOpenAiEndpoint({
        baseUrl: "https://gw2.example.com",
        apiKey: "sk-test-key",
        localProxyAvailable: false,
        modelId,
        promptText: "other base"
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
        promptText: "after reset"
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
            promptText: "analyze",
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
        promptText: "analyze",
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
