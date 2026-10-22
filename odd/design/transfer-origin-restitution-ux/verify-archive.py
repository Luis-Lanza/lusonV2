"""Verify original reference bytes without rendering or executing downloaded HTML."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
sources = json.loads((root / "sources.json").read_text())
manifest = json.loads((root / "manifest.json").read_text())
expected = {(screen["id"], kind): screen[kind]
            for screen in sources["screens"] for kind in ("html", "png")}
assert len(manifest["assets"]) == len(expected) == 10
assert {(entry["screen_id"], entry["kind"]) for entry in manifest["assets"]} == set(expected)
for entry in manifest["assets"]:
    assert entry["path"] == f'{entry["screen_id"]}.{entry["kind"]}'
    assert entry["source_url"] == expected[entry["screen_id"], entry["kind"]]
    data = (root / entry["path"]).read_bytes()
    assert len(data) == entry["bytes"]
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    if entry["kind"] == "png":
        assert data.startswith(b"\x89PNG\r\n\x1a\n")
    print(f'OK {entry["path"]}: {len(data)} bytes, SHA-256 {entry["sha256"]}')
print("Verified 10 original assets and source URL associations; no HTML executed.")
