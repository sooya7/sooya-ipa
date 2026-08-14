#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import threading
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

    def test_pull_downloads_only_matching_release_asset_and_verifies_it(self) -> None:
        payload = b'release-asset'
        digest = hashlib.sha256(payload).hexdigest()
        url = 'https://api.github.com/repos/sooya7/sooya-ipa/releases/assets/12345'

        def download(_url: str, target: Path, github_token: str):
            self.assertEqual(_url, url)
            self.assertEqual(github_token, 'ephemeral-token')
            target.write_bytes(payload)
            return len(payload), digest

        body = json.dumps({'url': url, 'githubToken': 'ephemeral-token', 'bytes': len(payload), 'sha256': digest}).encode()
        with mock.patch.object(ota_server, 'download_release_asset', side_effect=download):
            with self.request(f'/uploads/{self.release}/pull', body, 'POST') as response:
                self.assertEqual(response.status, 201)
        with self.request(f'/bundles/{self.release}/bundle.zip') as response:
            self.assertEqual(response.read(), payload)

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
