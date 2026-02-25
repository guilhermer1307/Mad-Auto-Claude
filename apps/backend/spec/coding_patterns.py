"""
Coding Patterns Module
======================

Handles structured coding pattern extraction and storage.
Patterns can be auto-extracted by the planner during codebase investigation
or provided manually by the user before planning.
"""

import json
from datetime import datetime
from pathlib import Path

CODING_PATTERNS_FILE = "coding_patterns.json"

VALID_CATEGORIES = [
    "architecture",
    "naming",
    "error_handling",
    "testing",
    "api",
    "styling",
    "other",
]


def load_coding_patterns(spec_dir: Path) -> dict | None:
    """Load coding patterns from the spec directory.

    Args:
        spec_dir: Path to the spec directory

    Returns:
        Coding patterns dict or None if file doesn't exist
    """
    patterns_file = spec_dir / CODING_PATTERNS_FILE
    if not patterns_file.exists():
        return None

    with open(patterns_file, encoding="utf-8") as f:
        return json.load(f)


def save_coding_patterns(spec_dir: Path, patterns: dict) -> Path:
    """Save coding patterns to the spec directory.

    Args:
        spec_dir: Path to the spec directory
        patterns: Coding patterns dict

    Returns:
        Path to the saved file
    """
    patterns_file = spec_dir / CODING_PATTERNS_FILE
    with open(patterns_file, "w", encoding="utf-8") as f:
        json.dump(patterns, f, indent=2)
    return patterns_file


def merge_coding_patterns(existing: dict, new: dict) -> dict:
    """Merge new coding patterns into existing ones.

    New patterns are appended. Conventions from new override existing.
    This allows user-provided patterns to supplement auto-extracted ones.

    Args:
        existing: Existing coding patterns dict
        new: New coding patterns to merge in

    Returns:
        Merged coding patterns dict
    """
    merged = {
        "patterns": list(existing.get("patterns", [])),
        "conventions": dict(existing.get("conventions", {})),
        "extracted_at": datetime.now().isoformat(),
        "source": "merged",
    }

    # Append new patterns (avoid duplicates by name)
    existing_names = {p.get("name") for p in merged["patterns"]}
    for pattern in new.get("patterns", []):
        if pattern.get("name") not in existing_names:
            merged["patterns"].append(pattern)

    # Override conventions with new values
    merged["conventions"].update(new.get("conventions", {}))

    return merged


def create_empty_patterns() -> dict:
    """Create an empty coding patterns structure.

    Returns:
        Empty coding patterns dict with correct schema
    """
    return {
        "patterns": [],
        "conventions": {},
        "extracted_at": datetime.now().isoformat(),
        "source": "auto",
    }
