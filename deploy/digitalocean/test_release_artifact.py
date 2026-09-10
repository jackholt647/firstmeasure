import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import subprocess

spec = importlib.util.spec_from_file_location('artifact', Path(__file__).with_name('release-artifact.py'))
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


class ArtifactTests(unittest.TestCase):
    def test_packages_only_selected_source_and_runtime_and_writes_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'public/v1').mkdir(parents=True)
            (repo / 'public/v1/package-lock.json').write_text('{}')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            (repo / 'public/v1/dist/src').mkdir(parents=True)
            (repo / 'public/v1/dist/src/server.js').write_text('// fixture')
            (repo / 'public/v1/node_modules/pg').mkdir(parents=True)
            (repo / 'public/v1/node_modules/pg/package.json').write_text('{}')
            (repo / 'release.env').write_text('RELEASE_ID=' + commit + '\n')
            (repo / 'public/v1/.env').write_text('SECRET=never-package')
            (repo / 'unrelated.txt').write_text('not part of release')
            output = root / 'release.tar.gz'
            m = artifact.package(repo, repo, commit, output)
            with tarfile.open(output) as tar:
                self.assertNotIn('public/v1/.env', tar.getnames())
                self.assertNotIn('unrelated.txt', tar.getnames())
            self.assertEqual(json.loads((repo / '.release-artifact.json').read_text()), m)
            artifact.install(output, m, root / 'installed')

    def make(self, root, extras=()):
        file = root / 'release.tar.gz'
        files = [('release.env', b'RELEASE_ID=' + b'a' * 40 + b'\n'),
                 ('public/v1/dist/src/server.js', b'// compiled fixture'),
                 ('public/v1/package-lock.json', b'{}'),
                 ('public/v1/node_modules/pg/package.json', b'{}'), *extras]
        with tarfile.open(file, 'w:gz') as tar:
            for name, data in files:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        m = dict(schema=1, environment='production', role='web', platform='linux-x64',
                 release_id='a' * 40, sha256=artifact.digest(file), size=file.stat().st_size)
        return file, m

    def test_installs_complete_release_without_activating_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file, m = self.make(root)
            target = artifact.install(file, m, root / 'releases')
            self.assertTrue((target / 'public/v1/dist/src/server.js').is_file())
            self.assertFalse((root / 'current').exists())
            self.assertEqual(artifact.install(file, m, root / 'releases'), target)

    def test_rejects_traversal_secrets_and_duplicate_members_before_extracting(self):
        for name in ('../escape', '/escape', 'public/v1/storage/secrets/token.txt', 'public/v1/.env', 'release.env'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                file, m = self.make(root, [(name, b'bad')])
                with self.assertRaises(ValueError):
                    artifact.install(file, m, root / 'releases')
                self.assertEqual(list((root / 'releases').iterdir()), [])

    def test_rejects_tampering_and_different_existing_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file, m = self.make(root)
            with self.assertRaises(ValueError):
                artifact.install(file, {**m, 'sha256': '0' * 64}, root / 'releases')
            target = artifact.install(file, m, root / 'releases')
            (target / '.release-artifact.json').write_text('{}')
            with self.assertRaises(ValueError):
                artifact.install(file, m, root / 'releases')


if __name__ == '__main__':
    unittest.main()
