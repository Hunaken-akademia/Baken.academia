"""Reject empty/failed collector archives before immutable storage upload."""
import json
import sys
import tarfile


def validate(path):
    with tarfile.open(path, "r:gz") as archive:
        members = {m.name: m for m in archive.getmembers() if m.isfile()}
        audits = [name for name in members if name.endswith("/normalized/audit.json")]
        if len(audits) != 1:
            raise ValueError("Missing unique normalized audit")
        audit_name = audits[0]
        with archive.extractfile(audit_name) as source:
            audit = json.load(source)
        if not isinstance(audit, dict) or audit.get("errors"):
            raise ValueError("Invalid audit or incomplete collection")
        prefix = audit_name.rsplit("/", 1)[0]
        if not any(name.startswith(prefix + "/") and name.endswith(".parquet")
                   and member.size > 0 for name, member in members.items()):
            raise ValueError("No normalized parquet data")


if __name__ == "__main__":
    validate(sys.argv[1])
