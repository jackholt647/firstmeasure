import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../deploy/digitalocean/activate-release.sh", import.meta.url), "utf8");

test("compatibility activation restarts PHP-FPM with the release", () => {
  assert.match(source, /restart_release_services\(\)/);
  assert.match(source, /firstmeasure-legacy\.service[\s\S]+systemctl restart "\$php_fpm_service"/);

  const switchPosition = source.indexOf('mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current');
  const activationPosition = source.indexOf('if restart_release_services; then');
  assert.ok(switchPosition > 0 && activationPosition > switchPosition);
});

test("a failed compatibility activation also refreshes PHP-FPM after rollback", () => {
  const rollbackPosition = source.indexOf('echo "Activation failed; restoring the previous release."');
  const rollbackRestart = source.indexOf('restart_release_services', rollbackPosition);
  assert.ok(rollbackPosition > 0 && rollbackRestart > rollbackPosition);
});
