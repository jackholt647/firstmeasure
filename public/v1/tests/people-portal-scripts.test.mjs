import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The portal loads the settings shell with its own script tags, not through the app manifest, so the People scripts
// the shell relies on must be tagged there too, ahead of the shell, in the manifest's order.
test('the portal page loads every People script before the settings shell, in manifest order', async () => {
  const manifest = await readFile(new URL('../../libraries/apps/firstmate-apps-manifest.js', import.meta.url), 'utf8');
  const portal = await readFile(new URL('../../portal/index.php', import.meta.url), 'utf8');
  const people = [...manifest.matchAll(/versionedBundle\('(people\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(people.includes('people/people-settings.js'), 'the manifest lists the People bundles');
  const at = (path) => portal.indexOf(`src="../libraries/apps/${path}?v=`);
  const shell = at('settings/company.js');
  assert.ok(shell > 0, 'the portal loads the settings shell');
  let previous = -1;
  for (const path of [...new Set(people)]) {
    const position = at(path);
    assert.ok(position > 0, `the portal loads ${path}`);
    assert.ok(position > previous && position < shell, `${path} loads in manifest order and before the settings shell`);
    previous = position;
  }
});
