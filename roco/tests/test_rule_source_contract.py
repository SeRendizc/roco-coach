"""Cross-consumer contract for the adopted 2026-10-17 snapshot ruling.
No model calls; no replacement of the existing 41-cell historical test.
"""
import unittest
from unittest import mock
from roco_env import data
from roco_env.service import RocoService

class ActiveRuleSourceContract(unittest.TestCase):
    def setUp(self):
        self.rs=data.load_ruleset()
        self.svc=RocoService()
        self.pid=next(pid for pid,p in self.rs.pets.items() if set(p.types)=={'翼系','水系'})

    def test_type_row_explanation_matches_snapshot_ruling(self):
        row=self.svc._answer_type_row(self.rs,{'type':'翼系|水系'}).result
        self.assertEqual(next(x['multiplier'] for x in row['weak'] if x['type']=='电系'),3)
        self.assertNotIn('两系相乘',row['note'])
        self.assertIn('快照',row['note'])

    def test_weakness_summary_explanation_matches_snapshot_ruling(self):
        result=self.svc._answer_weakness_summary(self.rs,{'pet_ids':[self.pid]}).result
        self.assertNotIn('相乘',result['multiplier_rule'])
        self.assertIn('快照',result['multiplier_rule'])

    def test_weakness_summary_obeys_loaded_engine_chart(self):
        # A neutral chart must produce zero weaknesses, independent of cached raw rows.
        with mock.patch.object(data.TypeChart,'multiplier',return_value=1.0):
            result=self.svc._answer_weakness_summary(self.rs,{'pet_ids':[self.pid]}).result
        self.assertEqual(result['counted'],1)
        self.assertEqual(result['by_element'],[])

    def test_type_chart_exposes_current_and_historical_differences(self):
        result=self.svc._answer_type_chart(self.rs).result
        self.assertEqual(result.get('consistency_vs_snapshot',{}).get('checked'),1836)
        self.assertEqual(result['consistency_vs_snapshot']['mismatches'],0)
        self.assertEqual(result['legacy_multiply_vs_snapshot']['mismatches'],41)
        # Actual engine divergence must be detected by the same service readout.
        with mock.patch.object(data.TypeChart,'multiplier',return_value=4.0):
            wrong=self.svc._answer_type_chart(self.rs).result
        self.assertGreater(wrong['consistency_vs_snapshot']['mismatches'],0)
