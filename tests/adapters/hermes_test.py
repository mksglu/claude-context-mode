"""
Hermes plugin test suite for context-mode.

Tests the hook functions directly by importing the module.
Usage: pytest tests/adapters/hermes_test.py -v
"""

import importlib.util
import os
import tempfile
import sqlite3

import pytest


# ── Fixture ──────────────────────────────────────────────


@pytest.fixture
def mod():
    """Import the plugin module and set up HERMES_HOME."""
    old_home = os.environ.get("HERMES_HOME")
    test_home = tempfile.mkdtemp(prefix="hermes-test-")
    os.environ["HERMES_HOME"] = test_home

    spec = importlib.util.spec_from_file_location(
        "hermes_context_mode",
        os.path.join(os.path.dirname(__file__), "../../.hermes-plugin/__init__.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    yield module

    if old_home:
        os.environ["HERMES_HOME"] = old_home
    else:
        os.environ.pop("HERMES_HOME", None)


# ── pre_tool_call ────────────────────────────────────────


def test_pre_tool_call_allows_allowed_command(mod):
    """pre_tool_call returns None for commands in the ALLOWED list."""
    result = mod.pre_tool_call(
        tool_name="terminal",
        args={"command": "git status"},
        task_id="test",
        session_id="test-session",
    )
    assert result is None, f"Expected None for allowed command, got {result}"


def test_pre_tool_call_blocks_curl(mod):
    """pre_tool_call blocks curl with action='block'."""
    result = mod.pre_tool_call(
        tool_name="terminal",
        args={"command": "curl https://example.com/long/path/to/test"},
        task_id="test",
        session_id="test-session",
    )
    assert result is not None, "Expected block for curl"
    assert result.get("action") == "block", f"Expected action='block', got {result}"


def test_pre_tool_call_blocks_wget(mod):
    """pre_tool_call blocks wget with action='block'."""
    result = mod.pre_tool_call(
        tool_name="terminal",
        args={"command": "wget https://example.com/file.zip"},
        task_id="test",
        session_id="test-session",
    )
    assert result is not None, "Expected block for wget"
    assert result.get("action") == "block", f"Expected action='block', got {result}"


def test_pre_tool_call_ignores_non_terminal(mod):
    """pre_tool_call returns None for non-terminal tools."""
    result = mod.pre_tool_call(
        tool_name="read_file",
        args={"path": "/tmp/test"},
        task_id="test",
        session_id="test-session",
    )
    assert result is None, f"Expected None for non-terminal tool, got {result}"


# ── pre_llm_call ─────────────────────────────────────────


def test_pre_llm_call_injects_on_first_turn(mod):
    """pre_llm_call returns context on first turn for a new session."""
    result = mod.pre_llm_call(
        session_id="fresh-session",
        user_message="hello",
        is_first_turn=True,
    )
    assert result is not None, "Expected context on first turn"
    assert "context" in result, f"Expected 'context' key in result, got {result}"


def test_pre_llm_call_skips_on_subsequent_turns(mod):
    """pre_llm_call returns None on subsequent turns (guidance already shown)."""
    mod.pre_llm_call(
        session_id="multi-turn-session",
        user_message="hello",
        is_first_turn=True,
    )
    result = mod.pre_llm_call(
        session_id="multi-turn-session",
        user_message="second message",
        is_first_turn=False,
    )
    assert result is None, f"Expected None on subsequent turn, got {result}"


def test_pre_llm_call_skips_when_already_shown(mod):
    """pre_llm_call returns None when session_id already in SESSION_GUIDANCE_SHOWN."""
    mod.pre_llm_call(
        session_id="already-shown-session",
        user_message="hello",
        is_first_turn=True,
    )
    result = mod.pre_llm_call(
        session_id="already-shown-session",
        user_message="hello again",
        is_first_turn=True,
    )
    assert result is None, f"Expected None for already shown session, got {result}"


# ── pre_llm_call: memory leak cap ───────────────────────


def test_guidance_cap_prevents_memory_leak(mod):
    """_GUIDANCE_CAP prevents unbounded growth by clearing SESSION_GUIDANCE_SHOWN."""
    for i in range(mod._GUIDANCE_CAP + 5):
        sid = f"leak-test-{i}"
        mod.pre_llm_call(
            session_id=sid,
            user_message="hello",
            is_first_turn=True,
        )

    assert len(mod.SESSION_GUIDANCE_SHOWN) <= mod._GUIDANCE_CAP + 1, (
        f"GUIDANCE_SHOWN grew to {len(mod.SESSION_GUIDANCE_SHOWN)} "
        f"(cap is {mod._GUIDANCE_CAP})"
    )


# ── transform_tool_result ────────────────────────────────


def test_transform_tool_result_small_output(mod):
    """transform_tool_result returns None for small outputs (<3KB)."""
    result = mod.transform_tool_result(
        tool_name="terminal",
        args={"command": "echo hello"},
        result="hello",
        session_id="test-session",
        task_id="test-task",
    )
    assert result is None, "Expected None for small output"


def test_transform_tool_result_large_output(mod):
    """transform_tool_result sandboxes large outputs and returns summary."""
    large = "x" * 5000
    result = mod.transform_tool_result(
        tool_name="terminal",
        args={"command": "cat bigfile"},
        result=large,
        session_id="test-session",
        task_id="test-task",
    )
    assert result is not None, "Expected sandbox summary for large output"
    assert "<sandboxed_output" in result, "Expected sandbox summary"


# ── on_session_start ─────────────────────────────────────


def test_on_session_start_clears_guidance(mod):
    """on_session_start removes session_id from SESSION_GUIDANCE_SHOWN."""
    mod.pre_llm_call(
        session_id="cleanup-test",
        user_message="hello",
        is_first_turn=True,
    )
    assert "cleanup-test" in mod.SESSION_GUIDANCE_SHOWN

    mod.on_session_start(
        session_id="cleanup-test",
        model="deepseek-v4",
        platform="telegram",
    )
    assert "cleanup-test" not in mod.SESSION_GUIDANCE_SHOWN


# ── on_session_end: metrics persistence ──────────────────


def test_on_session_end_persists_metrics(mod):
    """on_session_end writes session metrics to SQLite."""
    sid = "metrics-test-session"
    mod.on_session_start(session_id=sid, model="test-model", platform="test-platform")

    mod.pre_llm_call(session_id=sid, user_message="hello", is_first_turn=True)
    mod.transform_tool_result(
        tool_name="terminal",
        args={"command": "cat bigfile"},
        result="x" * 5000,
        session_id=sid,
        task_id="metrics-task",
    )

    mod.on_session_end(session_id=sid, completed=True, interrupted=False)

    conn = sqlite3.connect(str(mod.METRICS_DB))
    try:
        row = conn.execute(
            "SELECT session_id, platform, model, tool_calls, bytes_saved, blocks "
            "FROM session_metrics WHERE session_id = ?",
            (sid,),
        ).fetchone()
        assert row is not None, f"Expected metrics row for {sid}"
        _, platform, model, tool_calls, bytes_saved, blocks = row
        assert platform == "test-platform"
        assert model == "test-model"
        assert bytes_saved > 0, f"Expected bytes_saved > 0, got {bytes_saved}"
    finally:
        conn.close()
