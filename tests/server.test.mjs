import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function rawHttpRequest({ port, method = "GET", reqPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

test("server.mjs serves static ES modules, blocks path traversal & SSRF, and never logs secrets", async (t) => {
  const startPort = await getFreePort();
  const child = spawn(process.execPath, ["server.mjs", "--no-open", "--port", String(startPort)], {
    cwd: PROJECT_DIR,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutText = "";
  let stderrText = "";
  child.stdout.on("data", (d) => { stdoutText += d.toString("utf8"); });
  child.stderr.on("data", (d) => { stderrText += d.toString("utf8"); });

  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });

  const boundPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server.mjs startup timeout. stdout=${stdoutText} stderr=${stderrText}`));
    }, 5000);

    const checkStdout = () => {
      const match = stdoutText.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number.parseInt(match[1], 10));
      }
    };

    child.stdout.on("data", checkStdout);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server.mjs exited early (${code}). stderr=${stderrText}`));
    });
  });

  await t.test("serves index.html, styles.css, and src/*.js with strict headers", async () => {
    const rootRes = await rawHttpRequest({ port: boundPort, reqPath: "/" });
    assert.equal(rootRes.status, 200);
    assert.equal(rootRes.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(rootRes.headers["cache-control"], "no-store");
    assert.match(rootRes.body, /\.\/styles\.css/);
    assert.match(rootRes.body, /\.\/src\/app\.js/);

    const indexRes = await rawHttpRequest({ port: boundPort, reqPath: "/index.html" });
    assert.equal(indexRes.status, 200);

    const cssRes = await rawHttpRequest({ port: boundPort, reqPath: "/styles.css" });
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(cssRes.headers["cache-control"], "no-store");

    for (const jsPath of ["/src/app.js", "/src/api.js", "/src/ui.js", "/src/audio.js", "/src/utils.js"]) {
      const jsRes = await rawHttpRequest({ port: boundPort, reqPath: jsPath });
      assert.equal(jsRes.status, 200, `${jsPath} should return 200`);
      assert.equal(jsRes.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(jsRes.headers["cache-control"], "no-store");
    }

    const missingJs = await rawHttpRequest({ port: boundPort, reqPath: "/src/not-found.js" });
    assert.equal(missingJs.status, 404);
  });

  await t.test("blocks path traversal and non-allowlisted repository files", async () => {
    const traversalPaths = [
      "/../README.md",
      "/src/..%2fserver.mjs",
      "/src/%2e%2e/server.mjs",
      "/..%5cserver.mjs",
      "/src/nested/app.js"
    ];
    for (const reqPath of traversalPaths) {
      const res = await rawHttpRequest({ port: boundPort, reqPath });
      assert.equal(res.status, 403, `${reqPath} should be blocked with 403`);
    }

    const forbiddenFiles = [
      "/server.mjs",
      "/server.py",
      "/README.md",
      "/tests/unit.test.mjs",
      "/.gitignore",
      "/.git/HEAD"
    ];
    for (const reqPath of forbiddenFiles) {
      const res = await rawHttpRequest({ port: boundPort, reqPath });
      assert.ok(res.status === 403 || res.status === 404, `${reqPath} should not be served (got ${res.status})`);
    }
  });

  await t.test("serves /api/health and enforces SSRF, path, and method policies on /api/proxy", async () => {
    const healthRes = await rawHttpRequest({ port: boundPort, reqPath: "/api/health" });
    assert.equal(healthRes.status, 200);
    const healthJson = JSON.parse(healthRes.body);
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.proxy, true);
    assert.equal(healthJson.runtime, "node");

    const optRes = await rawHttpRequest({
      port: boundPort,
      method: "OPTIONS",
      reqPath: "/api/proxy/v1/models"
    });
    assert.equal(optRes.status, 204);

    const delRes = await rawHttpRequest({
      port: boundPort,
      method: "DELETE",
      reqPath: "/api/proxy/v1/models"
    });
    assert.equal(delRes.status, 405);

    const badPathRes = await rawHttpRequest({
      port: boundPort,
      method: "GET",
      reqPath: "/api/proxy/admin",
      headers: { "X-Proxy-Target-Base": "https://api.example.com" }
    });
    assert.equal(badPathRes.status, 403);

    const ssrfTargets = [
      "http://example.com",
      "https://127.0.0.1",
      "https://localhost",
      "https://169.254.169.254",
      "https://10.0.0.1",
      "https://user:pass@example.com",
      "https://example.com/subpath"
    ];
    for (const target of ssrfTargets) {
      const res = await rawHttpRequest({
        port: boundPort,
        method: "GET",
        reqPath: "/api/proxy/v1/models",
        headers: { "X-Proxy-Target-Base": target }
      });
      assert.equal(res.status, 403, `SSRF target ${target} must return 403`);
    }
  });

  await t.test("never prints Authorization header or body in server logs", async () => {
    const secretHeader = "sk-test-secret-do-not-log";
    const secretBody = JSON.stringify({ secret: "body-token-never-log" });
    const proxyErrRes = await rawHttpRequest({
      port: boundPort,
      method: "POST",
      reqPath: "/api/proxy/v1/chat/completions",
      headers: {
        "X-Proxy-Target-Base": "https://nonexistent.example.invalid",
        "Authorization": `Bearer ${secretHeader}`,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(secretBody))
      },
      body: secretBody
    });
    assert.equal(proxyErrRes.status, 502);

    const combinedLogs = `${stdoutText}\n${stderrText}`;
    assert.equal(combinedLogs.includes(secretHeader), false);
    assert.equal(combinedLogs.includes("body-token-never-log"), false);
  });
});
