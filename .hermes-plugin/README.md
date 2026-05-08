# hermes-context-mode — Context Mode Plugin for Hermes Agent

Enforces Context Mode routing rules in Hermes Agent. Blocks high-output terminal commands, sandboxes large results, and tracks context savings.

## Hooks

| Hook | Purpose |
|------|---------|
| `pre_tool_call` | Block curl/wget/build, redirect to ctx_execute (MCP) |
| `transform_tool_result` | Sandbox outputs >3KB to files |
| `pre_llm_call` | Inject routing instructions (once/session) |
| `on_session_start` | Initialize metrics tracking |
| `on_session_end` | Persist metrics to SQLite |

## Install

```bash
cp -r .hermes-plugin ~/.hermes/plugins/hermes-context-mode
```

Then enable in `~/.hermes/config.yaml`:
```yaml
plugins:
  enabled:
    - hermes-context-mode
```

Restart gateway: `hermes gateway restart`

## Requirements

- Hermes Agent installed
- Context Mode MCP server configured (for ctx_execute sandbox)

## Files

```
~/.hermes/plugins/hermes-context-mode/
├── plugin.yaml     # manifest
├── __init__.py     # hooks
├── metrics.db      # SQLite metrics (auto-created)
└── sandbox/        # sandboxed output files (auto-created)
```
