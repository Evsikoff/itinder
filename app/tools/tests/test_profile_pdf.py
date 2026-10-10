"""PDF-резюме: только сданные тесты на грейд, без заданий вакансий; выгрузка рекрутёра."""

import http.client
import io
import json
import sys
import threading
import unittest
from pathlib import Path
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import candidate_profile
import invitations
import profile_pdf
import ranking
import serve
import specializations
import test_candidate_profile as fixtures


def text(data):
    return '\n'.join(page.extract_text() for page in PdfReader(io.BytesIO(data)).pages)


class ProfilePdf(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CandidateProfile()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.uid, self.recruiter = self.fixture.uid, self.fixture.user
        self.case = self.fixture.case

    def get(self, path):
        server = serve.Server(('127.0.0.1', 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('GET', path)
            response = connection.getresponse()
            body = response.read()
            connection.close()
            return response, body
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_only_passed_grade_tests_and_no_vacancy_assignments(self):
        specializations.write(self.uid, 'Backend', 'Senior', {"type": 'LLM'})
        self.fixture.add_result('Backend', 'Middle', True, created_at='2026-10-08T10:00:00+00:00')
        self.fixture.add_result('Backend', 'Senior', False, created_at='2026-10-09T10:00:00+00:00')
        self.case.record(invitations.APPLICANT_TO_RECRUITER, 'task_sent_for_review', assignment=True,
                         applicant_id=self.uid, assignment_answers=['Решение задачи вакансии'])
        for data in (profile_pdf.export(self.uid), profile_pdf.export_candidate(self.recruiter, self.uid)):
            content = text(data)
            self.assertIn('Backend / Middle', content)
            self.assertIn('Сдано тестов на грейд: 1', content)
            self.assertIn('Senior · из резюме', content)
            for hidden in ('Backend / Senior', 'Решение задачи вакансии', 'ЗАДАНИЯ', 'Не пройден',
                           'не подтверждается', 'FAIL'):
                self.assertNotIn(hidden, content)

    def test_specialization_known_only_from_failed_attempts_is_left_out(self):
        specializations.write(self.uid, 'Backend', 'Middle', {"type": 'Manual'})
        self.fixture.add_result('QA', 'Junior', False)
        own = candidate_profile.self_profile(self.uid)
        self.assertIn('QA', {s['name'] for s in own['specializations']})
        content = text(profile_pdf.render(own))
        self.assertIn('Backend', content)
        self.assertNotIn('QA', content)
        self.assertIn('Сданных тестов на грейд пока нет.', content)

    def test_recruiter_download_uses_profile_access_and_hides_contact_until_acceptance(self):
        before = self.case.fixture._snapshot()
        response, body = self.get(f'/api/applicants/profile/pdf?user_id={self.recruiter}&applicant_id={self.uid}')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Type'), 'application/pdf')
        self.assertIn('attachment;', response.getheader('Content-Disposition'))
        self.assertEqual(int(response.getheader('Content-Length')), len(body))
        content = text(body)
        self.assertIn('candidate --export pdf', content)
        self.assertIn('откроется после принятия приглашения или отклика', content)
        self.assertNotIn(f'{self.uid}@example.invalid', content)
        self.assertEqual(before, self.case.fixture._snapshot())

        self.case.record(invitations.APPLICANT_TO_RECRUITER, 'accepted', applicant_id=self.uid, assignment=False)
        self.assertIn(f'{self.uid}@example.invalid', text(profile_pdf.export_candidate(self.recruiter, self.uid)))

        response, body = self.get(f'/api/applicants/profile/pdf?user_id={self.case.fixture.non_recruiter}&applicant_id={self.uid}')
        self.assertEqual(response.status, 403)
        self.assertIn('error', json.loads(body))

    def test_hidden_candidate_pdf_only_for_recruiter_with_link(self):
        (ranking.USER_BLOCKS_DIR / f'{self.uid}.json').write_text(json.dumps({"user_id": self.uid}), encoding='utf-8')
        response, _ = self.get(f'/api/applicants/profile/pdf?user_id={self.recruiter}&applicant_id={self.uid}')
        self.assertEqual(response.status, 404)
        self.case.record(invitations.RECRUITER_TO_APPLICANT, 'sent', applicant_id=self.uid, assignment=False)
        response, body = self.get(f'/api/applicants/profile/pdf?user_id={self.recruiter}&applicant_id={self.uid}')
        self.assertEqual(response.status, 200)
        self.assertEqual(len(PdfReader(io.BytesIO(body)).pages), 1)


if __name__ == '__main__':
    unittest.main()
