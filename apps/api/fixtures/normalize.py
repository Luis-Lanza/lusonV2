"""Read the external XLSX using only stdlib; derive or compare catalog.json."""
import argparse
import decimal
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
SHEET = "baae de datos"


def normalize(source):
    raw = Path(source).read_bytes()
    with zipfile.ZipFile(source) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet = next(s for s in workbook.findall("m:sheets/m:sheet", NS)
                     if s.attrib["name"] == SHEET)
        rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(r.attrib["Target"] for r in rels if r.attrib["Id"] == rid)
        target = target.lstrip("/") if target.startswith("/") else "xl/" + target
        strings = ["".join(s.itertext()) for s in ET.fromstring(
            archive.read("xl/sharedStrings.xml")).findall("m:si", NS)]
        rows = ET.fromstring(archive.read(target)).findall(".//m:row", NS)
        entries, headers = [], []
        for row in rows:
            number = int(row.attrib["r"])
            if number < 5:
                continue
            cells = {}
            for cell in row.findall("m:c", NS):
                value = cell.find("m:v", NS)
                if value is not None:
                    cells[cell.attrib["r"]] = strings[int(value.text)] if cell.get("t") == "s" else value.text
            for group in ("BCD", "FGH", "JKL", "NOP"):
                refs = [f"{col}{number}" for col in group]
                values = [cells.get(ref, "") for ref in refs]
                if not any(values):
                    continue
                if not all(values):
                    raise ValueError(f"Partial source triplet: {refs}")
                if values == ["Marca", "Modelo", "Amperaje"]:
                    headers.append(refs)
                    continue
                capacity = decimal.Decimal(values[2])
                if not capacity.is_finite() or capacity <= 0:
                    raise ValueError(f"Invalid source capacity: {refs}")
                entries.append({"id": len(entries) + 1, "brand": values[0], "model": values[1],
                                "capacity_ah": capacity, "cells": refs})
    assert len(entries) == 95 and len(headers) == 6
    assert len({e["brand"] for e in entries}) == 11
    return {"source_sha256": hashlib.sha256(raw).hexdigest(), "sheet": SHEET,
            "nonempty_triplets": 101, "excluded_headers": headers, "entries": entries}


def exact_json(value, level=0):
    # Decimal is emitted as a JSON number, never through binary floating point.
    if isinstance(value, decimal.Decimal):
        return format(value.normalize(), "f")
    indent = "  " * (level + 1)
    closing = "  " * level
    if isinstance(value, dict):
        fields = [indent + json.dumps(k) + ": " + exact_json(v, level + 1)
                  for k, v in value.items()]
        return "{\n" + ",\n".join(fields) + "\n" + closing + "}"
    if isinstance(value, list):
        if all(isinstance(v, str) for v in value):
            return json.dumps(value, ensure_ascii=False)
        return "[\n" + ",\n".join(indent + exact_json(v, level + 1) for v in value) + "\n" + closing + "]"
    return json.dumps(value, ensure_ascii=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    normalized = normalize(args.source)
    target = Path(__file__).with_name("catalog.json")
    if args.write:
        target.write_text(exact_json(normalized) + "\n", encoding="utf-8")
    else:
        actual = json.loads(target.read_text(encoding="utf-8"), parse_float=decimal.Decimal)
        assert actual == normalized, "Fixture differs from source (including provenance)"
        print("Source comparison passed: 95 entries, 11 brands, 101 triplets, 6 headers; exact decimals")
