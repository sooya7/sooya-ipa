#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(os.environ.get('SOOYA_OTA_ROOT', '/opt/sooya-ota/public')).resolve()
TOKEN_PATH = Path(os.environ.get('SOOYA_OTA_TOKEN_FILE', '/opt/sooya-ota/private/publish-token'))
MAX_UPLOAD = 100 * 1024 * 1024
MAX_CHUNK = 2 * 1024 * 1024
MAX_PARTS = 100
RELEASE_ID = re.compile(r'^ota-[0-9a-f]{40}$')
CHUNK_NAME = re.compile(r'^[0-9]{5}\.part$')
PULL_URL = re.compile(r'^https://api\.github\.com/repos/sooya7/sooya-ipa/releases/assets/[1-9][0-9]*$')

_PULL_JOBS_LOCK = threading.Lock()
_PULL_JOBS: dict[str, dict[str, object]] = {}


def publish_token() -> str:
    return TOKEN_PATH.read_text(encoding='utf-8').strip()


def request_path(raw_path: str) -> str:
    path = unquote(urlsplit(raw_path).path)
    if not path.startswith('/ota/'):
        return ''
    return path[len('/ota/'):].lstrip('/')


def resolve_public_target(raw_path: str) -> Path | None:
    relative = request_path(raw_path)
    if not relative or '\\' in relative or '\x00' in relative:
        return None
    parts = relative.split('/')
    if any(not part or part in {'.', '..'} or part.startswith('.') for part in parts):
        return None
    allowed = relative in {'stable.json', 'stable.json.tmp'}
    allowed = allowed or (len(parts) == 3 and parts[0] == 'bundles' and parts[2] == 'bundle.zip' and RELEASE_ID.fullmatch(parts[1]) is not None)
    allowed = allowed or (len(parts) == 3 and parts[0] == 'manifests' and parts[2] == 'ota-manifest.json' and RELEASE_ID.fullmatch(parts[1]) is not None)
    if not allowed:
        return None
    candidate = (ROOT / relative).resolve()
    return candidate if ROOT in candidate.parents else None


def resolve_chunk_target(raw_path: str) -> tuple[str, Path] | None:
    parts = request_path(raw_path).split('/')
    if len(parts) != 4 or parts[0] != 'uploads' or parts[2] != 'chunks':
        return None
    release_id, chunk_name = parts[1], parts[3]
    if RELEASE_ID.fullmatch(release_id) is None or CHUNK_NAME.fullmatch(chunk_name) is None:
        return None
    target = (ROOT / 'uploads' / release_id / 'chunks' / chunk_name).resolve()
    upload_root = (ROOT / 'uploads').resolve()
    return (release_id, target) if upload_root in target.parents else None


def resolve_assemble_release(raw_path: str) -> str | None:
    parts = request_path(raw_path).split('/')
    if len(parts) == 3 and parts[0] == 'uploads' and parts[2] == 'assemble' and RELEASE_ID.fullmatch(parts[1]):
        return parts[1]
    return None


def resolve_pull_release(raw_path: str) -> str | None:
    parts = request_path(raw_path).split('/')
    if len(parts) == 3 and parts[0] == 'uploads' and parts[2] == 'pull' and RELEASE_ID.fullmatch(parts[1]):
        return parts[1]
    return None


def resolve_pull_status_release(raw_path: str) -> str | None:
    parts = request_path(raw_path).split('/')
    if len(parts) == 3 and parts[0] == 'uploads' and parts[2] == 'status' and RELEASE_ID.fullmatch(parts[1]):
        return parts[1]
    return None


def fsync_parent(target: Path) -> None:
    if os.name == 'nt':
        return
    directory_fd = os.open(target.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def bundle_matches(target: Path, expected_bytes: int, expected_sha: str) -> bool:
    if not target.is_file() or target.stat().st_size != expected_bytes:
        return False
    with target.open('rb') as existing:
        return hashlib.file_digest(existing, 'sha256').hexdigest() == expected_sha


def get_pull_job(release_id: str) -> dict[str, object] | None:
    with _PULL_JOBS_LOCK:
        job = _PULL_JOBS.get(release_id)
        return dict(job) if job is not None else None


def set_pull_job(release_id: str, **values: object) -> dict[str, object]:
    with _PULL_JOBS_LOCK:
        current = dict(_PULL_JOBS.get(release_id, {}))
        current.update(values)
        _PULL_JOBS[release_id] = current
        return dict(current)


def download_release_asset(url: str, target: Path, github_token: str) -> tuple[int, str]:
    request = Request(url, headers={
        'User-Agent': 'SOOYA-OTA/1.3',
        'Accept': 'application/octet-stream',
        'Authorization': f'Bearer {github_token}',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    digest = hashlib.sha256()
    written = 0
    with urlopen(request, timeout=120) as response, target.open('wb') as output:
        declared = response.headers.get('Content-Length')
        if declared is not None and int(declared) > MAX_UPLOAD:
            raise ValueError('release asset exceeds upload limit')
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_UPLOAD:
                raise ValueError('release asset exceeds upload limit')
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    return written, digest.hexdigest()


def run_pull_job(
    release_id: str,
    url: str,
    github_token: str,
    expected_bytes: int,
    expected_sha: str,
) -> None:
    target = ROOT / 'bundles' / release_id / 'bundle.zip'
    temporary: Path | None = None
    set_pull_job(
        release_id,
        state='running',
        bytes=expected_bytes,
        sha256=expected_sha,
        error=None,
    )
    try:
        if bundle_matches(target, expected_bytes, expected_sha):
            shutil.rmtree(ROOT / 'uploads' / release_id, ignore_errors=True)
            set_pull_job(release_id, state='ready')
            return

        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f'.{target.name}.{os.getpid()}.{secrets.token_hex(8)}.incoming')
        written, actual_sha = download_release_asset(url, temporary, github_token)
        if written != expected_bytes or actual_sha != expected_sha:
            raise ValueError('pulled bundle checksum mismatch')

        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
        fsync_parent(target)
        temporary = None
        shutil.rmtree(ROOT / 'uploads' / release_id, ignore_errors=True)
        set_pull_job(release_id, state='ready')
    except Exception as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        message = f'{type(error).__name__}: {error}'
        set_pull_job(release_id, state='failed', error=message[:512])


class OtaHandler(BaseHTTPRequestHandler):
    server_version = 'SOOYA-OTA/1.3'

    def log_message(self, fmt: str, *args: object) -> None:
        super().log_message('%s', fmt % args)

    def send_common(self, content_type: str = 'application/json') -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Type', content_type)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_common()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = (json.dumps(payload, separators=(',', ':')) + '\n').encode()
        self.send_response(status)
        self.send_common()
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_empty(204)

    def do_HEAD(self) -> None:
        self.serve_file(send_body=False)

    def do_GET(self) -> None:
        status_release = resolve_pull_status_release(self.path)
        if status_release is not None:
            self.serve_pull_status(status_release)
            return
        self.serve_file(send_body=True)

    def serve_pull_status(self, release_id: str) -> None:
        if not self.authorized():
            self.send_error(401)
            return
        job = get_pull_job(release_id)
        target = ROOT / 'bundles' / release_id / 'bundle.zip'
        if job is None:
            if target.is_file():
                self.send_json(200, {'state': 'ready', 'bytes': target.stat().st_size})
            else:
                self.send_error(404)
            return
        self.send_json(200, job)

    def serve_file(self, send_body: bool) -> None:
        target = resolve_public_target(self.path)
        if target is None or not target.is_file():
            self.send_error(404)
            return
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = 'application/zip' if target.suffix == '.zip' else (mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
        self.send_response(200)
        self.send_common(content_type)
        self.send_header('Cache-Control', 'no-store, max-age=0' if target.name.startswith('stable.json') else 'public, max-age=31536000, immutable')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if send_body:
            self.wfile.write(data)

    def authorized(self) -> bool:
        supplied = self.headers.get('Authorization', '')
        return hmac.compare_digest(supplied, f'Bearer {publish_token()}')

    def content_length(self, maximum: int) -> int | None:
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            length = -1
        if length < 0:
            self.send_error(411)
            return None
        if length > maximum:
            self.send_error(413)
            return None
        return length

    def read_body(self, length: int) -> bytes:
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                raise OSError('unexpected end of request body')
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)

    def atomic_write(self, target: Path, body: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f'.{target.name}.{os.getpid()}.{secrets.token_hex(8)}.incoming')
        try:
            with temporary.open('wb') as handle:
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, target)
            fsync_parent(target)
        finally:
            temporary.unlink(missing_ok=True)

    def do_PUT(self) -> None:
        if not self.authorized():
            self.send_error(401)
            return
        chunk = resolve_chunk_target(self.path)
        target = chunk[1] if chunk else resolve_public_target(self.path)
        if target is None:
            self.send_error(404)
            return
        length = self.content_length(MAX_CHUNK if chunk else MAX_UPLOAD)
        if length is None:
            return
        try:
            self.atomic_write(target, self.read_body(length))
        except Exception:
            self.send_error(500)
            return
        self.send_empty(201)

    def do_POST(self) -> None:
        if not self.authorized():
            self.send_error(401)
            return

        pull_release_id = resolve_pull_release(self.path)
        if pull_release_id is not None:
            self.start_pull(pull_release_id)
            return

        release_id = resolve_assemble_release(self.path)
        if release_id is None:
            self.send_error(404)
            return
        self.assemble_chunks(release_id)

    def start_pull(self, release_id: str) -> None:
        length = self.content_length(16 * 1024)
        if length is None:
            return
        try:
            payload = json.loads(self.read_body(length))
            expected_bytes = int(payload['bytes'])
            expected_sha = str(payload['sha256'])
            url = str(payload['url'])
            github_token = str(payload['githubToken'])
            if not 0 < expected_bytes <= MAX_UPLOAD or re.fullmatch(r'[0-9a-f]{64}', expected_sha) is None:
                raise ValueError('invalid pull payload')
            if PULL_URL.fullmatch(url) is None or not github_token:
                raise ValueError('release asset URL is not allowed')
        except Exception:
            self.send_error(422)
            return

        target = ROOT / 'bundles' / release_id / 'bundle.zip'
        if bundle_matches(target, expected_bytes, expected_sha):
            set_pull_job(
                release_id,
                state='ready',
                bytes=expected_bytes,
                sha256=expected_sha,
                error=None,
            )
            self.send_json(200, get_pull_job(release_id) or {'state': 'ready'})
            return

        with _PULL_JOBS_LOCK:
            current = _PULL_JOBS.get(release_id)
            if current is not None and current.get('state') in {'queued', 'running'}:
                same_payload = current.get('bytes') == expected_bytes and current.get('sha256') == expected_sha
                if not same_payload:
                    self.send_error(409)
                    return
                response = dict(current)
                should_start = False
            else:
                response = {
                    'state': 'queued',
                    'bytes': expected_bytes,
                    'sha256': expected_sha,
                    'error': None,
                }
                _PULL_JOBS[release_id] = dict(response)
                should_start = True

        if should_start:
            thread = threading.Thread(
                target=run_pull_job,
                args=(release_id, url, github_token, expected_bytes, expected_sha),
                name=f'ota-pull-{release_id[-8:]}',
                daemon=True,
            )
            thread.start()

        self.send_json(202, response)

    def assemble_chunks(self, release_id: str) -> None:
        length = self.content_length(16 * 1024)
        if length is None:
            return
        temporary: Path | None = None
        try:
            payload = json.loads(self.read_body(length))
            parts = int(payload['parts'])
            expected_bytes = int(payload['bytes'])
            expected_sha = str(payload['sha256'])
            if not 1 <= parts <= MAX_PARTS or not 0 < expected_bytes <= MAX_UPLOAD or re.fullmatch(r'[0-9a-f]{64}', expected_sha) is None:
                raise ValueError('invalid assembly payload')

            target = ROOT / 'bundles' / release_id / 'bundle.zip'
            if bundle_matches(target, expected_bytes, expected_sha):
                shutil.rmtree(ROOT / 'uploads' / release_id, ignore_errors=True)
                self.send_empty(201)
                return

            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f'.{target.name}.{os.getpid()}.{secrets.token_hex(8)}.incoming')
            chunk_dir = ROOT / 'uploads' / release_id / 'chunks'
            digest = hashlib.sha256()
            written = 0
            with temporary.open('wb') as output:
                for index in range(parts):
                    part = chunk_dir / f'{index:05}.part'
                    if not part.is_file():
                        raise ValueError(f'missing chunk {index}')
                    data = part.read_bytes()
                    if not data or len(data) > MAX_CHUNK:
                        raise ValueError(f'invalid chunk {index}')
                    output.write(data)
                    digest.update(data)
                    written += len(data)
                output.flush()
                os.fsync(output.fileno())
            if written != expected_bytes or digest.hexdigest() != expected_sha:
                raise ValueError('assembled bundle checksum mismatch')

            os.chmod(temporary, 0o644)
            os.replace(temporary, target)
            temporary = None
            fsync_parent(target)
            shutil.rmtree(ROOT / 'uploads' / release_id, ignore_errors=True)
        except Exception:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            self.send_error(422)
            return
        self.send_empty(201)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18223), OtaHandler).serve_forever()
