#!/usr/bin/env python3
"""Recall status for MindStone for Pi.

Uses the same Python vector stack as MS4CC, with paths rooted at
MS4PI_ORCHESTRATOR_DIR when provided.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ORCHESTRATOR_DIR = Path(os.environ.get("MS4PI_ORCHESTRATOR_DIR", Path(__file__).resolve().parent.parent))
DB_PATH = ORCHESTRATOR_DIR / "vectors.db"
MEMORY_DIR = ORCHESTRATOR_DIR / "memory"
TRANSCRIPTS_DIR = ORCHESTRATOR_DIR / "transcripts"


def main() -> None:
    status: dict = {
        "orchestrator_dir": str(ORCHESTRATOR_DIR),
        "memory_dir": str(MEMORY_DIR),
        "transcripts_dir": str(TRANSCRIPTS_DIR),
        "vector_db": str(DB_PATH),
        "vector_db_present": DB_PATH.exists(),
        "embedding_model": os.environ.get("EMBEDDER_MODEL", "nomic-embed-text"),
        "embedding_base_url": os.environ.get("EMBEDDER_BASE_URL", "http://127.0.0.1:11434/v1"),
        "mode": "unavailable",
        "chunks_total": 0,
        "chunks_memory": 0,
        "chunks_transcript": 0,
        "error": None,
    }

    try:
        from vectorstore import VectorStore
        store = VectorStore(DB_PATH)
        store.init_schema()
        status["vector_db_present"] = True
        status["chunks_total"] = store.count()
        conn = store._conn_or_init()
        for source_type in ("memory", "transcript"):
            row = conn.execute("SELECT COUNT(*) FROM chunks WHERE source_type = ?", (source_type,)).fetchone()
            status[f"chunks_{source_type}"] = int(row[0] if row else 0)
        status["mode"] = "semantic" if status["chunks_total"] else "semantic-empty"
    except Exception as e:
        status["error"] = str(e)
        status["mode"] = "text-fallback"

    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
