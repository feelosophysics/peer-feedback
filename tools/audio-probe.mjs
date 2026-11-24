#!/usr/bin/env node
// 게이트웨이가 /v1/chat/completions 의 input_audio(음성 직접 입력)를 모델까지 전달하는지 점검한다.
//
// 판정 근거 세 가지
//   1) HTTP 상태: 음성 요청이 거부(4xx)되는가
//   2) 토큰 차이: 같은 문장을 음성 없이/있이 보냈을 때 prompt_tokens 차이
//      (Gemini는 음성 1초당 약 32토큰으로 센다. 차이가 없으면 음성이 중간에 빠진 것)
//   3) 받아적기: 정해진 문장을 읽은 음성을 모델이 실제로 받아적는가(확인 단어 일치)
//
// 사용법
//   node tools/audio-probe.mjs --base https://게이트웨이주소 [--model gemini-3-flash] [--audio 파일.wav]
//   API 키는 환경변수 GATEWAY_KEY가 없으면 화면에 보이지 않게 입력받는다. 키는 출력하지 않는다.
//   --audio를 생략하면 Windows(SAPI 한국어 음성)·macOS(say)로 확인 문장을 읽은 16kHz WAV를 임시로 만든다.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, extname } from "node:path";

const CHECK_SENTENCE = "동료평가 음성 입력 테스트입니다. 오늘의 확인 단어는 바나나와 기차입니다.";
const CHECK_WORDS = ["바나나", "기차"];
const TONE_SECONDS = 3;

function parseArgs(argv) {
  const args = { model: "gemini-3-flash" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") args.base = next();
    else if (a === "--model") args.model = next();
    else if (a === "--audio") args.audio = next();
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function normalizeBase(raw) {
  const url = new URL(String(raw || "").trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("게이트웨이 주소는 https:// 로 시작해야 합니다.");
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function readHidden(promptText) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(promptText);
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => resolve(buf.trim()));
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value.trim());
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// 확인 문장을 읽은 16kHz 모노 WAV를 만든다. 실패하면 null.
function synthesizeSpeech(outPath) {
  if (platform() === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$ko = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } | Select-Object -First 1",
      "if (-not $ko) { exit 3 }",
      "$s.SelectVoice($ko.VoiceInfo.Name)",
      "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
      `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}', $fmt)`,
      `$s.Speak('${CHECK_SENTENCE}')`,
      "$s.Dispose()"
    ].join("; ");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    return r.status === 0 && existsSync(outPath) ? outPath : null;
  }
  if (platform() === "darwin") {
    const r = spawnSync("say", ["-v", "Yuna", "-o", outPath, "--data-format=LEI16@16000", CHECK_SENTENCE]);
    return r.status === 0 && existsSync(outPath) ? outPath : null;
  }
  return null;
}

// 한국어 음성을 만들 수 없을 때 쓰는 440Hz 신호음 WAV (토큰 차이만 판정 가능)
function toneWav(seconds = TONE_SECONDS, rate = 16000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

function wavSeconds(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  const byteRate = buf.readUInt32LE(28);
  return byteRate ? (buf.length - 44) / byteRate : null;
}

const GATEWAY_HEADERS = ["x-litellm-version", "x-litellm-model-group", "x-litellm-model-id", "x-litellm-call-id"];

async function post(base, key, body) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON이 아닐 수 있다 */ }
  const headers = Object.fromEntries(GATEWAY_HEADERS.filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)]));
  return { status: res.status, json, text, headers };
}

function promptTokens(r) {
  return r.json?.usage?.prompt_tokens ?? null;
}

function answerText(r) {
  const c = r.json?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c.trim() : Array.isArray(c) ? c.map((p) => p.text || "").join("").trim() : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.base) {
    console.log("사용법: node tools/audio-probe.mjs --base https://게이트웨이주소 [--model gemini-3-flash] [--audio 파일.wav]");
    process.exit(args.help ? 0 : 1);
  }
  const base = normalizeBase(args.base);
  const key = process.env.GATEWAY_KEY || (await readHidden("OpenAI 호환 Virtual Key (입력 내용은 보이지 않음): "));
  if (!key) throw new Error("API 키가 비어 있습니다.");

  // 음성 준비
  let audioBuf;
  let audioFormat = "wav";
  let mode;
  let tmpPath = null;
  if (args.audio) {
    audioBuf = readFileSync(args.audio);
    audioFormat = extname(args.audio).toLowerCase() === ".mp3" ? "mp3" : "wav";
    mode = "file";
  } else {
    tmpPath = join(tmpdir(), `peer-feedback-probe-${process.pid}.wav`);
    if (synthesizeSpeech(tmpPath)) {
      audioBuf = readFileSync(tmpPath);
      mode = "speech";
    } else {
      audioBuf = toneWav();
      mode = "tone";
    }
  }
  if (tmpPath) rmSync(tmpPath, { force: true });
  const seconds = audioFormat === "wav" ? wavSeconds(audioBuf) : null;

  const instruction =
    mode === "tone"
      ? "첨부된 오디오에 들리는 소리를 한 문장으로 설명하세요. 오디오가 첨부되지 않았다면 '오디오 없음'이라고만 답하세요."
      : "첨부된 음성을 한국어로 들리는 그대로 받아적으세요. 오디오가 첨부되지 않았다면 '오디오 없음'이라고만 답하세요.";

  console.log(`\n게이트웨이: ${base}`);
  console.log(`모델: ${args.model}`);
  console.log(`음성: ${mode === "speech" ? "확인 문장 TTS" : mode === "tone" ? "440Hz 신호음" : args.audio} · ${audioFormat}${seconds ? ` · ${seconds.toFixed(1)}초` : ""} · ${(audioBuf.length / 1024).toFixed(0)}KB`);

  // 1) 음성 없는 대조 요청
  const control = await post(base, key, {
    model: args.model,
    temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: instruction }] }]
  });
  console.log(`\n[대조] 텍스트만: HTTP ${control.status} · prompt_tokens=${promptTokens(control) ?? "?"}`);
  if (control.status !== 200) {
    console.log(`  오류 본문: ${control.text.slice(0, 400)}`);
    console.log("\n판정: 텍스트 요청부터 실패했습니다. 주소·키·모델 ID를 먼저 확인하세요.");
    process.exit(2);
  }

  // 2) 음성 포함 요청
  const withAudio = await post(base, key, {
    model: args.model,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "input_audio", input_audio: { data: audioBuf.toString("base64"), format: audioFormat } }
        ]
      }
    ]
  });
  console.log(`[실험] 텍스트+음성: HTTP ${withAudio.status} · prompt_tokens=${promptTokens(withAudio) ?? "?"}`);
  if (Object.keys(withAudio.headers).length) console.log(`  게이트웨이 헤더: ${JSON.stringify(withAudio.headers)}`);

  if (withAudio.status !== 200) {
    console.log(`  오류 본문: ${withAudio.text.slice(0, 600)}`);
    console.log("\n판정: 거부됨 — 게이트웨이(또는 모델 설정)가 input_audio를 받지 않습니다. 위 오류 본문을 문의에 첨부하세요.");
    process.exit(3);
  }

  const answer = answerText(withAudio);
  const diff = promptTokens(withAudio) != null && promptTokens(control) != null ? promptTokens(withAudio) - promptTokens(control) : null;
  const expected = seconds ? Math.round(seconds * 32) : null;
  console.log(`  모델 답변: ${answer.slice(0, 300)}`);
  console.log(`  토큰 차이: ${diff ?? "?"}${expected ? ` (Gemini 기준 예상 약 ${expected})` : ""}`);

  const heard = mode !== "tone" && CHECK_WORDS.every((w) => answer.includes(w));
  const noAudioReply = /오디오 없음/.test(answer);
  let verdict;
  if (heard) verdict = "성공 — 음성이 모델까지 전달되어 확인 단어를 정확히 받아적었습니다.";
  else if (noAudioReply || (diff != null && diff < 10)) verdict = "음성 누락 — 요청은 통과했지만 음성이 모델에 도달하지 않은 것으로 보입니다(토큰 증가 없음).";
  else if (diff != null && diff >= 10) verdict = "부분 확인 — 음성 토큰은 늘었습니다. 답변 내용을 직접 확인하세요.";
  else verdict = "판정 보류 — usage 정보가 없어 답변 내용으로만 판단해야 합니다.";
  console.log(`\n판정: ${verdict}`);
}

main().catch((err) => {
  console.error(`\n실행 오류: ${err.message}`);
  process.exit(1);
});
