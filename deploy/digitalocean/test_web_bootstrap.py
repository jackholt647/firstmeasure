import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class WebBootstrapTests(unittest.TestCase):
    def exercise(self, overlay):
        script = Path(__file__).with_name('production-web-user-data.sh').read_text()
        python = script.split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            concrete_path = type(root)
            config = root / 'etc/firstmeasure'
            config.mkdir(parents=True)
            (root / 'etc/systemd/system/firstmeasure-web.service.d').mkdir(parents=True)
            (config / 'preproduction-runtime.env').write_text(
                'FIRSTMEASURE_DATA_ENVIRONMENT=production\nSPACES_PREFIX=production\n'
                'PLATFORM_HEARTBEAT_DISABLED=1\nLEGACY_PROXY_SECRET=test-only-fixture\n')
            def mapped_path(value):
                return concrete_path(folder) / str(value).lstrip('/')
            with patch('pathlib.Path', mapped_path), patch('os.umask'), \
                    patch('time.sleep'), patch('urllib.request.urlopen', side_effect=lambda *a, **k: io.BytesIO(overlay)):
                exec(compile(python, 'production-web-user-data', 'exec'), {})
            saved = config / 'production-cutover.env'
            self.assertEqual(saved.read_bytes(), overlay)
            if os.name == 'posix':
                self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
            self.assertFalse((config / 'production-cutover.env.next').exists())

    def test_partial_overlay_inherits_production_identity_from_base(self):
        self.exercise(b'PLATFORM_HEARTBEAT_DISABLED=1\nV1_WEB_WORKERS=2\n')

    def test_cross_environment_or_heartbeat_overlay_is_rejected(self):
        for overlay in (b'FIRSTMEASURE_DATA_ENVIRONMENT=development\n',
                        b'SPACES_PREFIX=development\n',
                        b'PLATFORM_HEARTBEAT_DISABLED=0\n'):
            with self.subTest(overlay=overlay), self.assertRaisesRegex(RuntimeError, 'environment fetch failed'):
                self.exercise(overlay)


if __name__ == '__main__':
    unittest.main()
