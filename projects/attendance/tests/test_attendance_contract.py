# -*- coding: utf-8 -*-
"""Backend contract tests for attendance submission."""

import unittest

from attendance_api import build_submit_payload
from server import normalize_absence_reasons


class AttendanceContractTest(unittest.TestCase):
    def test_absent_reason_maps_to_cause_id_and_name(self):
        course = {
            "students": [
                {
                    "ID": "student-1",
                    "Name": "测试学员",
                    "IsAttend": 1,
                    "IsCost": 1,
                }
            ],
            "Teacher": [],
        }
        payload = build_submit_payload(
            course,
            [],
            False,
            absence_reasons={"student-1": "病假"},
            absence_causes=[
                {"ID": "cause-sick", "Value": "02-病假"},
            ],
        )
        student = payload["Students"][0]
        self.assertEqual(student["IsAttend"], 0)
        self.assertEqual(student["AbsentCauseID"], "cause-sick")
        self.assertEqual(student["AbsentCauseName"], "02-病假")

    def test_normalize_absence_reasons_rejects_unknown_reason(self):
        self.assertEqual(
            normalize_absence_reasons({"student-1": "事假"}),
            {"student-1": "事假"},
        )
        with self.assertRaises(ValueError):
            normalize_absence_reasons({"student-1": "未知原因"})


if __name__ == "__main__":
    unittest.main()
