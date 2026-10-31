#!/usr/bin/env python3
"""Offline tests for the attachment app meeting cron drift check."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("meeting_cron_drift", ROOT / "scripts" / "meeting-cron-drift.py")
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)

# Sunday 2026-11-01 00:00 Asia/Taipei.
NOW = dt.datetime(2026, 10, 31, 16, 0, tzinfo=dt.timezone.utc)

MANIFEST = """properties:
  template:
    scale:
      minReplicas: 0
      rules:
        - name: attachment-work
          azureQueue:
            queueName: PLACEHOLDER
            queueLength: 1
        # comment lines are ignored
        - name: tue-fri-0625
          custom:
            type: cron
            metadata:
              timezone: Asia/Taipei
              start: "25 6 * * 2,5"
              end: "40 8 * * 2,5"
              desiredReplicas: "1"
        - name: sun-0855
          custom:
            type: cron
            metadata:
              timezone: Asia/Taipei
              start: "55 8 * * 0"
              end: "10 12 * * 0"
              desiredReplicas: "1"
    containers:
      - name: worker
"""


def occurrence(starts_at, ends_at, status="scheduled", key="meeting"):
    return {"meetingKey": key, "startsAt": starts_at, "endsAt": ends_at, "status": status}


class MeetingCronDriftTest(unittest.TestCase):
    def gaps(self, *occurrences):
        result = drift.check(list(occurrences), MANIFEST, NOW)
        return [item["meetingKey"] for item in result["gaps"]], result

    def test_parses_only_cron_rules(self):
        names = [rule["name"] for rule in drift.cron_rules(MANIFEST)]
        self.assertEqual(names, ["tue-fri-0625", "sun-0855"])

    def test_covered_occurrence(self):
        gaps, result = self.gaps(
            occurrence("2026-11-03T06:30:00+08:00", "2026-11-03T08:30:00+08:00", key="tue"),
            occurrence("2026-11-06T06:30:00+08:00", "2026-11-06T08:30:00+08:00", key="fri"),
            occurrence("2026-11-01T01:00:00Z", "2026-11-01T04:00:00Z", key="sun-utc"),
        )
        self.assertEqual(gaps, [])
        self.assertEqual(len(result["occurrences"]), 3)

    def test_occurrence_starting_before_window(self):
        gaps, _ = self.gaps(occurrence("2026-11-03T06:29:00+08:00", "2026-11-03T08:30:00+08:00", key="early"))
        self.assertEqual(gaps, ["early"])

    def test_occurrence_ending_after_window(self):
        gaps, _ = self.gaps(occurrence("2026-11-03T06:30:00+08:00", "2026-11-03T08:31:00+08:00", key="late"))
        self.assertEqual(gaps, ["late"])

    def test_wrong_weekday(self):
        gaps, _ = self.gaps(occurrence("2026-11-04T06:30:00+08:00", "2026-11-04T08:30:00+08:00", key="wed"))
        self.assertEqual(gaps, ["wed"])

    def test_non_scheduled_ignored(self):
        gaps, result = self.gaps(
            occurrence("2026-11-04T06:30:00+08:00", "2026-11-04T08:30:00+08:00", status="cancelled", key="x")
        )
        self.assertEqual(gaps, [])
        self.assertEqual(result["occurrences"], [])

    def test_outside_horizon_and_finished_ignored(self):
        gaps, result = self.gaps(
            occurrence("2026-12-02T06:30:00+08:00", "2026-12-02T08:30:00+08:00", key="far"),
            occurrence("2026-10-28T06:30:00+08:00", "2026-10-28T08:30:00+08:00", key="past"),
        )
        self.assertEqual(gaps, [])
        self.assertEqual(result["occurrences"], [])

    def test_accepts_envelope(self):
        payload = {"occurrences": [occurrence("2026-11-04T06:30:00+08:00", "2026-11-04T08:30:00+08:00")]}
        self.assertEqual(len(drift.check(payload, MANIFEST, NOW)["gaps"]), 1)

    def test_rejects_unsupported_cron(self):
        for expression in ["*/5 6 * * 2", "25 6 1 * 2", "25 6 * * 1-5", "25 6 * * 7", "60 6 * * 2", "25 6 * *"]:
            with self.subTest(expression=expression), self.assertRaises(drift.DriftInputError):
                drift.parse_cron(expression)
        broken = MANIFEST.replace('end: "10 12 * * 0"', 'end: "10 12 * * 1"')
        with self.assertRaises(drift.DriftInputError):
            drift.cron_rules(broken)
        wrong_zone = MANIFEST.replace("timezone: Asia/Taipei", "timezone: UTC", 1)
        with self.assertRaises(drift.DriftInputError):
            drift.cron_rules(wrong_zone)

    def test_rejects_malformed_payload(self):
        for payload in [{"unexpected": 1}, [1], [occurrence("not-a-date", "2026-11-04T08:30:00+08:00")]]:
            with self.subTest(payload=payload), self.assertRaises(drift.DriftInputError):
                drift.check(payload, MANIFEST, NOW)

    def test_suggested_rule(self):
        item = drift.upcoming([occurrence("2026-11-04T19:00:00+08:00", "2026-11-04T21:30:00+08:00")], NOW)[0]
        self.assertEqual(
            drift.suggested_rule(item), {"name": "wed-1855", "start": "55 18 * * 3", "end": "40 21 * * 3"}
        )

    def test_main_exit_codes_and_report(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            manifest = base / "app.yaml"
            manifest.write_text(MANIFEST, encoding="utf-8")
            report = base / "report.md"
            covered = base / "covered.json"
            covered.write_text(
                json.dumps([occurrence("2026-11-03T06:30:00+08:00", "2026-11-03T08:30:00+08:00")]),
                encoding="utf-8",
            )
            gap = base / "gap.json"
            gap.write_text(
                json.dumps([occurrence("2026-11-04T06:30:00+08:00", "2026-11-04T08:30:00+08:00", key="wed")]),
                encoding="utf-8",
            )
            invalid = base / "invalid.json"
            invalid.write_text("{}", encoding="utf-8")
            common = ["--manifest", str(manifest), "--report", str(report), "--now", NOW.isoformat()]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(drift.main(["--input", str(covered), *common]), 0)
                self.assertFalse(report.exists())
                self.assertEqual(drift.main(["--input", str(gap), *common]), 1)
                self.assertEqual(drift.main(["--input", str(invalid), *common]), 2)
            text = report.read_text(encoding="utf-8")
            self.assertIn("| wed | 2026-11-04T06:30+08:00", text)
            self.assertIn('start: "25 6 * * 3"', text)

    def test_repository_manifest_parses(self):
        names = [rule["name"] for rule in drift.cron_rules(drift.DEFAULT_MANIFEST.read_text(encoding="utf-8"))]
        self.assertEqual(names, ["tue-fri-0625", "thu-1155", "fri-1855", "sat-0855", "sun-0855"])


if __name__ == "__main__":
    unittest.main()
