"""
Hermes Agent plugin for context-mode context window protection.

Two hooks:
  pre_tool_call  - Blocks curl/wget/build tools before execution, redirects to MCP sandbox
  pre_llm_call   - Injects routing rules on first turn of each session

Installs via: cp -r .hermes-plugin ~/.hermes/plugins/hermes-context-mode
"""

from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger("hermes-context-mode")

BLOCKED_CURL_WGET = re.compile(r"\b(curl|wget)\b")
BLOCKED_INLINE_HTTP = re.compile(
    r"\b(fetch\s*\(\s*['\"]http|"
    r"requests\.(get|post|put|delete|patch)\s*\(|"
    r"http\.(get|post|request)\s*\(|"
    r"urllib\.request\.urlopen\s*\()"
)
BLOCKED_BUILD = re.compile(r"\b(gradle|mvn|cargo\s+(build|test|run|check))\b")

ALLOWED = [
    "git ", "mkdir", "rm ", "mv ", "cp ", "touch", "chmod",
    "ls ", "pwd", "cd ", "echo ", "cat ", "head ", "tail ",
    "npm install ", "pip install ", "pip3 install ",
    "which ", "whoami", "hostname", "uname", "date", "env",
    "hermes ", "brew ",
]

ROUTING_BLOCK = """<context_window_protection>
  context-mode MCP tools available.
  - curl/wget/build tools BLOCKED. Use ctx_execute or ctx_fetch_and_index.
  - Shell (>20 lines output) REDIRECTED. Use ctx_batch_execute.
  - Think in Code: write scripts, don't read raw data into context.
  - /clear and /compact preserve your knowledge base.
</context_window_protection>"""

_GUIDANCE_SHOWN: dict[str, bool] = {}


def _is_allowed(stripped: str) -> bool:
    for a in ALLOWED:
        if stripped.startswith(a):
            return True
    return False


def pre_tool_call(*, tool_name: str, args: dict, **_kwargs) -> Optional[dict]:
    if tool_name != "terminal":
        return None
    command = args.get("command", "")
    if not isinstance(command, str) or not command.strip():
        return None
    stripped = command.strip()
    if _is_allowed(stripped):
        return None
    if BLOCKED_CURL_WGET.search(stripped):
        return {
            "action": "block",
            "message": "hermes-context-mode: curl/wget blocked. Use ctx_execute or ctx_fetch_and_index.",
        }
    if BLOCKED_INLINE_HTTP.search(stripped):
        return {
            "action": "block",
            "message": "hermes-context-mode: Inline HTTP blocked. Use ctx_execute.",
        }
    if BLOCKED_BUILD.search(stripped):
        return {
            "action": "block",
            "message": "hermes-context-mode: Build tool blocked. Use ctx_execute with shell.",
        }
    return None


def pre_llm_call(*, session_id: str, is_first_turn: bool, **_kwargs) -> Optional[dict]:
    if not is_first_turn or session_id in _GUIDANCE_SHOWN:
        return None
    _GUIDANCE_SHOWN[session_id] = True
    return {"context": ROUTING_BLOCK}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    logger.info("hermes-context-mode registered")
