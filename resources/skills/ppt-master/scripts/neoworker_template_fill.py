#!/usr/bin/env python3
"""NeoWorker host adapter for filling a user-provided PPTX template.

The model supplies a normalized slide plan. This adapter keeps the template
workflow inside the task artifact directory, selects native source slides by
purpose, applies editable OOXML text replacements, and validates the result.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from attribution_guard import require_skill_integrity  # noqa: E402
from template_fill_pptx.analyzer import analyze_pptx  # noqa: E402
from template_fill_pptx.applier import apply_plan  # noqa: E402
from template_fill_pptx.checker import check_plan  # noqa: E402
from template_fill_pptx.ooxml import _write_json  # noqa: E402
from template_fill_pptx.validator import validate_project  # noqa: E402


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _lines(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for raw in value if (item := _text(raw))]
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    return []


def _slide_kind(slide: dict[str, Any]) -> str:
    value = _text(slide.get("slideType") or slide.get("layout")).lower()
    if value in {"cover", "title"}:
        return "cover_candidate"
    if value in {"section", "chapter"}:
        return "chapter_candidate"
    if value in {"closing", "ending"}:
        return "ending_candidate"
    return "content_candidate"


def _source_candidates(
    library: dict[str, Any],
    kind: str,
    used: set[int],
) -> list[dict[str, Any]]:
    slides = [
        slide
        for slide in library.get("slides", [])
        if int(slide.get("slide_index", 0)) not in used
    ]
    preferred = [slide for slide in slides if slide.get("page_type") == kind]
    return preferred or slides


def _choose_source_slide(
    library: dict[str, Any],
    slide: dict[str, Any],
    used: set[int],
) -> dict[str, Any]:
    kind = _slide_kind(slide)
    candidates = _source_candidates(library, kind, used)
    if not candidates:
        # Reusing a source shell is preferable to silently falling back to a
        # completely different renderer when a short template has few pages.
        candidates = [
            candidate
            for candidate in library.get("slides", [])
            if int(candidate.get("slide_index", 0)) > 0
        ]
    if not candidates:
        raise RuntimeError("The source PPTX contains no usable slides")
    selected = candidates[0]
    used.add(int(selected["slide_index"]))
    return selected


def _content_lines(slide: dict[str, Any]) -> list[str]:
    content = _lines(slide.get("content"))
    if not content:
        content = _lines(slide.get("bullets"))
    if not content:
        data = slide.get("data")
        if isinstance(data, dict):
            rows = data.get("rows")
            if isinstance(rows, list):
                content = [
                    " | ".join(_text(cell) for cell in row)
                    for row in rows
                    if isinstance(row, list) and any(_text(cell) for cell in row)
                ]
    return content


def _split_lines(lines: list[str], count: int) -> list[str]:
    if count <= 1:
        return ["\n".join(lines)] if lines else [""]
    if not lines:
        return [""] * count
    chunks: list[list[str]] = [[] for _ in range(count)]
    for index, line in enumerate(lines):
        chunks[min(index * count // len(lines), count - 1)].append(line)
    return ["\n".join(chunk) for chunk in chunks]


def _replacement_plan(
    source_slide: dict[str, Any],
    requested_slide: dict[str, Any],
) -> list[dict[str, Any]]:
    table_slot_ids = {
        str(table.get("table_id", "")).replace("_tbl", "_sh")
        for table in source_slide.get("tables", [])
        if table.get("table_id")
    }
    chart_slot_ids = {
        str(chart.get("chart_id", "")).replace("_ch", "_sh")
        for chart in source_slide.get("charts", [])
        if chart.get("chart_id")
    }
    slots = [
        slot
        for slot in source_slide.get("slots", [])
        if _text(slot.get("text"))
        and slot.get("slot_id") not in table_slot_ids
        and slot.get("slot_id") not in chart_slot_ids
    ]
    if not slots:
        return []

    title = _text(requested_slide.get("title"))
    subtitle = _text(requested_slide.get("subtitle"))
    quote = _text(requested_slide.get("quote"))
    attribution = _text(requested_slide.get("attribution"))
    if quote and attribution:
        quote = f"{quote} — {attribution}"
    body = _content_lines(requested_slide)
    body_slots = [slot for slot in slots if slot.get("role") == "body_candidate"]
    body_values = _split_lines(body, max(len(body_slots), 1))
    body_index = 0
    remaining = list(body)
    replacements: list[dict[str, Any]] = []

    for slot in slots:
        role = _text(slot.get("role"))
        if role == "title_candidate":
            replacement = title or (body[0] if body else _text(slot.get("text")))
        elif role == "body_candidate":
            replacement = body_values[body_index] if body_values else ""
            body_index += 1
        elif role in {"subtitle_candidate", "caption_candidate"}:
            replacement = subtitle or (remaining.pop(0) if remaining else "")
        elif role == "quote_candidate":
            replacement = quote or (remaining.pop(0) if remaining else "")
        elif role == "label_candidate":
            replacement = remaining.pop(0) if remaining else ""
        else:
            replacement = remaining.pop(0) if remaining else ""

        # Empty replacements intentionally clear sample copy from the template
        # instead of leaving misleading placeholder content behind.
        replacements.append(
            {
                "slot_id": slot["slot_id"],
                "old_text": slot.get("text", ""),
                "text": replacement,
            }
        )
    return replacements


def _table_edits(
    source_slide: dict[str, Any],
    requested_slide: dict[str, Any],
) -> list[dict[str, Any]]:
    data = requested_slide.get("data")
    if not isinstance(data, dict):
        return []
    rows = data.get("rows")
    headers = data.get("headers")
    matrix: list[list[str]] = []
    if isinstance(headers, list) and headers:
        matrix.append([_text(value) for value in headers])
    if isinstance(rows, list):
        matrix.extend(
            [
                [_text(value) for value in row]
                for row in rows
                if isinstance(row, list)
            ]
        )
    if not matrix or not source_slide.get("tables"):
        return []

    table = source_slide["tables"][0]
    row_count = int(table.get("row_count") or 0)
    column_count = int(table.get("column_count") or 0)
    cells = []
    for row_index, row in enumerate(matrix[:row_count]):
        for col_index, value in enumerate(row[:column_count]):
            cells.append({"row": row_index, "col": col_index, "text": value})
    if not cells:
        return []
    return [{"table_id": table["table_id"], "cells": cells}]


def _chart_edits(
    source_slide: dict[str, Any],
    requested_slide: dict[str, Any],
) -> list[dict[str, Any]]:
    data = requested_slide.get("data")
    if not isinstance(data, dict) or not source_slide.get("charts"):
        return []
    categories = data.get("categories")
    series = data.get("series")
    if not isinstance(categories, list) or not isinstance(series, list) or not series:
        return []
    normalized_series = []
    for item in series:
        if not isinstance(item, dict) or not isinstance(item.get("values"), list):
            return []
        normalized_series.append(
            {
                "name": _text(item.get("name")) or "Series",
                "values": item["values"][: len(categories)],
            }
        )
    if any(len(item["values"]) != len(categories) for item in normalized_series):
        return []
    chart = source_slide["charts"][0]
    return [
        {
            "chart_id": chart["chart_id"],
            "categories": [_text(value) for value in categories],
            "series": normalized_series,
        }
    ]


def build_plan(library: dict[str, Any], requested_slides: list[dict[str, Any]]) -> dict[str, Any]:
    used: set[int] = set()
    planned: list[dict[str, Any]] = []
    for requested_slide in requested_slides:
        source_slide = _choose_source_slide(library, requested_slide, used)
        planned.append(
            {
                "source_slide": int(source_slide["slide_index"]),
                "purpose": _slide_kind(requested_slide),
                "layout_rationale": {
                    "layout_pattern": "preserve native source slide shell",
                    "why_fit": "host-selected source slide matches the requested slide purpose",
                    "risk": "long text may require shortening after visual review",
                },
                "replacements": _replacement_plan(source_slide, requested_slide),
                "table_edits": _table_edits(source_slide, requested_slide),
                "chart_edits": _chart_edits(source_slide, requested_slide),
                "notes": _text(requested_slide.get("notes")),
            }
        )
    return {
        "schema": "template_fill_pptx_plan.v1",
        "status": "confirmed",
        "source_pptx": library.get("source_pptx"),
        "accepted_warnings": ["host_generated_plan"],
        "slides": planned,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Source/template PPTX")
    parser.add_argument("--slides-json", required=True, help="Normalized slide plan JSON")
    parser.add_argument("--project", required=True, help="Task-scoped PPT Master project root")
    parser.add_argument("--output", required=True, help="Canonical output PPTX path")
    return parser


def main(argv: list[str] | None = None) -> int:
    require_skill_integrity()
    args = build_parser().parse_args(argv)
    source = Path(args.source).expanduser().resolve()
    project = Path(args.project).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".pptx":
        raise RuntimeError(f"Source PPTX does not exist or is not a .pptx file: {source}")

    sources_dir = project / "sources"
    analysis_dir = project / "analysis"
    exports_dir = project / "exports"
    validation_dir = project / "validation"
    for directory in (sources_dir, analysis_dir, exports_dir, validation_dir, output.parent):
        directory.mkdir(parents=True, exist_ok=True)

    copied_source = sources_dir / source.name
    shutil.copy2(source, copied_source)
    library = analyze_pptx(copied_source)
    library_path = analysis_dir / f"{copied_source.stem}.slide_library.json"
    _write_json(library_path, library)

    requested_slides = json.loads(
        Path(args.slides_json).expanduser().resolve().read_text(encoding="utf-8")
    )
    if not isinstance(requested_slides, list) or not requested_slides:
        raise RuntimeError("create_presentation supplied no slides for template fill")
    plan = build_plan(library, requested_slides)
    plan_path = analysis_dir / "fill_plan.json"
    _write_json(plan_path, plan)

    check_report = check_plan(library, plan)
    _write_json(analysis_dir / "check_report.json", check_report)
    if int(check_report["summary"].get("error", 0)) > 0:
        raise RuntimeError(
            "PPTX template fill plan failed validation: "
            + json.dumps(check_report["summary"], ensure_ascii=False)
        )

    export_path = exports_dir / "presentation.pptx"
    apply_plan(copied_source, plan, export_path)
    validation_report = validate_project(project)
    _write_json(validation_dir / "validate_report.json", validation_report)
    if int(validation_report["summary"].get("error", 0)) > 0:
        raise RuntimeError(
            "PPTX template fill read-back validation failed: "
            + json.dumps(validation_report["summary"], ensure_ascii=False)
        )

    shutil.copy2(export_path, output)
    _write_json(
        validation_dir / "host-template-fill.json",
        {
            "schema": "neoworker.ppt-master.host-template-fill.v1",
            "source": str(copied_source),
            "plan": str(plan_path),
            "export": str(export_path),
            "output": str(output),
            "check": check_report["summary"],
            "validation": validation_report["summary"],
        },
    )
    print(json.dumps({"output": str(output), "size": output.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
