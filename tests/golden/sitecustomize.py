"""Refuse to load the repo's real config.yaml.

`api.py` opens the relative path `config.yaml`, i.e. whatever the process cwd
holds. The harness always runs from a temp cwd containing a synthetic config,
but if anything ever runs it from the repo root, the real secrets file would
be parsed. That must fail loudly instead of silently working.

Importing this module installs the guard; it patches `yaml.safe_load` to
raise when the parsed mapping looks like the production config (it carries
the harness's `test_marker` key only in synthetic configs).
"""
import yaml

_REAL_LOAD = yaml.safe_load


def _guarded_safe_load(stream, *args, **kwargs):
    data = _REAL_LOAD(stream, *args, **kwargs)
    if isinstance(data, dict) and "database" in data and "test_marker" not in data:
        raise RuntimeError(
            "refusing to load a config.yaml without test_marker: "
            "tests must run from a temp cwd with a synthetic config, "
            "never the repo's real config.yaml"
        )
    return data


yaml.safe_load = _guarded_safe_load
