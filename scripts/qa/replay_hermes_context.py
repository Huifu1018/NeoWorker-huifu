"""Read-only context-size replay. No provider calls or changes to task data."""

import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("session_id")
    parser.add_argument("--before", required=True, type=float, help="Exclusive Unix timestamp in seconds")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location(
        "host", Path(__file__).resolve().parents[1] / "hermes-acp-neoworker-host.py")
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT role, content, tool_call_id, tool_calls, reasoning FROM messages "
            "WHERE session_id=? AND timestamp<? ORDER BY timestamp,id", (args.session_id, args.before)).fetchall()
    history = []
    measurements = []
    with tempfile.TemporaryDirectory(prefix="neoworker-context-replay-") as workspace:
        for role, content, call_id, calls, reasoning in rows:
            if role == "assistant" and history:
                projected, metrics = host.project_tool_history(history, workspace)
                measurements.append({**metrics, "beforeTotalChars": len(host._json(history)),
                                     "afterTotalChars": len(host._json(projected))})
            item = {"role": role, "content": content}
            if call_id:
                item["tool_call_id"] = call_id
            if calls:
                item["tool_calls"] = json.loads(calls)
            if reasoning:
                item["reasoning_content"] = reasoning
            history.append(item)
    print(json.dumps({
        "scope": "offline replay of stored messages; excludes system prompt/tools and is not a latency benchmark",
        "requests": len(measurements),
        "cumulativeBeforeChars": sum(row["beforeTotalChars"] for row in measurements),
        "cumulativeAfterChars": sum(row["afterTotalChars"] for row in measurements),
        "lastRequest": measurements[-1] if measurements else None,
    }, indent=2))


if __name__ == "__main__":
    main()
