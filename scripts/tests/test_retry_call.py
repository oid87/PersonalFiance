"""Offline unit tests for _common.retry_call() (no network calls). spec_V.md V2/first layer."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _common  # noqa: E402


def _backoff(attempt):
    return 10 * (attempt + 1)


class RetryCallTests(unittest.TestCase):
    def test_success_on_first_try_no_sleep(self):
        calls = []
        fn = lambda: calls.append(1) or "ok"
        with patch("_common.time.sleep") as mock_sleep:
            result = _common.retry_call(fn, attempts=3, backoff=_backoff)
        self.assertEqual(result, "ok")
        self.assertEqual(len(calls), 1)
        mock_sleep.assert_not_called()

    def test_fails_k_times_then_succeeds(self):
        state = {"n": 0}

        def fn():
            state["n"] += 1
            if state["n"] < 3:
                raise ValueError(f"fail-{state['n']}")
            return "ok"

        sleeps = []
        with patch("_common.time.sleep", side_effect=sleeps.append):
            result = _common.retry_call(fn, attempts=5, backoff=_backoff)
        self.assertEqual(result, "ok")
        self.assertEqual(state["n"], 3)
        # failed attempts 0 and 1 (0-based) -> sleeps 10, 20
        self.assertEqual(sleeps, [10, 20])

    def test_all_fail_no_on_final_returns_none(self):
        def fn():
            raise ValueError("nope")

        with patch("_common.time.sleep") as mock_sleep:
            result = _common.retry_call(fn, attempts=3, backoff=_backoff)
        self.assertIsNone(result)
        # sleeps between attempts 0-1 and 1-2, never after the last (attempt 2)
        self.assertEqual(mock_sleep.call_count, 2)
        mock_sleep.assert_any_call(10)
        mock_sleep.assert_any_call(20)

    def test_all_fail_with_on_final(self):
        def fn():
            raise ValueError("boom")

        def on_final(exc, result):
            return f"final:{exc}"

        with patch("_common.time.sleep"):
            result = _common.retry_call(
                fn, attempts=2, backoff=_backoff, on_final=on_final
            )
        self.assertEqual(result, "final:boom")

    def test_on_final_receives_last_result_when_retry_if_triggers(self):
        def fn():
            return None  # always "falsy" -> retry_if keeps firing

        def on_final(exc, result):
            self.assertIsNone(exc)
            return "fallback"

        with patch("_common.time.sleep"):
            result = _common.retry_call(
                fn, attempts=3, backoff=_backoff,
                retry_if=lambda r: r is None, on_final=on_final,
            )
        self.assertEqual(result, "fallback")

    def test_retry_if_accepts_falsy_then_succeeds(self):
        calls = {"n": 0}

        def fn():
            calls["n"] += 1
            return None if calls["n"] < 2 else 42

        with patch("_common.time.sleep") as mock_sleep:
            result = _common.retry_call(
                fn, attempts=5, backoff=_backoff, retry_if=lambda r: r is None,
            )
        self.assertEqual(result, 42)
        self.assertEqual(calls["n"], 2)
        mock_sleep.assert_called_once_with(10)

    def test_exception_not_in_retry_on_propagates_immediately(self):
        def fn():
            raise KeyError("nope")

        with patch("_common.time.sleep") as mock_sleep:
            with self.assertRaises(KeyError):
                _common.retry_call(fn, attempts=3, backoff=_backoff, retry_on=(ValueError,))
        mock_sleep.assert_not_called()

    def test_sleep_sequence_matches_backoff(self):
        def fn():
            raise ValueError("x")

        sleeps = []
        with patch("_common.time.sleep", side_effect=sleeps.append):
            _common.retry_call(fn, attempts=4, backoff=lambda a: 5 * (a + 1))
        self.assertEqual(sleeps, [5, 10, 15])  # never a 4th sleep after last attempt

    def test_on_retry_called_once_per_failed_non_final_attempt(self):
        calls = []

        def fn():
            raise ValueError("x")

        def on_retry(attempt, exc, result):
            calls.append((attempt, str(exc), result))

        with patch("_common.time.sleep"):
            _common.retry_call(fn, attempts=3, backoff=_backoff, on_retry=on_retry)
        # attempts 0 and 1 are "between failed attempts"; attempt 2 (last) is not
        self.assertEqual(calls, [(0, "x", None), (1, "x", None)])

    def test_on_retry_not_called_after_last_attempt(self):
        calls = []

        def fn():
            raise ValueError("x")

        with patch("_common.time.sleep"):
            _common.retry_call(
                fn, attempts=1, backoff=_backoff,
                on_retry=lambda a, e, r: calls.append(a),
            )
        self.assertEqual(calls, [])

    def test_retry_if_result_passed_to_on_retry(self):
        calls = []

        def fn():
            return "bad"

        with patch("_common.time.sleep"):
            _common.retry_call(
                fn, attempts=2, backoff=_backoff,
                retry_if=lambda r: r == "bad",
                on_retry=lambda a, e, r: calls.append((a, e, r)),
            )
        self.assertEqual(calls, [(0, None, "bad")])


if __name__ == "__main__":
    unittest.main()
