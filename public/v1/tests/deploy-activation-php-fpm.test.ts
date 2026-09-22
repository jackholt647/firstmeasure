import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../deploy/digitalocean/activate-release.sh", import.meta.url), "utf8");

test("web and compatibility activation refresh PHP-FPM, while worker activation does not", () => {
  assert.match(source, /restart_release_services\(\)/);
  const restart = source.slice(source.indexOf('restart_release_services()'), source.indexOf('\nln -sfn'));
  assert.match(restart, /if \[\[ "\$service_name" == "firstmeasure-web\.service" \|\| "\$service_name" == "firstmeasure-legacy\.service" \]\]; then[\s\S]+systemctl restart "\$php_fpm_service"/);
  assert.ok(!restart.includes('firstmeasure-worker.service'));

  const switchPosition = source.indexOf('mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current');
  const activationPosition = source.indexOf('if restart_release_services; then');
  assert.ok(switchPosition > 0 && activationPosition > switchPosition);
});

test("every PHP-serving nginx template sends a resolved release path to FPM", () => {
  for (const name of ['nginx-development-web.conf', 'nginx-development-legacy.conf', 'nginx-web.conf.template', 'nginx-legacy.conf']) {
    const config = readFileSync(new URL(`../../../deploy/digitalocean/${name}`, import.meta.url), 'utf8');
    assert.match(config, /fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;/, name);
    assert.ok(!config.includes('SCRIPT_FILENAME $document_root'), name);
  }
});

test("a failed compatibility activation also refreshes PHP-FPM after rollback", () => {
  const rollbackPosition = source.indexOf('echo "Activation failed; restoring the previous release."');
  const rollbackRestart = source.indexOf('restart_release_services', rollbackPosition);
  assert.ok(rollbackPosition > 0 && rollbackRestart > rollbackPosition);
});
