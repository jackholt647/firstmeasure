import runpy
from pathlib import Path
import unittest

budget = runpy.run_path(str(Path(__file__).with_name('check-database-budget.py')))['budget']


class ReplacementBudgetTests(unittest.TestCase):
    def test_unbounded_overlap_fails_and_limited_incoming_processes_fit(self):
        inputs = dict(max_connections=100, reserved=3, old_nodes=6, new_nodes=6,
                      processes=8, pool_max=1, other_connections=23, headroom=10)
        self.assertFalse(budget(**inputs)['ok'])
        limited = budget(**inputs, new_processes=2)
        self.assertTrue(limited['ok'])
        self.assertEqual(limited['estimated_peak_connections'], 83)
        self.assertFalse(budget(**{**inputs, 'old_nodes': 8, 'new_nodes': 8}, new_processes=2)['ok'])

    def test_zero_incoming_processes_cannot_hide_connection_demand(self):
        with self.assertRaises(ValueError):
            budget(100, 3, 6, 6, 8, 1, 23, 10, new_processes=0)


if __name__ == '__main__':
    unittest.main()
