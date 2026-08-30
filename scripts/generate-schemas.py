#!/usr/bin/env python3
"""Generate JSON schemas for Jumpstarter YAML config files.

Run this INSIDE a Python environment that has the ``jumpstarter`` package
installed (any venv where ``import jumpstarter.config`` works), e.g.:

    /path/to/jumpstarter/python/.venv/bin/python scripts/generate-schemas.py

It emits, next to this repo's root:

    schemas/client-config.schema.json    (clients/<alias>.yaml)
    schemas/exporter-config.schema.json  (exporters/<alias>.yaml)
    schemas/user-config.schema.json      (config.yaml)

The schemas are derived from the pydantic models via
``model_json_schema(by_alias=True)`` with two adjustments so they describe
the *on-disk* YAML rather than the in-memory model:

- ``alias`` and ``path`` are runtime-only fields (excluded when the CLI
  saves configs), so they are stripped from every object schema.
- ``config.current-client`` in the user config is serialized as the client
  ALIAS string (or null), not as an embedded client object, so the property
  is rewritten to ``string | null`` and unreferenced definitions pruned.
"""

import json
import sys
from pathlib import Path

try:
    from jumpstarter.config.client import ClientConfigV1Alpha1
    from jumpstarter.config.exporter import ExporterConfigV1Alpha1
    from jumpstarter.config.user import UserConfigV1Alpha1
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "error: could not import jumpstarter.config models: %s\n"
        "Run this script with a Python interpreter from an environment that\n"
        "has the jumpstarter package installed.\n" % exc
    )
    sys.exit(1)

RUNTIME_ONLY_PROPERTIES = ("alias", "path")

SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema#"


def strip_runtime_properties(node):
    """Recursively remove runtime-only properties from every object schema."""
    if isinstance(node, dict):
        props = node.get("properties")
        if isinstance(props, dict):
            for name in RUNTIME_ONLY_PROPERTIES:
                props.pop(name, None)
        required = node.get("required")
        if isinstance(required, list):
            node["required"] = [r for r in required if r not in RUNTIME_ONLY_PROPERTIES]
            if not node["required"]:
                del node["required"]
        for value in node.values():
            strip_runtime_properties(value)
    elif isinstance(node, list):
        for item in node:
            strip_runtime_properties(item)


def prune_unreferenced_defs(schema):
    """Drop $defs entries that nothing references (repeat until stable)."""
    while True:
        defs = schema.get("$defs")
        if not isinstance(defs, dict):
            return
        blob_without_defs = json.dumps({k: v for k, v in schema.items() if k != "$defs"})
        referenced = set()

        def collect(node):
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str) and ref.startswith("#/$defs/"):
                    referenced.add(ref[len("#/$defs/"):])
                for value in node.values():
                    collect(value)
            elif isinstance(node, list):
                for item in node:
                    collect(item)

        # References from the schema body...
        collect(json.loads(blob_without_defs))
        # ...and transitively from referenced defs.
        changed = True
        while changed:
            changed = False
            for name in list(referenced):
                if name in defs:
                    before = len(referenced)
                    collect(defs[name])
                    if len(referenced) != before:
                        changed = True

        unused = [name for name in defs if name not in referenced]
        if not unused:
            return
        for name in unused:
            del defs[name]
        if not defs:
            del schema["$defs"]
            return


def fix_user_config(schema):
    """On disk, config.current-client is the client alias (string) or null."""
    user_cfg = schema.get("$defs", {}).get("UserConfigV1Alpha1Config")
    if not isinstance(user_cfg, dict):
        return
    props = user_cfg.get("properties", {})
    if "current-client" in props:
        props["current-client"] = {
            "anyOf": [{"type": "string"}, {"type": "null"}],
            "default": None,
            "description": "Alias of the currently selected client (as saved by `jmp config client use`).",
        }
    prune_unreferenced_defs(schema)


def generate(model, schema_id, description=None):
    schema = model.model_json_schema(by_alias=True)
    strip_runtime_properties(schema)
    if model is UserConfigV1Alpha1:
        fix_user_config(schema)
    # Stable, tool-friendly header keys.
    schema["$schema"] = SCHEMA_DIALECT
    schema["$id"] = schema_id
    if description and "description" not in schema:
        schema["description"] = description
    return schema


def main():
    out_dir = Path(__file__).resolve().parent.parent / "schemas"
    out_dir.mkdir(parents=True, exist_ok=True)

    targets = [
        (
            ClientConfigV1Alpha1,
            "client-config.schema.json",
            "https://jumpstarter.dev/schemas/client-config.schema.json",
            "Jumpstarter client configuration (clients/<alias>.yaml).",
        ),
        (
            ExporterConfigV1Alpha1,
            "exporter-config.schema.json",
            "https://jumpstarter.dev/schemas/exporter-config.schema.json",
            "Jumpstarter exporter configuration (exporters/<alias>.yaml).",
        ),
        (
            UserConfigV1Alpha1,
            "user-config.schema.json",
            "https://jumpstarter.dev/schemas/user-config.schema.json",
            "Jumpstarter user configuration (config.yaml).",
        ),
    ]

    for model, filename, schema_id, description in targets:
        schema = generate(model, schema_id, description)
        out_path = out_dir / filename
        out_path.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
        print("wrote %s" % out_path)


if __name__ == "__main__":
    main()
