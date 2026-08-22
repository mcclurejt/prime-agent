---
name: rlm-heartbeat
description: Manage agent-owned RLM heartbeats from IPython. Use proactively whenever the agent would otherwise sleep, wait, poll, or recheck later to monitor changing local or remote state; no explicit user request is required. Do not use merely to await a native child, and use the user's /heartbeat only when explicitly requested.
---

# RLM Heartbeat

RLM heartbeats are internal recurring prompts for the current agent session.
They are separate from the user's visible `/heartbeat`: this skill cannot read,
replace, pause, resume, or clear that user-level heartbeat.

## Choose the nonblocking wait path

Never put `time.sleep`, `asyncio.sleep`, bare or shell `sleep`, subprocess sleep,
or a sleep loop in a tool call merely to check state later—not even for one
delayed check.

| Situation | Action |
|---|---|
| Future or repeated local/remote state | Create an agent-owned heartbeat and end the turn. This includes benchmark submissions, CI runs, deployments, queues, services, and other systems whose state changes later. |
| Native RLM child | End the turn and await its `agent_message`; do not poll it or create a heartbeat merely to await completion. |
| Long local process | Launch it detached with log and completion-sentinel artifacts, create a heartbeat to inspect those artifacts, and end the turn. |
| Short UI/service readiness inside one atomic interaction | Use the tool's condition-aware bounded wait or readiness primitive, never an arbitrary fixed-duration sleep. |

If you are about to issue a second manual status check, create the heartbeat
instead. An explicit user request is not required.

Call directly from IPython:

```python
await rlm_heartbeat.create("check test progress", interval="5m", label="tests")
await rlm_heartbeat.create("watch build", delivery_mode="follow_up")
await rlm_heartbeat.list()
await rlm_heartbeat.update("job-id", status="pause")
await rlm_heartbeat.delete("job-id")
```

## API

- `await rlm_heartbeat.list(include_inactive=False)` — list this session's
  internal RLM heartbeats. By default this includes active and paused entries.
- `await rlm_heartbeat.create(instruction, interval=None, label=None,
  delivery_mode=None)` — create a recurring heartbeat for this session. The
  default interval is every 5 minutes. Multiple RLM heartbeats may run at once;
  use labels to distinguish them. `delivery_mode` is `"steer"` (default) or
  `"follow_up"`.
- `await rlm_heartbeat.update(id, instruction=None, interval=None, label=None,
  status=None, delivery_mode=None)` — update one RLM heartbeat by id. `status`
  may be `"pause"` or `"resume"`; `delivery_mode` may be `"steer"` or
  `"follow_up"`.
- `await rlm_heartbeat.delete(id)` — cancel a heartbeat.

## Delivery mode

Each heartbeat has a delivery mode controlling how the scheduled prompt reaches
the session when it is busy:

- `steer` (default): interrupt the current turn so the heartbeat runs promptly.
- `follow_up`: wait for the current turn to finish before running the heartbeat.

## Rules

- Use this proactively for agent-internal recurring checks and asynchronous task
  coordination; do not wait for the user to request a heartbeat.
- Do not use this skill to satisfy a request to configure `/heartbeat`; that is
  a separate user-level surface.
- Keep instructions specific and actionable so each recurring turn knows what
  to inspect, when to stop, and when to delete the heartbeat.
