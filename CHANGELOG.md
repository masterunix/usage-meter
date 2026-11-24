# Changelog

## 0.2.0

- **Subagent types to leave alone** (`skipAgents`): subagent types that are never warned, such as `Explore, Plan`; `*` matches anything, as in `my-plugin:*`.
- **`/usage-meter mute`** and **`unmute`**: quiet the warnings for the current session and its subagents only. The mute outlasts a reload or a resume, and is cleaned up after a week.
- `/usage-meter` says when the session is muted and which subagent types are skipped.
- An icon, a changelog, and checks that validate and test the mod on every push.

## 0.1.0

- First release: warnings for the model at configurable thresholds of the 5-hour window (once each per window), separate thresholds and wording for subagents, optional 7-day thresholds, wording built from the stopping point, a custom message, a notice for you, an optional status entry, and `/usage-meter [on|off]`.
