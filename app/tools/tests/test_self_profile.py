"""Собственный профиль и PDF: владение, отсутствие записей и полная выгрузка."""

import http.client
import io
import json
import sys
import threading
import unittest
import uuid
from pathlib import Path
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import candidate_profile
import invitations
import profile_pdf
import projects
import serve
from users import UserError
import test_candidate_profile as fixtures


class SelfProfile(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CandidateProfile()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.uid = self.fixture.uid

    def test_same_profile_evidence_as_recruiter_with_own_contact(self):
        self.fixture.add_result('Backend', 'Middle', True)
        before = self.fixture.case.fixture._snapshot()
        own = candidate_profile.self_profile(self.uid)
        recruiter = self.fixture.profile()
        self.assertEqual(own['email'], f'{self.uid}@example.invalid')
        for field in ('id', 'name', 'specializations', 'fsp', 'tests', 'assignments'):
            self.assertEqual(own[field], recruiter[field])
        self.assertEqual(before, self.fixture.case.fixture._snapshot())

    def test_own_assignments_from_both_directions_and_all_recruiters_survive_deleted_project(self):
        case = self.fixture.case
        first = case.record(invitations.APPLICANT_TO_RECRUITER, 'task_sent_for_review', assignment=True,
                            applicant_id=self.uid, assignment_answers=['Первое решение'])
        second = case.record('Рекрутёр - Соискатель', 'solution_rejected', assignment=True,
                             applicant_id=self.uid, recruiter_id=case.fixture.another, assignment_answers=['Второе решение'])
        case.record(invitations.RECRUITER_TO_APPLICANT, 'accepted', assignment=True,
                    applicant_id=case.fixture.non_recruiter, assignment_answers=['Чужое решение'])
        projects._project_path(first['project_id']).unlink()
        own = candidate_profile.self_profile(self.uid)
        self.assertEqual({r['id'] for r in own['assignments']}, {first['id'], second['id']})
        self.assertEqual({r['answers'][0] for r in own['assignments']}, {'Первое решение', 'Второе решение'})

    def test_missing_or_unsafe_user_is_rejected(self):
        for uid, status in ((None, 400), ('../private', 400), (str(uuid.uuid4()), 404)):
            with self.subTest(uid=uid), self.assertRaises(UserError) as raised:
                candidate_profile.self_profile(uid)
            self.assertEqual(raised.exception.status, status)

    def test_pdf_cyrillic_passed_tests_and_long_condition_pagination(self):
        self.fixture.add_result('Backend', 'Middle', True)
        own = candidate_profile.self_profile(self.uid)
        own['name'] = 'Александр Морозов'
        own['tests'][0]['symptoms'] = ['ОченьДлинноеСлово' * 250 + '\nПоследняя строка условия']
        pdf = PdfReader(io.BytesIO(profile_pdf.render(own)))
        text = '\n'.join(page.extract_text() for page in pdf.pages)
        self.assertGreater(len(pdf.pages), 1)
        for value in ('Александр Морозов', 'СПЕЦИАЛИЗАЦИИ И ГРЕЙДЫ', '■ Middle', 'ТЕСТЫ НА ГРЕЙД',
                      'Backend / Middle', 'Последняя строка условия', f'{self.uid}@example.invalid'):
            self.assertIn(value, text)
        # Строки условия идут с отступом; заголовок окна между страницами в счёт не входит.
        condition = ''.join(line.strip() for line in text.split('\n') if line.startswith('    '))
        self.assertEqual(condition.count('ОченьДлинноеСлово'), 250)
        self.assertAlmostEqual(float(pdf.pages[0].mediabox.width), profile_pdf.WIDTH, places=4)

    def test_empty_profile_has_readable_pdf(self):
        own = candidate_profile.self_profile(self.uid)
        own.update(name=None, specializations=[], tests=[], assignments=[],
                   fsp={'linked': False, 'linked_at': None, 'competencies': [], 'competitions': []})
        pdf = PdfReader(io.BytesIO(profile_pdf.render(own)))
        self.assertEqual(len(pdf.pages), 1)
        self.assertIn('Имя не указано', pdf.pages[0].extract_text())

    def test_http_download_and_json_always_use_current_user_without_mutations(self):
        server = serve.Server(('127.0.0.1', 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        before = self.fixture.case.fixture._snapshot()
        try:
            for suffix in ('', '/pdf'):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                connection.request('GET', f'/api/applicant/profile{suffix}?user_id={self.uid}&applicant_id={self.fixture.user}')
                response = connection.getresponse()
                body = response.read()
                self.assertEqual(response.status, 200)
                self.assertIn('no-store', response.getheader('Cache-Control'))
                if suffix:
                    self.assertEqual(response.getheader('Content-Type'), 'application/pdf')
                    self.assertIn('attachment;', response.getheader('Content-Disposition'))
                    self.assertEqual(int(response.getheader('Content-Length')), len(body))
                    self.assertIn(f'{self.uid}@example.invalid', PdfReader(io.BytesIO(body)).pages[0].extract_text())
                else:
                    self.assertEqual(json.loads(body)['id'], self.uid)
                connection.close()
            self.assertEqual(before, self.fixture.case.fixture._snapshot())
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
