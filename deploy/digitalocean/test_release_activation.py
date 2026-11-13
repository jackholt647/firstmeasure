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


    def run_activation(self, verify_exit, prune_service_exit):
        """Successful (or failed) legacy activation on a fake host with old releases to prune."""
        import time
        folder = tempfile.mkdtemp()
        self.addCleanup(lambda: subprocess.run(['rm', '-rf', folder]))
        root = Path(folder)
        app = root / 'app'
        releases = app / 'releases'
        now = time.time()
        names = [f'{i:040x}' for i in range(8)]  # 0 is oldest
        for age, name in enumerate(reversed(names)):
            (releases / name).mkdir(parents=True)
            stamp = now - (10 + age) * 86400
            os.utime(releases / name, (stamp, stamp))
        (releases / 'cluster-v1.0.0').mkdir()
        old = releases / names[-1]
        new = releases / ('b' * 40)
        (new / 'public/v1/dist/src').mkdir(parents=True)
        (new / 'public/v1/dist/src/server.js').write_text('// built fixture')
        (new / 'deploy/digitalocean').mkdir(parents=True)
        (new / 'deploy/digitalocean/verify-node.sh').write_text(f'exit {verify_exit}\n')
        (app / 'current').symlink_to(old)
        here = Path(__file__).parent
        source = (here / 'activate-release.sh').read_text()
        (root / 'activate-release.sh').write_text(source.replace('/opt/firstmeasure', str(app)))
        (root / 'prune-releases.py').write_text((here / 'prune-releases.py').read_text())
        log = root / 'systemctl.log'
        fake = root / 'systemctl'
        fake.write_text('#!/bin/bash\necho "$@" >> ' + str(log) + '\n'
                        'case "$1" in is-active) exit 3;; start) exit ' + str(prune_service_exit) + ';; esac\nexit 0\n')
        fake.chmod(0o755)
        env = {**os.environ, 'FIRSTMEASURE_SYSTEMCTL': str(fake), 'FIRSTMEASURE_JOURNALCTL': 'true'}
        result = subprocess.run(['bash', str(root / 'activate-release.sh'), 'b' * 40, 'firstmeasure-legacy.service'],
                                capture_output=True, text=True, env=env, timeout=120)
        return app, names, result, log.read_text()

    def test_successful_activation_prunes_old_releases_quietly(self):
        if os.name == 'nt':
            self.skipTest('Executable shell harness runs on Linux CI')
        app, names, result, calls = self.run_activation(0, 1)  # prune service unavailable: inline fallback
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip().splitlines()[-1].startswith('Activated ' + 'b' * 40))
        self.assertIn('start --no-block firstmeasure-release-prune.service', calls)
        left = sorted(p.name for p in (app / 'releases').iterdir())
        # The new release, the previous one (rollback target), the next two newest, hand-made folders.
        self.assertEqual(left, sorted(['b' * 40, names[-1], names[-2], names[-3], 'cluster-v1.0.0']))
        self.assertEqual((app / 'current').resolve().name, 'b' * 40)

    def test_activation_hands_pruning_to_the_service_when_available(self):
        if os.name == 'nt':
            self.skipTest('Executable shell harness runs on Linux CI')
        app, names, result, calls = self.run_activation(0, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('start --no-block firstmeasure-release-prune.service', calls)
        self.assertEqual(len(list((app / 'releases').iterdir())), 10)  # the service, not the script, prunes

    def test_failed_activation_rolls_back_and_prunes_nothing(self):
        if os.name == 'nt':
            self.skipTest('Executable shell harness runs on Linux CI')
        app, names, result, calls = self.run_activation(1, 1)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('firstmeasure-release-prune', calls)
        self.assertEqual(len(list((app / 'releases').iterdir())), 10)
        self.assertEqual((app / 'current').resolve().name, names[-1])


if __name__ == '__main__':
    unittest.main()
