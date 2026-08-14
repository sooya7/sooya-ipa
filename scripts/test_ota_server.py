#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock
from http.server import ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('ota_server', Path(__file__).with_name('ota_server.py'))
ota_server = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ota_server)


class OtaServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.token_file = root / 'token'
        self.token_file.write_text('test-token', encoding='utf-8')
        ota_server.ROOT = (root / 'public').resolve()
        ota_server.TOKEN_PATH = self.token_file
        with ota_server._PULL_JOBS_LOCK:
            ota_server._PULL_JOBS.clear()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), ota_server.OtaHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/ota'
        self.release = 'ota-' + ('a' * 40)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path: str, data: bytes | None = None, method: str = 'GET'):
        request = urllib.request.Request(
            f'{self.base}{path}', data=data, method=method,
            headers={'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'},
        )
        return urllib.request.urlopen(request)

    def wait_for_pull(self, timeout: float = 2.0) -> dict[str, object]:
        deadline = time.monotonic() + timeout
        last: dict[str, object] = {}
        while time.monotonic() < deadline:
            with self.request(f'/uploads/{self.release}/status') as response:
                last = json.loads(response.read())
            if last.get('state') in {'ready', 'failed'}:
                return last
            time.sleep(0.01)
        self.fail(f'pull did not finish: {last}')

    def test_chunked_upload_assembles_public_bundle(self) -> None:
        payload = b'a' * 1234 + b'b' * 567
        chunks = [payload[:1024], payload[1024:]]
        for index, chunk in enumerate(chunks):
            with self.request(f'/uploads/{self.release}/chunks/{index:05}.part', chunk, 'PUT') as response:
                self.assertEqual(response.status, 201)
        assembly = json.dumps({
            'parts': len(chunks), 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
        }).encode()
        with self.request(f'/uploads/{self.release}/assemble', assembly, 'POST') as response:
            self.assertEqual(response.status, 201)
        with self.request(f'/uploads/{self.release}/assemble', assembly, 'POST') as response:
            self.assertEqual(response.status, 201)
        with self.request(f'/bundles/{self.release}/bundle.zip') as response:
            self.assertEqual(response.read(), payload)
        self.assertFalse((ota_server.ROOT / 'uploads' / self.release).exists())

    def test_bad_checksum_does_not_publish_or_expose_chunks(self) -> None:
        with self.request(f'/uploads/{self.release}/chunks/00000.part', b'payload', 'PUT'):
            pass
        assembly = json.dumps({'parts': 1, 'bytes': 7, 'sha256': '0' * 64}).encode()
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f'/uploads/{self.release}/assemble', assembly, 'POST')
        self.assertEqual(error.exception.code, 422)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f'/uploads/{self.release}/chunks/00000.part')
        self.assertEqual(error.exception.code, 404)
        self.assertFalse((ota_server.ROOT / 'bundles' / self.release / 'bundle.zip').exists())

    def test_pull_is_async_and_publishes_verified_release_asset(self) -> None:
        payload = b'release-asset'
        digest = hashlib.sha256(payload).hexdigest()
        url = 'https://api.github.com/repos/sooya7/sooya-ipa/releases/assets/12345'
        started = threading.Event()
        release_download = threading.Event()

        def download(_url: str, target: Path, github_token: str):
            self.assertEqual(_url, url)
            self.assertEqual(github_token, 'ephemeral-token')
            started.set()
            self.assertTrue(release_download.wait(1.0))
            target.write_bytes(payload)
            return len(payload), digest

        body = json.dumps({'url': url, 'githubToken': 'ephemeral-token', 'bytes': len(payload), 'sha256': digest}).encode()
        with mock.patch.object(ota_server, 'download_release_asset', side_effect=download):
            before = time.monotonic()
            with self.request(f'/uploads/{self.release}/pull', body, 'POST') as response:
                self.assertEqual(response.status, 202)
                queued = json.loads(response.read())
            self.assertLess(time.monotonic() - before, 0.5)
            self.assertIn(queued['state'], {'queued', 'running'})
            self.assertTrue(started.wait(0.5))

            with self.request(f'/uploads/{self.release}/status') as response:
                status = json.loads(response.read())
            self.assertEqual(status['state'], 'running')

            release_download.set()
            status = self.wait_for_pull()
            self.assertEqual(status['state'], 'ready')

        with self.request(f'/bundles/{self.release}/bundle.zip') as response:
            self.assertEqual(response.read(), payload)

    def test_duplicate_pull_does_not_start_second_download(self) -> None:
        payload = b'release-asset'
        digest = hashlib.sha256(payload).hexdigest()
        url = 'https://api.github.com/repos/sooya7/sooya-ipa/releases/assets/12345'
        started = threading.Event()
        release_download = threading.Event()
        calls = 0

        def download(_url: str, target: Path, github_token: str):
            nonlocal calls
            calls += 1
            started.set()
            self.assertTrue(release_download.wait(1.0))
            target.write_bytes(payload)
            return len(payload), digest

        body = json.dumps({'url': url, 'githubToken': 'ephemeral-token', 'bytes': len(payload), 'sha256': digest}).encode()
        with mock.patch.object(ota_server, 'download_release_asset', side_effect=download):
            with self.request(f'/uploads/{self.release}/pull', body, 'POST') as response:
                self.assertEqual(response.status, 202)
            self.assertTrue(started.wait(0.5))
            with self.request(f'/uploads/{self.release}/pull', body, 'POST') as response:
                self.assertEqual(response.status, 202)
            self.assertEqual(calls, 1)
            release_download.set()
            self.assertEqual(self.wait_for_pull()['state'], 'ready')

    def test_pull_failure_is_reported_without_publishing(self) -> None:
        payload = b'release-asset'
        digest = hashlib.sha256(payload).hexdigest()
        url = 'https://api.github.com/repos/sooya7/sooya-ipa/releases/assets/12345'
        body = json.dumps({'url': url, 'githubToken': 'ephemeral-token', 'bytes': len(payload), 'sha256': digest}).encode()

        with mock.patch.object(ota_server, 'download_release_asset', side_effect=TimeoutError('upstream stalled')):
            with self.request(f'/uploads/{self.release}/pull', body, 'POST') as response:
                self.assertEqual(response.status, 202)
            status = self.wait_for_pull()

        self.assertEqual(status['state'], 'failed')
        self.assertIn('TimeoutError', str(status['error']))
        self.assertFalse((ota_server.ROOT / 'bundles' / self.release / 'bundle.zip').exists())

    def test_pull_rejects_unapproved_repository_url(self) -> None:
        body = json.dumps({
            'url': 'https://api.github.com/repos/attacker/repo/releases/assets/12345',
            'githubToken': 'ephemeral-token',
            'bytes': 7,
            'sha256': hashlib.sha256(b'payload').hexdigest(),
        }).encode()
        with mock.patch.object(ota_server, 'download_release_asset') as download:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(f'/uploads/{self.release}/pull', body, 'POST')
        self.assertEqual(error.exception.code, 422)
        download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
