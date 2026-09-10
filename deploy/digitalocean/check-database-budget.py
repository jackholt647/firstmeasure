#!/usr/bin/env python3
"""Offline connection-budget gate. No database or provider writes."""
import argparse
import json


def budget(max_connections, reserved, old_nodes, new_nodes, processes, pool_max, other_connections, headroom, new_processes=None):
    new_processes = processes if new_processes is None else new_processes
    values = (max_connections, reserved, old_nodes, new_nodes, processes, new_processes, pool_max, other_connections, headroom)
    if any(type(value) is not int or value < 0 for value in values) or not processes or not new_processes or not pool_max:
        raise ValueError('Invalid capacity inputs')
    usable = max_connections - reserved
    demand = (old_nodes * processes + new_nodes * new_processes) * pool_max + other_connections
    return dict(ok=demand + headroom <= usable, usable_connections=usable,
                estimated_peak_connections=demand, required_headroom=headroom,
                remaining_after_estimated_peak=usable - demand,
                note='Connection budget only; separately inspect CPU, memory, I/O and query latency. Other connections must include provider, worker, legacy, dedicated and administrative clients.')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('max-connections', 'reserved', 'old-nodes', 'new-nodes', 'processes', 'pool-max', 'other-connections', 'headroom'):
        p.add_argument('--' + name, type=int, required=True)
    p.add_argument('--new-processes', type=int, help='Incoming-node process count; defaults to --processes')
    result = budget(**vars(p.parse_args()))
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ok'] else 2)
