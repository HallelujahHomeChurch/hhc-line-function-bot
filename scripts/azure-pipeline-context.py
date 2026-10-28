#!/usr/bin/env python3
"""Export existing release-script outputs through Azure Pipelines logging commands."""
import json
import os
from pathlib import Path
import re
import sys


def read_values(path):
    values = {}
    file = Path(path)
    if not file.exists():
        return values
    for line in file.read_text().splitlines():
        if not line:
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", key):
            raise ValueError("invalid pipeline output")
        if key in values:
            raise ValueError("duplicate pipeline output")
        values[key] = value
    return values


def escape(value):
    return value.replace("%", "%AZP25").replace("\r", "%0D").replace("\n", "%0A")


def publish(environment, outputs):
    for key, value in environment.items():
        print(f"##vso[task.setvariable variable={key}]{escape(value)}")
    for key, value in outputs.items():
        key = key.replace("-", "_")
        if key == "matrix":
            groups = json.loads(value)
            if set(groups) != {"group"} or not groups["group"] or any(type(n) is not int or n < 0 for n in groups["group"]):
                raise ValueError("invalid extractor matrix")
            value = json.dumps({f"group_{n}": {"group": str(n)} for n in groups["group"]})
        print(f"##vso[task.setvariable variable={key};isOutput=true]{escape(value)}")


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "output"
        path.write_text("commit=abc\nimage=registry/image@sha256:123\n")
        assert read_values(path) == {"commit": "abc", "image": "registry/image@sha256:123"}
        for invalid in ["name<<EOF\nvalue\nEOF", "name=one\nname=two", "bad;isSecret=true=value"]:
            path.write_text(invalid)
            try:
                read_values(path)
            except ValueError:
                pass
            else:
                raise AssertionError("invalid output accepted")
    assert escape("%0A\r\n") == "%AZP250A%0D%0A"


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
    else:
        if os.environ.get("TF_BUILD", "").lower() != "true" or len(sys.argv) != 3:
            raise SystemExit("Azure Pipelines context required")
        publish(read_values(sys.argv[1]), read_values(sys.argv[2]))
