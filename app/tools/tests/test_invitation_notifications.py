"""HTTP и значок 4: интеграционные проверки без изменений реальной app/db."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_icons
import invitations
import ranking
import serve
import specializations


class QuietHandler(serve.Handler):
    def log_message(self, *args):
        pass


class InvitationIntegration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ittinder-invitation-http-")
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name)
        for module, name, folder in (
            (invitations, "INVITATIONS_DIR", "invitations"),
            (specializations, "USERS_DIR", "users"),
            (ranking, "USER_NAMES_DIR", "names"),
        ):
            replacement = patch.object(module, name, self.db / folder)
            replacement.start()
            self.addCleanup(replacement.stop)
            (self.db / folder).mkdir()
        self.user, self.other = (str(uuid.uuid4()) for _ in range(2))
        for user_id in (self.user, self.other):
            (specializations.USERS_DIR / f"{user_id}.json").write_text(
                json.dumps({"id": user_id}), encoding="utf-8")
        self.record = {
            "id": str(uuid.uuid4()), "applicant_id": self.user,
            "recruiter_id": str(uuid.uuid4()), "type": invitations.RECRUITER_TO_APPLICANT,
            "flow": "plain", "created_at": "2026-10-09T10:00:00+00:00",
            "vacancy": {"title": "Разработчик", "assignments": []},
            "status_history": [{"status": "sent", "at": "2026-10-09T10:00:00+00:00"}],
        }
        self.path = invitations.INVITATIONS_DIR / f"{self.record['id']}.json"
        self.save(self.record)

    def save(self, record):
        self.path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

    def test_desktop_alert_polling_continues_after_all_statuses_are_seen(self):
        with patch.object(desktop_icons, "modes", return_value=["Applicant"]), \
                patch.object(desktop_icons.grade_tests, "has_confirmed_grade", return_value=True), \
                patch.object(desktop_icons.fsp, "alert", return_value=(None, None)):
            def icon(result):
                return next(item for item in result["icons"] if item["id"] == 4)

            result = desktop_icons.for_user(self.user)
            self.assertIsNotNone(icon(result)["alert"])
            self.assertEqual(result["recheck_after"], 15)
            self.assertEqual(icon(result)["name"], "Приглашения")
            self.assertEqual(icon(result)["image"], "/app/assets/vac.png")
            serve.applicant_invitations.read(self.user, self.record["id"], 1)
            result = desktop_icons.for_user(self.user)
            self.assertIsNone(icon(result)["alert"])
            self.assertEqual(result["recheck_after"], 15)
            changed = json.loads(self.path.read_text(encoding="utf-8"))
            changed["status_history"].append({"status": "accepted", "at": "2026-10-09T11:00:00+00:00"})
            self.save(changed)
            self.assertIsNotNone(icon(desktop_icons.for_user(self.user))["alert"])
            with patch.object(desktop_icons.fsp, "alert", return_value=("ФСП", 4)):
                self.assertEqual(desktop_icons.for_user(self.user)["recheck_after"], 4)

    def test_recruiter_mode_does_not_receive_candidate_notification(self):
        with patch.object(desktop_icons, "modes", return_value=["Recruiter"]), \
                patch.object(desktop_icons.grade_tests, "has_confirmed_grade", return_value=True), \
                patch.object(desktop_icons.applicant_invitations, "alert") as alert:
            result = desktop_icons.for_user(self.user)
        alert.assert_not_called()
        self.assertNotIn(4, [item["id"] for item in result["icons"]])

    def test_http_read_respond_and_conflicts_preserve_persisted_history(self):
        server = serve.Server(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.addCleanup(stop)
        port = server.server_address[1]

        def request(method, route, data=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
            connection.request(method, route, body=body,
                               headers=headers or {"Content-Type": "application/json"})
            response = connection.getresponse()
            result = response.status, json.loads(response.read().decode("utf-8"))
            connection.close()
            return result

        route = "/api/applicant/invitations"
        before = self.path.read_bytes()
        code, listed = request("GET", f"{route}?user_id={self.user}")
        self.assertEqual(code, 200)
        self.assertEqual(listed["invitations"][0]["vacancy"]["title"], "Разработчик")
        self.assertEqual(self.path.read_bytes(), before)
        code, foreign = request("GET", f"{route}?user_id={self.other}")
        self.assertEqual((code, foreign["invitations"]), (200, []))
        payload = {"user_id": self.user, "invitation_id": self.record["id"], "expected_revision": 1}
        code, viewed = request("POST", f"{route}/read", payload)
        self.assertEqual((code, viewed["status"], viewed["revision"], viewed["unseen"]), (200, "read", 2, False))
        payload["action"] = "accept"
        self.assertEqual(request("POST", f"{route}/respond", payload)[0], 409)
        payload["expected_revision"] = viewed["revision"]
        code, accepted = request("POST", f"{route}/respond", payload)
        self.assertEqual((code, accepted["status"]), (200, "accepted"))
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual([entry["status"] for entry in saved["status_history"]], ["sent", "read", "accepted"])
        self.assertEqual(saved["vacancy"], self.record["vacancy"])
        existing = self.path.read_bytes()
        code, generated = request("POST", f"{route}/test-data", {"user_id": self.user})
        self.assertEqual((code, generated["created_invitations"]), (201, 20))
        self.assertEqual(len(set(generated["invitation_ids"])), 20)
        self.assertEqual(self.path.read_bytes(), existing)
        code, listed = request("GET", f"{route}?user_id={self.user}")
        self.assertEqual((code, len(listed["invitations"])), (200, 21))
        self.assertEqual(sum(item["unseen"] for item in listed["invitations"]), 20)
        self.assertEqual(request("GET", f"{route}?user_id={self.other}")[1]["invitations"], [])
        payload["user_id"] = self.other
        self.assertEqual(request("POST", f"{route}/read", payload)[0], 404)
        self.assertEqual(request("POST", f"{route}/respond", headers=
                                 {"Content-Type": "application/json", "Origin": "http://example.org"})[0], 403)
        self.assertEqual(request("POST", f"{route}/respond", headers={
            "Content-Type": "application/json", "Content-Length": str(serve.applicant_invitations.MAX_BODY + 1),
        })[0], 413)


if __name__ == "__main__":
    unittest.main()
