#!/usr/bin/env python3
"""Check that the attachment app KEDA cron rules cover every scheduled meeting.

The warm windows are hard-coded in aca.attachment-worker-app.yaml. This check
compares them with the public meeting occurrences so a changed meeting time is
noticed before the worker is cold during a meeting.

Exit codes: 0 covered, 1 coverage gap (report written), 2 invalid input.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import sys
import urllib.request

try:
    from zoneinfo import ZoneInfo

    TAIPEI = ZoneInfo("Asia/Taipei")
except Exception:  # pragma: no cover - runners without tzdata
    # Asia/Taipei has had no DST since 1979.
    TAIPEI = dt.timezone(dt.timedelta(hours=8), "Asia/Taipei")

DEFAULT_URL = "https://www.alive.org.tw/api/meeting-occurrences"
DEFAULT_MANIFEST = Path(__file__).resolve().parent.parent / "aca.attachment-worker-app.yaml"
LEAD = dt.timedelta(minutes=5)
TAIL = dt.timedelta(minutes=10)
HORIZON = dt.timedelta(days=28)
ISSUE_TITLE = "Meeting cron drift: attachment app"
CRON_PATTERN = re.compile(r"^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$")
DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]


class DriftInputError(Exception):
    pass


def parse_cron(expression):
    """Parse only the `M H * * D[,D]` shape used by the attachment app."""
    match = CRON_PATTERN.fullmatch(expression.strip())
    if not match:
        raise DriftInputError(f"unsupported cron expression: {expression!r}")
    minute, hour = int(match.group(1)), int(match.group(2))
    if minute > 59 or hour > 23:
        raise DriftInputError(f"cron time out of range: {expression!r}")
    days = [int(day) for day in match.group(3).split(",")]
    if len(set(days)) != len(days):
        raise DriftInputError(f"duplicate cron weekday: {expression!r}")
    return hour * 60 + minute, frozenset(days)


def _parse_mapping(lines, index, indent):
    """Parse a block mapping of `key: value` / `key:` lines at exactly `indent`."""
    result = {}
    while index < len(lines):
        line_indent, text = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent or text.startswith("- "):
            raise DriftInputError(f"unsupported scale rule YAML: {text!r}")
        key, separator, value = text.partition(":")
        if not separator:
            raise DriftInputError(f"unsupported scale rule YAML: {text!r}")
        key, value = key.strip(), value.strip()
        index += 1
        if value:
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[key] = value
        elif index < len(lines) and lines[index][0] > indent:
            result[key], index = _parse_mapping(lines, index, lines[index][0])
        else:
            result[key] = None
    return result, index


def scale_rules(manifest_text):
    """Return the `properties.template.scale.rules` items of the ACA manifest."""
    raw = manifest_text.splitlines()
    starts = [i for i, line in enumerate(raw) if line.strip() == "rules:"]
    if len(starts) != 1:
        raise DriftInputError("manifest must contain exactly one scale rules list")
    rules_indent = len(raw[starts[0]]) - len(raw[starts[0]].lstrip())
    lines = []
    for line in raw[starts[0] + 1 :]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= rules_indent and not stripped.startswith("- "):
            break
        if indent < rules_indent:
            break
        lines.append((indent, stripped))
    rules = []
    index = 0
    while index < len(lines):
        indent, text = lines[index]
        if not text.startswith("- "):
            raise DriftInputError(f"unsupported scale rule YAML: {text!r}")
        item_indent = indent + 2
        body = [(item_indent, text[2:])]
        index += 1
        while index < len(lines) and not (lines[index][0] == indent and lines[index][1].startswith("- ")):
            body.append(lines[index])
            index += 1
        rule, consumed = _parse_mapping(body, 0, item_indent)
        if consumed != len(body):
            raise DriftInputError("unsupported scale rule YAML")
        rules.append(rule)
    return rules


def cron_rules(manifest_text):
    """Return validated KEDA cron windows as dictionaries."""
    windows = []
    for rule in scale_rules(manifest_text):
        custom = rule.get("custom")
        if not isinstance(custom, dict) or custom.get("type") != "cron":
            continue
        name = rule.get("name")
        metadata = custom.get("metadata")
        if not isinstance(name, str) or not isinstance(metadata, dict):
            raise DriftInputError(f"cron rule is malformed: {name!r}")
        if set(metadata) != {"timezone", "start", "end", "desiredReplicas"}:
            raise DriftInputError(f"cron rule {name} has unexpected metadata keys")
        if metadata["timezone"] != "Asia/Taipei":
            raise DriftInputError(f"cron rule {name} must use Asia/Taipei")
        if metadata["desiredReplicas"] != "1":
            raise DriftInputError(f"cron rule {name} must request one replica")
        start, start_days = parse_cron(metadata["start"])
        end, end_days = parse_cron(metadata["end"])
        if start_days != end_days or end <= start:
            raise DriftInputError(f"cron rule {name} must start and end on the same day")
        windows.append(
            {
                "name": name,
                "start": start,
                "end": end,
                "days": start_days,
                "startExpression": metadata["start"],
                "endExpression": metadata["end"],
            }
        )
    if not windows:
        raise DriftInputError("manifest has no cron scale rules")
    return windows


def _instant(value, field):
    if not isinstance(value, str):
        raise DriftInputError(f"occurrence {field} is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise DriftInputError(f"occurrence {field} is not ISO-8601") from error
    if parsed.tzinfo is None:
        raise DriftInputError(f"occurrence {field} has no offset")
    return parsed


def occurrence_items(payload):
    """Accept a bare list or a single-list envelope such as {"occurrences": [...]}."""
    if isinstance(payload, dict):
        for key in ("occurrences", "items", "data"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
    if not isinstance(payload, list):
        raise DriftInputError("meeting occurrences response is not a list")
    for item in payload:
        if not isinstance(item, dict):
            raise DriftInputError("meeting occurrence is not an object")
    return payload


def upcoming(payload, now):
    """Scheduled occurrences that have not finished and start within the horizon."""
    selected = []
    for item in occurrence_items(payload):
        if item.get("status") != "scheduled":
            continue
        starts_at = _instant(item.get("startsAt"), "startsAt")
        ends_at = _instant(item.get("endsAt"), "endsAt")
        if ends_at <= starts_at:
            raise DriftInputError("occurrence ends before it starts")
        if ends_at + TAIL <= now or starts_at > now + HORIZON:
            continue
        selected.append({**item, "_start": starts_at, "_end": ends_at})
    return sorted(selected, key=lambda item: item["_start"])


def required_window(occurrence):
    start = (occurrence["_start"] - LEAD).astimezone(TAIPEI)
    end = (occurrence["_end"] + TAIL).astimezone(TAIPEI)
    return start, end


def covering_rule(occurrence, windows):
    start, end = required_window(occurrence)
    if start.date() != end.date():
        return None
    weekday = (start.weekday() + 1) % 7  # cron: 0 = Sunday
    start_minute = start.hour * 60 + start.minute
    end_minute = end.hour * 60 + end.minute + (1 if end.second or end.microsecond else 0)
    for window in windows:
        if weekday in window["days"] and window["start"] <= start_minute and end_minute <= window["end"]:
            return window
    return None


def suggested_rule(occurrence):
    start, end = required_window(occurrence)
    weekday = (start.weekday() + 1) % 7
    end_ceiling = end + dt.timedelta(minutes=1) if end.second or end.microsecond else end
    return {
        "name": f"{DAY_NAMES[weekday]}-{start.hour:02d}{start.minute:02d}",
        "start": f"{start.minute} {start.hour} * * {weekday}",
        "end": f"{end_ceiling.minute} {end_ceiling.hour} * * {weekday}",
    }


def check(payload, manifest_text, now):
    windows = cron_rules(manifest_text)
    occurrences = upcoming(payload, now)
    gaps = []
    for occurrence in occurrences:
        if covering_rule(occurrence, windows) is None:
            gaps.append(occurrence)
    return {"windows": windows, "occurrences": occurrences, "gaps": gaps}


def render_report(result, now):
    lines = [
        "The attachment app KEDA cron rules in `aca.attachment-worker-app.yaml` do not cover",
        "every scheduled meeting occurrence (5 minutes before start to 10 minutes after end,",
        "Asia/Taipei). Edit the cron rules and release, or confirm the meeting schedule.",
        "",
        f"Checked at {now.astimezone(TAIPEI).isoformat(timespec='minutes')} for the next 28 days.",
        "",
        "| meetingKey | startsAt | endsAt | suggested rule |",
        "|---|---|---|---|",
    ]
    for gap in result["gaps"]:
        rule = suggested_rule(gap)
        lines.append(
            "| {key} | {start} | {end} | `{name}`: start `{rule_start}`, end `{rule_end}` |".format(
                key=str(gap.get("meetingKey") or "unknown"),
                start=gap["_start"].astimezone(TAIPEI).isoformat(timespec="minutes"),
                end=gap["_end"].astimezone(TAIPEI).isoformat(timespec="minutes"),
                name=rule["name"],
                rule_start=rule["start"],
                rule_end=rule["end"],
            )
        )
    lines += ["", "Suggested YAML (merge with existing rules as appropriate):", "", "```yaml"]
    seen = set()
    for gap in result["gaps"]:
        rule = suggested_rule(gap)
        if rule["name"] in seen:
            continue
        seen.add(rule["name"])
        lines += [
            f"- name: {rule['name']}",
            "  custom:",
            "    type: cron",
            "    metadata:",
            "      timezone: Asia/Taipei",
            f"      start: \"{rule['start']}\"",
            f"      end: \"{rule['end']}\"",
            "      desiredReplicas: \"1\"",
        ]
    lines.append("```")
    return "\n".join(lines) + "\n"


def fetch(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise DriftInputError(f"meeting occurrences returned HTTP {response.status}")
        return json.load(response)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--input", type=Path, help="read occurrences JSON from a file instead")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--report", type=Path, help="write a Markdown gap report here")
    parser.add_argument("--now", help="ISO-8601 instant (testing)")
    args = parser.parse_args(argv)
    try:
        now = _instant(args.now, "now") if args.now else dt.datetime.now(dt.timezone.utc)
        payload = json.loads(args.input.read_text(encoding="utf-8")) if args.input else fetch(args.url)
        result = check(payload, args.manifest.read_text(encoding="utf-8"), now)
    except (DriftInputError, OSError, ValueError) as error:
        print(f"meeting cron drift check failed: {error}", file=sys.stderr)
        return 2
    for window in result["windows"]:
        print(f"rule {window['name']}: {window['startExpression']} -> {window['endExpression']}")
    for occurrence in result["occurrences"]:
        status = "GAP" if occurrence in result["gaps"] else "covered"
        start = occurrence["_start"].astimezone(TAIPEI).isoformat(timespec="minutes")
        print(f"{status}: {occurrence.get('meetingKey')} {start}")
    print(f"{len(result['occurrences'])} scheduled occurrences, {len(result['gaps'])} gaps")
    if not result["gaps"]:
        return 0
    if args.report:
        args.report.write_text(render_report(result, now), encoding="utf-8")
    return 1


if __name__ == "__main__":
    sys.exit(main())
