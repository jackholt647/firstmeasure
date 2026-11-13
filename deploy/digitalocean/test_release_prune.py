"""Release pruning against temporary folders, never /opt."""
from pathlib import Path
import importlib.util
import os
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('prune_releases', Path(__file__).with_name('prune-releases.py'))
prune_releases = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune_releases)


def make_release(releases, name, age_hours, now):
    path = releases / name
    (path / 'public').mkdir(parents=True)
    (path / 'public' / 'file.txt').write_text(name)
    stamp = now - age_hours * 3600
    os.utime(path, (stamp, stamp))
    return path


@unittest.skipIf(os.name == 'nt', 'symlinks need Linux; runs on the release hosts and CI')
class PruneTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.now = time.time()
        self.plenty = mock.patch.object(prune_releases, 'free_percent', return_value=80.0)
        self.plenty.start()

    def tearDown(self):
        mock.patch.stopall()
        self.folder.cleanup()

    def names(self):
        return sorted(p.name for p in self.releases.iterdir())

    def test_keeps_current_and_newest_and_removes_the_rest(self):
        for i in range(10):
            make_release(self.releases, f'{i:040x}', 100 - i, self.now)
        current = make_release(self.releases, 'c' * 40, 500, self.now)  # oldest, but active
        (self.root / 'current').symlink_to(current)
        prune_releases.prune(self.root, 4, 15, now=self.now)
        self.assertEqual(self.names(), sorted(['c' * 40, f'{9:040x}', f'{8:040x}', f'{7:040x}']))

    def test_symlinked_rollback_target_and_recent_installs_survive(self):
        for i in range(8):
            make_release(self.releases, f'{i:040x}', 100 - i, self.now)
        (self.root / 'current').symlink_to(self.releases / f'{7:040x}')
        (self.root / 'previous').symlink_to(self.releases / f'{0:040x}')
        fresh = make_release(self.releases, 'f' * 40, 0.5, self.now)
        prune_releases.prune(self.root, 2, 15, now=self.now)
        self.assertIn(f'{0:040x}', self.names())
        self.assertIn(f'{7:040x}', self.names())
        self.assertIn(fresh.name, self.names())

    def test_stale_staging_removed_fresh_staging_kept(self):
        make_release(self.releases, '.release-install-old', 48, self.now)
        make_release(self.releases, '.release-install-new', 1, self.now)
        make_release(self.releases, '.abc1234.installing.99', 30, self.now)
        prune_releases.prune(self.root, 4, 15, now=self.now)
        self.assertEqual(self.names(), ['.release-install-new'])

    def test_emergency_keeps_current_and_one_rollback_target(self):
        for i in range(6):
            make_release(self.releases, f'{i:040x}', 1 - i * 0.1, self.now)  # all "recent"
        (self.root / 'current').symlink_to(self.releases / f'{2:040x}')
        mock.patch.stopall()
        mock.patch.object(prune_releases, 'free_percent', return_value=3.0).start()
        prune_releases.prune(self.root, 4, 15, now=self.now)
        self.assertEqual(len(self.names()), 2)
        self.assertIn(f'{2:040x}', self.names())

    def test_unrelated_names_untouched(self):
        for i in range(6):
            make_release(self.releases, f'{i:040x}', 100 - i, self.now)
        (self.releases / 'README').write_text('not a release')
        (self.releases / 'x').mkdir()
        for name in ('cluster-v1.0.0', 'preprod-r1-20260907', '1b09f15', '.urgent-20260909.ABC'):
            make_release(self.releases, name, 2000, self.now)
        prune_releases.prune(self.root, 2, 15, now=self.now)
        self.assertIn('README', self.names())
        self.assertIn('x', self.names())
        for name in ('cluster-v1.0.0', 'preprod-r1-20260907', '1b09f15', '.urgent-20260909.ABC'):
            self.assertIn(name, self.names())


if __name__ == '__main__':
    unittest.main()
