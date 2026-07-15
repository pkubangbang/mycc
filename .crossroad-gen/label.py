"""label.py — LLM auto-labeling script for crossroad training data.

Uses local Ollama to label auto-collected JSONL data.
For each entry { text, turnIndex, source }, asks the LLM whether the text
has a genuine semantic turn at turnIndex, and writes results to
positive.jsonl or negative.jsonl.

Usage:
    python label.py [--model MODEL] [--batch-size N] [--delay SECONDS]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUTO_COLLECTED = DATA_DIR / "auto-collected.jsonl"
POSITIVE_OUT = DATA_DIR / "positive.jsonl"
NEGATIVE_OUT = DATA_DIR / "negative.jsonl"

DEFAULT_MODEL = "glm-5:cloud"
DEFAULT_BATCH_SIZE = 10
DEFAULT_DELAY = 1.0  # seconds between API calls


# ---------------------------------------------------------------------------
# Labeling prompt
# ---------------------------------------------------------------------------

LABEL_PROMPT = """\
You are an expert annotator for a "crossroad" detection system.
A "turn" (crossroad) is when a speaker reverses course mid-response — \
they committed to a direction, then pivot to contradict or reconsider.

Given the text below, determine whether there is a genuine semantic turn \
at the specified character index (turnIndex). The text before turnIndex \
is the "prefix" (the committed direction). The text from turnIndex onward \
is the "turn" (the pivot).

A genuine turn means the speaker is changing their mind, reconsidering, \
or reversing course. Ordinary conjunctions used for balanced analysis \
(e.g., "but" mid-sentence, "however" mid-sentence) are NOT turns.

Examples of genuine turns:
- "Let me fix this bug by adding a null check. Wait, the root cause is elsewhere."
- "Approach A is simpler. However, let me reconsider the performance."
- "先用最简单的方式修复。等一下，根本原因在数据层。"

Examples of non-turns:
- "The approach is clean but requires more work." (but mid-sentence)
- "Wait for the build to complete." (wait as verb)
- "检查权限、连接、缓存等等。" (等等 as etc.)

Text: {text}
Turn index: {turnIndex}
Prefix (before turn): {prefix}
Turn candidate (from turnIndex): {turn_candidate}

Respond with ONLY a JSON object, no markdown, no explanation:
{{"isTurn": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}}
"""


def build_prompt(text: str, turn_index: int) -> str:
    """Build the labeling prompt for a single entry."""
    prefix = text[:turn_index] if turn_index >= 0 else ""
    turn_candidate = text[turn_index:turn_index + 80] if turn_index >= 0 else ""
    return LABEL_PROMPT.format(
        text=text,
        turnIndex=turn_index,
        prefix=prefix,
        turn_candidate=turn_candidate,
    )


# ---------------------------------------------------------------------------
# Ollama interaction
# ---------------------------------------------------------------------------

def call_ollama(prompt: str, model: str) -> dict[str, Any]:
    """Call Ollama with the given prompt and parse the JSON response.

    Returns {"isTurn": bool, "confidence": float, "reason": str}.
    Raises RuntimeError if Ollama is not available or response is invalid.
    """
    import ollama

    try:
        response = ollama.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            format="json",
            options={"temperature": 0.1, "num_predict": 256},
        )
    except ollama.ResponseError as e:
        raise RuntimeError(f"Ollama response error: {e}") from e
    except ConnectionError as e:
        raise RuntimeError(f"Cannot connect to Ollama: {e}") from e
    except Exception as e:
        raise RuntimeError(f"Ollama call failed: {e}") from e

    content = response.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("Empty response from Ollama")

    # Parse JSON — be lenient about extra text
    content = content.strip()
    # Try to extract JSON object from the response
    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1:
        raise RuntimeError(f"No JSON found in response: {content[:200]}")

    try:
        result = json.loads(content[start : end + 1])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON in response: {e}") from e

    # Validate fields
    if "isTurn" not in result:
        raise RuntimeError("Missing 'isTurn' field in response")
    result["isTurn"] = bool(result["isTurn"])
    result["confidence"] = float(result.get("confidence", 0.5))
    result["reason"] = str(result.get("reason", ""))
    return result


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------

def load_entries(path: Path) -> list[dict[str, Any]]:
    """Load JSONL entries from file."""
    entries: list[dict[str, Any]] = []
    if not path.exists():
        return entries
    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"Warning: invalid JSON on line {line_num}: {e}", file=sys.stderr)
    return entries


def write_result(entry: dict[str, Any], label_result: dict[str, Any], output_dir: Path) -> None:
    """Write a labeled result to the appropriate output file."""
    is_turn = label_result["isTurn"]
    text = entry["text"]
    turn_index = entry.get("turnIndex", -1)

    if is_turn:
        record = {
            "text": text,
            "turnIndex": turn_index,
            "label": 1,
            "source": entry.get("source", "auto"),
            "confidence": label_result["confidence"],
            "reason": label_result["reason"],
        }
        out_path = output_dir / "positive.jsonl"
    else:
        record = {
            "text": text,
            "label": 0,
            "source": entry.get("source", "auto"),
            "confidence": label_result["confidence"],
            "reason": label_result["reason"],
        }
        out_path = output_dir / "negative.jsonl"

    with open(out_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def run_labeling(
    model: str = DEFAULT_MODEL,
    batch_size: int = DEFAULT_BATCH_SIZE,
    delay: float = DEFAULT_DELAY,
    input_path: Path | None = None,
    output_dir: Path | None = None,
) -> tuple[int, int]:
    """Run the labeling pipeline.

    Returns (num_positive, num_negative).
    """
    input_path = input_path or AUTO_COLLECTED
    output_dir = output_dir or DATA_DIR

    entries = load_entries(input_path)
    if not entries:
        print(f"No entries found in {input_path}")
        return (0, 0)

    print(f"Loaded {len(entries)} entries from {input_path}")
    print(f"Model: {model}, Batch size: {batch_size}, Delay: {delay}s")

    num_pos = 0
    num_neg = 0

    for i, entry in enumerate(entries):
        text = entry.get("text", "")
        turn_index = entry.get("turnIndex", -1)

        if not text:
            print(f"  [{i+1}/{len(entries)}] Skipping empty text")
            continue

        prompt = build_prompt(text, turn_index)

        try:
            result = call_ollama(prompt, model)
            is_turn = result["isTurn"]
            conf = result["confidence"]

            write_result(entry, result, output_dir)

            if is_turn:
                num_pos += 1
                status = "TURN"
            else:
                num_neg += 1
                status = "NO-TURN"

            print(f"  [{i+1}/{len(entries)}] {status} (conf={conf:.2f}): {text[:60]}...")

        except RuntimeError as e:
            print(f"  [{i+1}/{len(entries)}] ERROR: {e}", file=sys.stderr)
            # Continue with next entry rather than aborting

        # Rate control
        if (i + 1) % batch_size == 0 and i + 1 < len(entries):
            print(f"  Batch boundary, waiting {delay}s...")
            time.sleep(delay)
        elif delay > 0:
            time.sleep(delay)

    print(f"\nDone. Positive: {num_pos}, Negative: {num_neg}")
    return (num_pos, num_neg)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def check_ollama_available(model: str) -> bool:
    """Check if Ollama is running and the model is available."""
    try:
        import ollama

        ollama.list()
        return True
    except ImportError:
        print("Error: 'ollama' package not installed. Run: pip install ollama", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error: Cannot connect to Ollama: {e}", file=sys.stderr)
        print("Make sure Ollama is running (e.g., 'ollama serve').", file=sys.stderr)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Label auto-collected crossroad data using Ollama LLM")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model name (default: {DEFAULT_MODEL})")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help=f"Batch size (default: {DEFAULT_BATCH_SIZE})")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help=f"Delay between calls in seconds (default: {DEFAULT_DELAY})")
    parser.add_argument("--input", default=None, help="Input JSONL path (default: auto-collected.jsonl)")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: data/)")
    args = parser.parse_args()

    input_path = Path(args.input) if args.input else None
    output_dir = Path(args.output_dir) if args.output_dir else None

    if not check_ollama_available(args.model):
        sys.exit(1)

    num_pos, num_neg = run_labeling(
        model=args.model,
        batch_size=args.batch_size,
        delay=args.delay,
        input_path=input_path,
        output_dir=output_dir,
    )

    print(f"\nLabeling complete: {num_pos} positive, {num_neg} negative")


if __name__ == "__main__":
    main()