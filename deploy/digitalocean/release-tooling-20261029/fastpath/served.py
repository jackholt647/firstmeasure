#!/usr/bin/env python3
"""Fast path check (FM-388): production serves the new release's bytes for every changed static file.

  served.py RELEASE_ARCHIVE DECIDE_JSON [TRIES]

DECIDE_JSON is fastpath.sh decide's output (release-node-fingerprint.py compare). Each changed file
under public/ that NGINX serves as is (not .php) is fetched TRIES times (default 12) from
https://app.1m8.ai with a fresh query string, so the load balancer spreads the requests over the
web nodes (/measure/internal/ goes on to compatibility). Every 200 must be the archive's bytes;
removed files must not answer 200. Exit 1 on any mismatch. Prints sha256 prefixes, never content.
"""
import hashlib, json, random, sys, tarfile, urllib.error, urllib.request

archive, decide = sys.argv[1], json.load(open(sys.argv[2]))
tries = int(sys.argv[3]) if len(sys.argv) > 3 else 12
removed = set(decide.get('removed', []))
wanted = [n for n in decide['changed_static'] if n.startswith('public/') and not n.endswith('.php') and n not in removed]
expected = {}
with tarfile.open(archive, 'r:*') as tar:
    for member in tar:
        if member.isfile() and member.name in wanted:
            expected[member.name] = hashlib.sha256(tar.extractfile(member).read()).hexdigest()


def fetch(path):
    url = 'https://app.1m8.ai/' + path + '?fm_fastpath=' + str(random.randrange(10**9))
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=20) as r:
            return r.status, hashlib.sha256(r.read()).hexdigest()
    except urllib.error.HTTPError as e:
        return e.code, None


bad = 0
for name in sorted(expected):
    results = [fetch(name[len('public/'):]) for _ in range(tries)]
    same = sum(1 for status, digest in results if status == 200 and digest == expected[name])
    other = sorted({(status, (digest or '')[:12]) for status, digest in results if not (status == 200 and digest == expected[name])})
    bad += same != tries
    print(f'{"OK " if same == tries else "BAD"} {same}/{tries} {expected[name][:12]} {name}' + (f' other={other}' if other else ''))
for name in sorted(removed):
    if name.startswith('public/') and not name.endswith('.php'):
        status, _ = fetch(name[len('public/'):])
        bad += status == 200
        print(f'{"OK " if status != 200 else "BAD"} removed {name} -> {status}')
print('SERVED_OK' if not bad else f'SERVED_BAD {bad}')
sys.exit(1 if bad else 0)
