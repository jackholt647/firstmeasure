"""Execute the production activation guard against temporary paths, never /opt."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest


class ActivationTests(unittest.TestCase):
    def test_channel_failure_does_not_switch_release_or_restart_services(self):
        if os.name == 'nt':
            self.skipTest('Executable shell harness runs on Linux CI; Windows runs transport/archive tests')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            app = root / 'app'
            old = app / 'releases' / ('a' * 40)
            new = app / 'releases' / ('b' * 40)
            old.mkdir(parents=True)
            (new / 'public/v1/dist/src').mkdir(parents=True)
            (new / 'public/v1/dist/src/server.js').write_text('// built fixture')
            (app / 'current').symlink_to(old)
            source = Path(__file__).with_name('activate-release.sh').read_text()
            (root / 'activate-release.sh').write_text(source.replace('/opt/firstmeasure', str(app)))
            (root / 'with-service-environment.py').write_text('raise SystemExit(23)\n')
            result = subprocess.run(['bash', str(root / 'activate-release.sh'), 'b' * 40, 'firstmeasure-web.service'], capture_output=True)
            self.assertEqual(result.returncode, 23)
            self.assertEqual((app / 'current').resolve(), old)
            self.assertFalse((app / 'current.next').exists())


if __name__ == '__main__':
    unittest.main()
