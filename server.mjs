#!/usr/bin/env node
/**
 * Peer Feedback Local Runner & CORS Proxy (Node.js 18+ built-in modules only)
 * Zero external dependencies. Binds strictly to 127.0.0.1.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_PORT = 8765;
const PORT_TRY_COUNT = 11; // 8765..8775
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB
const FORWARD_HEADER_ALLOWLIST = [
  "authorization",
  "content-type",
  "accept"
];
const SAFE_SRC_JS_RE = /^[A-Za-z0-9_-]+\.js$/;
const PATH_TRAVERSAL_RE = /\.\.|\\|%2e|%2f|%5c/i;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_HTML_PATH = path.join(__dirname, "index.html");
const STYLES_CSS_PATH = path.join(__dirname, "styles.css");
const SRC_DIR_PATH = path.join(__dirname, "src");

function parseCliArgs(argv) {
  let port = DEFAULT_PORT;
  let openBrowser = true;
  const restrictedHosts = new Set();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") {
      openBrowser = false;
    } else if (arg === "--port" && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`[오류] 유효하지 않은 포트 번호입니다: ${argv[i]}`);
        process.exit(1);
      }
      port = parsed;
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`[오류] 유효하지 않은 포트 번호입니다: ${raw}`);
        process.exit(1);
      }
      port = parsed;
    } else if (arg === "--allow-host" && i + 1 < argv.length) {
      for (const h of argv[++i].split(",")) {
        const clean = h.trim().toLowerCase();
        if (clean) restrictedHosts.add(clean);
      }
    } else if (arg.startsWith("--allow-host=")) {
      const raw = arg.slice("--allow-host=".length);
      for (const h of raw.split(",")) {
        const clean = h.trim().toLowerCase();
        if (clean) restrictedHosts.add(clean);
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "사용법: node server.mjs [--port 8765] [--no-open] [--allow-host host1,host2]"
      );
      process.exit(0);
    }
  }

  return { port, openBrowser, restrictedHosts };
}

function sendJson(res, statusCode, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function isAllowedUpstreamPath(pathname) {
  return pathname.startsWith("/v1/") || pathname.startsWith("/api/v1/");
}

function isBlockedSsrfHost(rawHostname) {
  const host = (rawHostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".")) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return true;
  if (net.isIP(host) !== 0) return true;
  if (!host.includes(".")) return true;
  return false;
}

function resolveTargetBase(rawHeader, restrictedHosts) {
  const raw = typeof rawHeader === "string" ? rawHeader.trim() : "";
  if (!raw) {
    return { ok: false, status: 400, message: "X-Proxy-Target-Base 헤더가 필요합니다." };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, status: 400, message: "유효한 X-Proxy-Target-Base URL이 아닙니다." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, status: 403, message: "HTTPS 대상 호스트만 프록시할 수 있습니다." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 403, message: "인증 정보가 포함된 URL은 허용되지 않습니다." };
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return { ok: false, status: 403, message: "기본 도메인 루트 URL만 허용됩니다." };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (restrictedHosts.size > 0) {
    if (!restrictedHosts.has(host)) {
      return { ok: false, status: 403, message: "허용되지 않은 프록시 대상 호스트입니다." };
    }
  } else if (isBlockedSsrfHost(host)) {
    return { ok: false, status: 403, message: "사설망·로컬·IP 기반 프록시 대상은 보안상 차단됩니다." };
  }

  return { ok: true, origin: parsed.origin };
}

function readRequestBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const rawLen = req.headers["content-length"];
    if (rawLen !== undefined) {
      const declared = Number.parseInt(String(rawLen), 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        const err = new Error("Payload Too Large");
        err.statusCode = 413;
        req.resume();
        reject(err);
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error("Payload Too Large");
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function handleProxyRequest(req, res, reqUrl, restrictedHosts) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Allow": "GET, POST, OPTIONS",
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, {
      error: { message: "허용되지 않은 HTTP 메서드입니다. (GET, POST만 지원)" }
    });
    return;
  }

  const upstreamPath = reqUrl.pathname.slice("/api/proxy".length);
  if (!isAllowedUpstreamPath(upstreamPath)) {
    sendJson(res, 403, {
      error: { message: "허용되지 않은 프록시 경로입니다. (/v1/ 또는 /api/v1/만 허용)" }
    });
    return;
  }

  const targetResult = resolveTargetBase(req.headers["x-proxy-target-base"], restrictedHosts);
  if (!targetResult.ok) {
    sendJson(res, targetResult.status, {
      error: { message: targetResult.message }
    });
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(`${upstreamPath}${reqUrl.search}`, targetResult.origin);
  } catch {
    sendJson(res, 400, { error: { message: "잘못된 요청 경로입니다." } });
    return;
  }

  if (
    upstreamUrl.origin !== targetResult.origin ||
    !isAllowedUpstreamPath(upstreamUrl.pathname)
  ) {
    sendJson(res, 403, {
      error: { message: "허용되지 않은 프록시 경로입니다." }
    });
    return;
  }

  let bodyBuf = null;
  if (req.method === "POST") {
    try {
      bodyBuf = await readRequestBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err && err.statusCode === 413) {
        sendJson(res, 413, {
          error: { message: "요청 크기가 25MB 제한을 초과했습니다." }
        });
        return;
      }
      sendJson(res, 400, {
        error: { message: "요청 본문을 읽는 중 오류가 발생했습니다." }
      });
      return;
    }
  }

  const forwardHeaders = {};
  for (const name of FORWARD_HEADER_ALLOWLIST) {
    const val = req.headers[name];
    if (typeof val === "string" && val.length > 0) {
      forwardHeaders[name] = val;
    }
  }

  const startedAt = Date.now();
  try {
    const fetchOpts = {
      method: req.method,
      headers: forwardHeaders
    };
    if (req.method === "POST" && bodyBuf !== null) {
      fetchOpts.body = bodyBuf;
    }

    const upstreamRes = await fetch(upstreamUrl.toString(), fetchOpts);
    const resBuf = Buffer.from(await upstreamRes.arrayBuffer());
    const elapsedMs = Date.now() - startedAt;

    console.log(`[proxy] ${req.method} ${upstreamUrl.pathname} -> ${upstreamRes.status} (${elapsedMs}ms)`);

    const contentType = upstreamRes.headers.get("content-type") || "application/json; charset=utf-8";
    res.writeHead(upstreamRes.status, {
      "Content-Type": contentType,
      "Content-Length": String(resBuf.length),
      "Cache-Control": "no-store"
    });
    res.end(resBuf);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[proxy] ${req.method} ${upstreamUrl.pathname} -> 502 (${elapsedMs}ms)`);
    sendJson(res, 502, {
      error: {
        message: `게이트웨이 업스트림 연결 실패: ${err && err.message ? err.message : "unknown error"}`
      }
    });
  }
}

function sendStaticBytes(res, contentType, data) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(data.length),
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function hasPathTraversal(rawPath) {
  return PATH_TRAVERSAL_RE.test(rawPath || "");
}

async function resolveAllowedStaticFile(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return { ok: true, filePath: INDEX_HTML_PATH, contentType: "text/html; charset=utf-8", label: "index.html" };
  }
  if (pathname === "/styles.css") {
    return { ok: true, filePath: STYLES_CSS_PATH, contentType: "text/css; charset=utf-8", label: "styles.css" };
  }
  if (pathname.startsWith("/src/")) {
    const filename = pathname.slice("/src/".length);
    if (!SAFE_SRC_JS_RE.test(filename)) {
      return { ok: false, status: 403, message: "허용되지 않은 파일 경로입니다." };
    }
    const candidatePath = path.resolve(SRC_DIR_PATH, filename);
    const resolvedBase = path.resolve(SRC_DIR_PATH) + path.sep;
    if (!candidatePath.startsWith(resolvedBase)) {
      return { ok: false, status: 403, message: "허용되지 않은 파일 경로입니다." };
    }
    try {
      const [realBase, realCandidate] = await Promise.all([
        fs.realpath(SRC_DIR_PATH),
        fs.realpath(candidatePath)
      ]);
      if (!realCandidate.startsWith(realBase + path.sep)) {
        return { ok: false, status: 403, message: "허용되지 않은 파일 경로입니다." };
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return { ok: false, status: 404, message: "찾을 수 없는 파일입니다." };
      }
      return { ok: false, status: 500, message: "파일 경로를 확인할 수 없습니다." };
    }
    return { ok: true, filePath: candidatePath, contentType: "text/javascript; charset=utf-8", label: `src/${filename}` };
  }
  return null;
}

function createAppServer(restrictedHosts = new Set()) {
  const restrictedList = Array.from(restrictedHosts);

  return http.createServer(async (req, res) => {
    const rawTarget = req.url || "/";
    const rawPathPart = rawTarget.split("?")[0].split("#")[0];
    if (hasPathTraversal(rawPathPart)) {
      sendJson(res, 403, { error: { message: "허용되지 않은 파일 경로입니다." } });
      return;
    }

    let reqUrl;
    try {
      reqUrl = new URL(rawTarget, "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: { message: "잘못된 요청 URL입니다." } });
      return;
    }

    const pathname = reqUrl.pathname;

    if (req.method === "GET") {
      const staticTarget = await resolveAllowedStaticFile(pathname);
      if (staticTarget) {
        if (!staticTarget.ok) {
          sendJson(res, staticTarget.status, { error: { message: staticTarget.message } });
          return;
        }
        try {
          const data = await fs.readFile(staticTarget.filePath);
          sendStaticBytes(res, staticTarget.contentType, data);
        } catch (err) {
          if (err && err.code === "ENOENT") {
            sendJson(res, 404, { error: { message: `${staticTarget.label} 파일을 찾을 수 없습니다.` } });
          } else {
            sendJson(res, 500, { error: { message: `${staticTarget.label} 파일을 읽을 수 없습니다.` } });
          }
        }
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        proxy: true,
        runtime: "node",
        restrictedHosts: restrictedList
      });
      return;
    }

    if (pathname === "/api/proxy" || pathname.startsWith("/api/proxy/")) {
      await handleProxyRequest(req, res, reqUrl, restrictedHosts);
      return;
    }

    if (
      pathname.startsWith("/.") ||
      pathname === "/server.mjs" ||
      pathname === "/server.py" ||
      pathname === "/README.md" ||
      pathname.startsWith("/tests/")
    ) {
      sendJson(res, 403, { error: { message: "허용되지 않은 경로입니다." } });
      return;
    }

    sendJson(res, 404, { error: { message: "찾을 수 없는 경로입니다." } });
  });
}

function listenWithFallback(server, startPort) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryNext() {
      const candidatePort = startPort + attempt;
      if (candidatePort > 65535 || attempt >= PORT_TRY_COUNT) {
        reject(new Error(`사용 가능한 로컬 포트를 찾지 못했습니다 (${startPort}–${Math.min(65535, startPort + PORT_TRY_COUNT - 1)}).`));
        return;
      }

      const onError = (err) => {
        server.removeListener("listening", onListening);
        if (err && err.code === "EADDRINUSE") {
          attempt += 1;
          tryNext();
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        server.removeListener("error", onError);
        resolve(candidatePort);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidatePort, "127.0.0.1");
    }

    tryNext();
  });
}

function openBrowserUrl(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Ignore browser auto-launch errors; user can open URL manually.
  }
}

async function main() {
  const { port, openBrowser, restrictedHosts } = parseCliArgs(process.argv.slice(2));
  const server = createAppServer(restrictedHosts);

  let boundPort;
  try {
    boundPort = await listenWithFallback(server, port);
  } catch (err) {
    console.error(`[오류] 서버 시작 실패: ${err.message}`);
    process.exit(1);
  }

  const localUrl = `http://localhost:${boundPort}`;
  const targetDesc = restrictedHosts.size > 0
    ? Array.from(restrictedHosts).join(", ")
    : "공개 HTTPS 게이트웨이 (SSRF 차단 적용 · --allow-host로 특정 호스트만 제한 가능)";
  console.log("============================================================");
  console.log("  동료평가 상호 피드백 초안 생성기 — 로컬 실행기 (Node.js)");
  console.log("============================================================");
  console.log(`  접속 주소 : ${localUrl}`);
  console.log(`  허용 대상 : ${targetDesc}`);
  console.log("  종료 방법 : Ctrl+C");
  console.log("  권장 팁   : 실시간 한국어 대본(Web Speech API)은 일반 Google Chrome에서 열면 가장 잘 동작합니다.");
  console.log("============================================================");

  if (openBrowser) {
    openBrowserUrl(localUrl);
  }
}

export {
  DEFAULT_PORT,
  PORT_TRY_COUNT,
  MAX_BODY_BYTES,
  FORWARD_HEADER_ALLOWLIST,
  isAllowedUpstreamPath,
  isBlockedSsrfHost,
  resolveTargetBase,
  hasPathTraversal,
  resolveAllowedStaticFile,
  createAppServer,
  listenWithFallback
};

function isDirectEntryRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectEntryRun()) {
  main();
}
