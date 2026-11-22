#!/usr/bin/env python3
"""
Peer Feedback Local Runner & CORS Proxy (Python 3 standard library only)
Zero external dependencies. Binds strictly to 127.0.0.1.
"""

import argparse
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

DEFAULT_PORT = 8765
PORT_TRY_COUNT = 11  # 8765..8775
MAX_BODY_BYTES = 25 * 1024 * 1024  # 25 MB
FORWARD_HEADER_ALLOWLIST = (
    "authorization",
    "content-type",
    "accept",
)
NUMERIC_IP_LABEL_RE = re.compile(r"^(?:0x[0-9a-f]+|0[0-7]*|\d+)$", re.IGNORECASE)
SAFE_SRC_JS_RE = re.compile(r"^[A-Za-z0-9_-]+\.js$")
PATH_TRAVERSAL_RE = re.compile(r"\.\.|\\|%2e|%2f|%5c", re.IGNORECASE)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML_PATH = os.path.join(BASE_DIR, "index.html")
STYLES_CSS_PATH = os.path.join(BASE_DIR, "styles.css")
SRC_DIR = os.path.realpath(os.path.join(BASE_DIR, "src"))
SSL_CONTEXT = ssl.create_default_context()


def is_allowed_upstream_path(pathname: str) -> bool:
    return pathname.startswith("/v1/") or pathname.startswith("/api/v1/")


def is_blocked_ssrf_host(raw_hostname: str) -> bool:
    host = (raw_hostname or "").lower().strip("[]")
    if not host or host.endswith("."):
        return True
    if host == "localhost" or host.endswith(".localhost"):
        return True
    if host.endswith(".local") or host.endswith(".internal"):
        return True
    if ":" in host:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if "." not in host:
        return True
    labels = host.split(".")
    if all(NUMERIC_IP_LABEL_RE.match(lbl) for lbl in labels):
        return True
    return False


def resolve_target_base(raw_header: str, restricted_hosts: set[str]) -> tuple[bool, int, str]:
    raw = (raw_header or "").strip()
    if not raw:
        return False, 400, "X-Proxy-Target-Base 헤더가 필요합니다."

    try:
        parsed = urllib.parse.urlparse(raw)
    except Exception:
        return False, 400, "유효한 X-Proxy-Target-Base URL이 아닙니다."

    if parsed.scheme.lower() != "https":
        return False, 403, "HTTPS 대상 호스트만 프록시할 수 있습니다."
    if parsed.username or parsed.password:
        return False, 403, "인증 정보가 포함된 URL은 허용되지 않습니다."
    if parsed.path not in ("", "/"):
        return False, 403, "기본 도메인 루트 URL만 허용됩니다."
    if not parsed.netloc:
        return False, 400, "유효한 X-Proxy-Target-Base URL이 아닙니다."

    host = (parsed.hostname or "").lower().strip("[]")
    if restricted_hosts:
        if host not in restricted_hosts:
            return False, 403, "허용되지 않은 프록시 대상 호스트입니다."
    elif is_blocked_ssrf_host(host):
        return False, 403, "사설망·로컬·IP 기반 프록시 대상은 보안상 차단됩니다."

    return True, 200, f"https://{parsed.netloc}"


def create_handler_class(restricted_hosts: set[str]):
    restricted_list = sorted(restricted_hosts)

    class PeerFeedbackHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:
            # Suppress default stderr logging to avoid cluttered output or header leakage.
            return

        def _send_bytes(
            self,
            status: int,
            content_type: str,
            body: bytes,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _send_json(self, status: int, obj: dict) -> None:
            payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self._send_bytes(status, "application/json; charset=utf-8", payload)

        def _has_traversal(self) -> bool:
            raw_path_part = self.path.split("?", 1)[0].split("#", 1)[0]
            return bool(PATH_TRAVERSAL_RE.search(raw_path_part))

        def do_OPTIONS(self) -> None:
            if self._has_traversal():
                self._send_json(403, {"error": {"message": "허용되지 않은 파일 경로입니다."}})
                return
            parsed_req = urllib.parse.urlsplit(self.path)
            if parsed_req.path == "/api/proxy" or parsed_req.path.startswith("/api/proxy/"):
                self.send_response(204)
                self.send_header("Allow", "GET, POST, OPTIONS")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self._send_json(404, {"error": {"message": "찾을 수 없는 경로입니다."}})

        def _serve_static_file(self, file_path: str, content_type: str, label: str) -> None:
            try:
                with open(file_path, "rb") as f:
                    data = f.read()
                self._send_bytes(200, content_type, data)
            except FileNotFoundError:
                self._send_json(404, {"error": {"message": f"{label} 파일을 찾을 수 없습니다."}})
            except OSError:
                self._send_json(500, {"error": {"message": f"{label} 파일을 읽을 수 없습니다."}})

        def do_GET(self) -> None:
            if self._has_traversal():
                self._send_json(403, {"error": {"message": "허용되지 않은 파일 경로입니다."}})
                return

            parsed_req = urllib.parse.urlsplit(self.path)
            pathname = parsed_req.path

            if pathname in ("/", "/index.html"):
                self._serve_static_file(INDEX_HTML_PATH, "text/html; charset=utf-8", "index.html")
                return

            if pathname == "/styles.css":
                self._serve_static_file(STYLES_CSS_PATH, "text/css; charset=utf-8", "styles.css")
                return

            if pathname.startswith("/src/"):
                filename = pathname[len("/src/") :]
                if not SAFE_SRC_JS_RE.match(filename):
                    self._send_json(403, {"error": {"message": "허용되지 않은 파일 경로입니다."}})
                    return
                candidate = os.path.realpath(os.path.join(SRC_DIR, filename))
                if not candidate.startswith(SRC_DIR + os.sep):
                    self._send_json(403, {"error": {"message": "허용되지 않은 파일 경로입니다."}})
                    return
                self._serve_static_file(candidate, "text/javascript; charset=utf-8", f"src/{filename}")
                return

            if pathname == "/api/health":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "proxy": True,
                        "runtime": "python",
                        "restrictedHosts": restricted_list,
                    },
                )
                return

            if pathname == "/api/proxy" or pathname.startswith("/api/proxy/"):
                self._handle_proxy(parsed_req, method="GET")
                return

            if (
                pathname.startswith("/.")
                or pathname in ("/server.mjs", "/server.py", "/README.md")
                or pathname.startswith("/tests/")
            ):
                self._send_json(403, {"error": {"message": "허용되지 않은 경로입니다."}})
                return

            self._send_json(404, {"error": {"message": "찾을 수 없는 경로입니다."}})

        def do_POST(self) -> None:
            if self._has_traversal():
                self._send_json(403, {"error": {"message": "허용되지 않은 파일 경로입니다."}})
                return
            parsed_req = urllib.parse.urlsplit(self.path)
            pathname = parsed_req.path

            if pathname == "/api/proxy" or pathname.startswith("/api/proxy/"):
                self._handle_proxy(parsed_req, method="POST")
                return

            self._send_json(404, {"error": {"message": "찾을 수 없는 경로입니다."}})

        def _handle_method_not_allowed(self) -> None:
            self._send_json(
                405,
                {"error": {"message": "허용되지 않은 HTTP 메서드입니다. (GET, POST만 지원)"}},
            )

        def do_PUT(self) -> None:
            self._handle_method_not_allowed()

        def do_DELETE(self) -> None:
            self._handle_method_not_allowed()

        def do_PATCH(self) -> None:
            self._handle_method_not_allowed()

        def _handle_proxy(self, parsed_req: urllib.parse.SplitResult, method: str) -> None:
            upstream_path = parsed_req.path[len("/api/proxy") :]
            if not is_allowed_upstream_path(upstream_path):
                self._send_json(
                    403,
                    {"error": {"message": "허용되지 않은 프록시 경로입니다. (/v1/ 또는 /api/v1/만 허용)"}},
                )
                return

            ok, err_status, target_or_msg = resolve_target_base(
                self.headers.get("X-Proxy-Target-Base", ""), restricted_hosts
            )
            if not ok:
                self._send_json(err_status, {"error": {"message": target_or_msg}})
                return

            target_base = target_or_msg
            query_suffix = f"?{parsed_req.query}" if parsed_req.query else ""
            upstream_url = urllib.parse.urljoin(target_base, f"{upstream_path}{query_suffix}")
            parsed_upstream = urllib.parse.urlsplit(upstream_url)
            parsed_base = urllib.parse.urlsplit(target_base)

            if (
                parsed_upstream.scheme != parsed_base.scheme
                or parsed_upstream.netloc != parsed_base.netloc
                or not is_allowed_upstream_path(parsed_upstream.path)
            ):
                self._send_json(
                    403,
                    {"error": {"message": "허용되지 않은 프록시 경로입니다."}},
                )
                return

            body_bytes = None
            if method == "POST":
                raw_len = self.headers.get("Content-Length")
                if raw_len is not None:
                    try:
                        content_length = int(raw_len)
                    except ValueError:
                        self._send_json(400, {"error": {"message": "잘못된 Content-Length 헤더입니다."}})
                        return
                    if content_length < 0:
                        self._send_json(400, {"error": {"message": "잘못된 Content-Length 헤더입니다."}})
                        return
                    if content_length > MAX_BODY_BYTES:
                        self._send_json(
                            413,
                            {"error": {"message": "요청 크기가 25MB 제한을 초과했습니다."}},
                        )
                        return
                    body_bytes = self.rfile.read(content_length) if content_length > 0 else b""
                else:
                    body_bytes = b""

            forward_headers: dict[str, str] = {}
            for name in FORWARD_HEADER_ALLOWLIST:
                val = self.headers.get(name)
                if val:
                    forward_headers[name] = val

            req = urllib.request.Request(
                upstream_url,
                data=body_bytes if method == "POST" else None,
                headers=forward_headers,
                method=method,
            )

            started_at = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=180, context=SSL_CONTEXT) as resp:
                    res_bytes = resp.read()
                    status = resp.status
                    content_type = resp.headers.get("Content-Type") or "application/json; charset=utf-8"
                    elapsed_ms = int((time.monotonic() - started_at) * 1000)
                    print(f"[proxy] {method} {parsed_upstream.path} -> {status} ({elapsed_ms}ms)", flush=True)
                    self._send_bytes(status, content_type, res_bytes)
            except urllib.error.HTTPError as err:
                res_bytes = err.read()
                content_type = (
                    err.headers.get("Content-Type") if err.headers else None
                ) or "application/json; charset=utf-8"
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                print(f"[proxy] {method} {parsed_upstream.path} -> {err.code} ({elapsed_ms}ms)", flush=True)
                self._send_bytes(err.code, content_type, res_bytes)
            except Exception as err:
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                print(f"[proxy] {method} {parsed_upstream.path} -> 502 ({elapsed_ms}ms)", flush=True)
                self._send_json(
                    502,
                    {"error": {"message": f"게이트웨이 업스트림 연결 실패: {err}"}},
                )

    return PeerFeedbackHandler


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def bind_with_fallback(start_port: int, handler_cls):
    for offset in range(PORT_TRY_COUNT):
        candidate = start_port + offset
        if candidate > 65535:
            break
        try:
            server = ReusableThreadingHTTPServer(("127.0.0.1", candidate), handler_cls)
            return server, candidate
        except OSError as err:
            if err.errno in (errno.EADDRINUSE, 10048, 98, 48):
                continue
            raise
    raise RuntimeError(
        f"사용 가능한 로컬 포트를 찾지 못했습니다 ({start_port}–{min(65535, start_port + PORT_TRY_COUNT - 1)})."
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="동료평가 상호 피드백 초안 생성기 로컬 실행기 (Python 3)"
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="시작 포트 (기본: 8765)")
    parser.add_argument("--no-open", action="store_true", help="브라우저 자동 열기 비활성화")
    parser.add_argument(
        "--allow-host",
        type=str,
        default="",
        help="특정 허용 프록시 대상 호스트 제한 (쉼표 구분, 미지정 시 공개 HTTPS 게이트웨이 허용)",
    )
    args = parser.parse_args(argv)
    if args.port < 1 or args.port > 65535:
        parser.error("포트 번호는 1–65535 사이여야 합니다.")
    return args


def main() -> None:
    args = parse_args(sys.argv[1:])
    restricted_hosts = set()
    for item in args.allow_host.split(","):
        clean = item.strip().lower()
        if clean:
            restricted_hosts.add(clean)

    handler_cls = create_handler_class(restricted_hosts)
    try:
        server, bound_port = bind_with_fallback(args.port, handler_cls)
    except Exception as err:
        print(f"[오류] 서버 시작 실패: {err}", file=sys.stderr)
        sys.exit(1)

    local_url = f"http://localhost:{bound_port}"
    target_desc = (
        ", ".join(sorted(restricted_hosts))
        if restricted_hosts
        else "공개 HTTPS 게이트웨이 (SSRF 차단 적용 · --allow-host로 특정 호스트만 제한 가능)"
    )
    print("=" * 60)
    print("  동료평가 상호 피드백 초안 생성기 — 로컬 실행기 (Python 3)")
    print("=" * 60)
    print(f"  접속 주소 : {local_url}")
    print(f"  허용 대상 : {target_desc}")
    print("  종료 방법 : Ctrl+C")
    print("  권장 팁   : 실시간 한국어 대본(Web Speech API)은 일반 Google Chrome에서 열면 가장 잘 동작합니다.")
    print("=" * 60, flush=True)

    if not args.no_open:
        try:
            webbrowser.open(local_url)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n로컬 실행기를 종료합니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
