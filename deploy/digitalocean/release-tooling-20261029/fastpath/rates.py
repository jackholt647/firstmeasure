"""Run on a production host: 5xx rate in nginx access.log after a UTC time (HH:MM:SS) vs the 30 min before it, excluding LB health probes.
Optional second argument: the day (DD/Mon/YYYY) when the cut is not today (UTC). Copied from the FM-386 run (FM-388)."""
import re, sys, collections, datetime
t = sys.argv[1]; day = sys.argv[2] if len(sys.argv) > 2 else datetime.datetime.now(datetime.timezone.utc).strftime('%d/%b/%Y')
cut = datetime.datetime.strptime(day + ' ' + t, '%d/%b/%Y %H:%M:%S')
pat = re.compile(r'\[(\S+) \+0000\] "(\S+) (\S+)[^"]*" (\d{3}) ')
before = [0, 0]; after = [0, 0]; urls = collections.Counter()
for line in open('/var/log/nginx/access.log', errors='replace'):
    m = pat.search(line)
    if not m or m.group(3).startswith('/v1/health/'): continue
    ts = datetime.datetime.strptime(m.group(1), '%d/%b/%Y:%H:%M:%S'); five = m.group(4).startswith('5')
    if ts >= cut:
        after[0] += 1; after[1] += five
        if five: urls[m.group(3).split('?')[0][:60]] += 1
    elif (cut - ts).total_seconds() <= 1800:
        before[0] += 1; before[1] += five
pct = lambda x: round(100 * x[1] / x[0], 2) if x[0] else 0
print({'after_req': after[0], 'after_5xx': after[1], 'after_pct': pct(after), 'before30_req': before[0], 'before30_5xx': before[1], 'before_pct': pct(before), 'top': urls.most_common(3)})
