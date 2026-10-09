"""Профиль: свидетельства грейда, принятый ФСП, решения и границы доступа."""

import http.client
import json
import random
import sys
import threading
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import candidate_profile
import fsp
import grade_tests
import invitations
import projects
import ranking
import serve
import specializations
import test_project_news as fixtures
import users


class CandidateProfile(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ProjectNews()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.user = self.case.user
        self.uid = self.case.fixture.candidates['Backend']

    def write(self, path, data):
        path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

    def add_result(self, spec, grade, passed, **fields):
        record = {"id": str(uuid.uuid4()), "user_id": self.uid, "specialization": spec,
                  "grade": grade, "passed": passed, "created_at": '2026-10-10T10:00:00+00:00',
                  "task_key": None, "language": None, **fields}
        self.write(grade_tests.TESTS_DIR / f"{record['id']}.json", record)
        return record

    def profile(self):
        return candidate_profile.profile(self.user, self.uid)

    def test_all_specializations_and_highest_confirmed_grade_match_ranking(self):
        specializations.write(self.uid, 'Backend', 'Senior', {"type": 'LLM'})
        specializations.write(self.uid, 'Backend', 'Junior', {"type": 'Manual'})
        specializations.write(self.uid, 'QA', 'Junior', {"type": 'Manual'})
        self.add_result('Backend', 'Middle', True)
        self.add_result('Backend', 'Senior', False)
        self.add_result('QA', 'Junior', True)
        before = self.case.fixture._snapshot()
        result = self.profile()
        self.assertEqual(before, self.case.fixture._snapshot())
        specs = {r['name']: r for r in result['specializations']}
        self.assertEqual(specs['Backend']['declared'], 'Senior')
        self.assertEqual(specs['Backend']['source'], 'LLM')
        self.assertEqual(specs['Backend']['confirmed'], 'Middle')
        self.assertTrue(specs['Backend']['refuted'])
        self.assertEqual(specs['QA']['confirmed'], 'Junior')
        for r in ranking.applicants():
            if r['user_id'] == self.uid:
                expected = ranking.grade_fit(r)
                self.assertEqual(specs[r['specialization']]['confirmed'], expected['confirmed'])
                self.assertEqual(specs[r['specialization']]['refuted'], expected['refuted'])

    def test_saved_fsp_only_with_evidence_and_no_pending_or_private_identity(self):
        catalog, roles, stack = fsp._catalog()
        competition = next(c for c in catalog.values() if fsp._has_role(c, 'backend'))
        item = fsp.participate(competition, 'backend', stack, random.Random(8))
        record = {"user_id": self.uid, "fsp_id": 'FSP-1111-2222', "seed": 'private',
                  "role_id": 'backend', "linked_at": '2020-01-01T00:00:00+00:00',
                  "competitions": [item], "competencies": fsp.competencies([item]),
                  "declined": [{"competition_id": 'private_declined'}]}
        self.write(ranking.USER_FSP_DIR / f'{self.uid}.json', record)
        before = self.case.fixture._snapshot()
        result = self.profile()['fsp']
        self.assertEqual(before, self.case.fixture._snapshot())
        self.assertTrue(result['linked'])
        self.assertEqual([c['id'] for c in result['competitions']], [competition['id']])
        for entry in result['competencies']:
            self.assertEqual(entry['competitions'], [competition['id']])
            self.assertEqual(entry['name'], stack[entry['kind']][entry['id']]['name'])
        self.assertFalse({'seed', 'pending', 'fsp_id', 'declined'} & result.keys())

    def test_test_history_reconstructs_condition_and_preserves_credit_event(self):
        task = grade_tests.generate('Backend', 'Middle', rng=random.Random(12))
        failed = self.add_result('Backend', 'Middle', False, task_key=task['key'], language='Python',
                                  procedural_check=True, llm={"llm": 'example', "model": 'model'},
                                  created_at='2026-10-09T10:00:00+00:00')
        credit = self.add_result('Backend', 'Middle', True, task_key=task['key'], credited_from=failed['id'])
        self.add_result('QA', 'Junior', False, task_key='deleted/catalog/key')
        result = self.profile()
        rows = {r['id']: r for r in result['tests']}
        self.assertEqual(result['tests'][0]['created_at'], '2026-10-10T10:00:00+00:00')
        self.assertEqual(rows[failed['id']]['symptoms'], [r['symptom'] for r in task['problems']])
        self.assertTrue(rows[failed['id']]['llm_check'])
        self.assertTrue(rows[credit['id']]['credited'])
        self.assertFalse(rows[failed['id']]['credited'])
        self.assertTrue(any(r['symptoms'] == [] for r in result['tests']))
        self.assertFalse({'solutions', 'task_key', 'llm', 'credited_from', 'code'} & rows[failed['id']].keys())

    def test_contact_only_after_own_valid_acceptance_and_assignment_privacy(self):
        own = self.case.record(invitations.APPLICANT_TO_RECRUITER, 'task_sent_for_review',
                               applicant_id=self.uid, assignment=True, assignment_answers=['Своё решение'])
        self.case.record(invitations.RECRUITER_TO_APPLICANT, 'accepted', applicant_id=self.uid,
                         recruiter_id=self.case.fixture.another, assignment=True, assignment_answers=['Чужое решение'])
        result = self.profile()
        self.assertIsNone(result['email'])
        self.assertEqual([r['id'] for r in result['assignments']], [own['id']])
        self.assertEqual(result['assignments'][0]['answers'], ['Своё решение'])
        self.case.record(invitations.APPLICANT_TO_RECRUITER, 'accepted', applicant_id=self.uid, assignment=False)
        self.assertEqual(self.profile()['email'], f'{self.uid}@example.invalid')

    def test_missing_empty_or_damaged_optional_data_is_readable(self):
        result = self.profile()
        self.assertIsNone(result['name'])
        self.assertEqual(result['tests'], [])
        self.assertEqual(result['assignments'], [])
        self.assertFalse(result['fsp']['linked'])
        (ranking.USER_FSP_DIR / f'{self.uid}.json').write_text('broken', encoding='utf-8')
        (grade_tests.TESTS_DIR / 'broken.json').write_text('broken', encoding='utf-8')
        self.add_result('Backend', 'Senior', 'true')
        self.assertEqual(self.profile()['tests'], [])

    def test_blocked_candidate_available_only_via_own_valid_link(self):
        self.write(ranking.USER_BLOCKS_DIR / f'{self.uid}.json', {"user_id": self.uid})
        with self.assertRaises(users.UserError) as raised:
            self.profile()
        self.assertEqual(raised.exception.status, 404)
        self.case.record(invitations.RECRUITER_TO_APPLICANT, 'sent', applicant_id=self.uid, assignment=False)
        self.assertEqual(self.profile()['id'], self.uid)
        with self.assertRaises(users.UserError) as raised:
            candidate_profile.profile(self.case.fixture.another, self.uid)
        self.assertEqual(raised.exception.status, 404)

    def test_only_recruiter_and_existing_candidate_and_safe_identifiers(self):
        for recruiter, candidate, status in ((self.case.fixture.non_recruiter, self.uid, 403),
                (self.user, str(uuid.uuid4()), 404), (self.user, '../users/private', 400),
                (self.user, self.case.fixture.another, 404)):
            with self.subTest(candidate=candidate), self.assertRaises(users.UserError) as raised:
                candidate_profile.profile(recruiter, candidate)
            self.assertEqual(raised.exception.status, status)

    def test_http_endpoint_returns_projected_profile(self):
        server = serve.Server(('127.0.0.1', 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('GET', f'/api/applicants/profile?user_id={self.user}&applicant_id={self.uid}')
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            self.assertEqual(response.status, 200)
            self.assertEqual(data['id'], self.uid)
            self.assertFalse({'password', 'fsp_id', 'seed', 'source'} & data.keys())
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
