# usage-meter

[![checks](https://github.com/masterunix/usage-meter/actions/workflows/checks.yml/badge.svg)](https://github.com/masterunix/usage-meter/actions/workflows/checks.yml)

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps an eye on your claude.ai plan's usage limits and warns Claude before the 5-hour window runs out, so the work reaches a clean stopping point instead of being cut off mid-edit.

- **Claude is told** at the thresholds you choose (70, 80 and 90% by default), once each per window, with wording built from your stopping point: a heads-up first, then "stop now".
- **Subagents get their own thresholds** and wording: wrap up and hand back a short report, then stop and say what is and isn't done.
- **You see a notice** whenever Claude is warned, and `/usage-meter` prints the figures on demand.
- **Exceptions where you want them:** leave chosen subagent types alone, mute one session, or switch the mod off in one project.
- **No setup to break:** it reads the figures from Claude Code itself. It doesn't touch your status line, run scripts, or edit your settings files.

## What it looks like

When the 5-hour window passes 80%, Claude reads this with the result of the tool call it just made:

> Usage limit: 81% of the 5-hour window used (resets 19:10, in 1 h 12 min). Context: 142k tokens. That has reached the 80% stopping point. Bring the work to a clean stopping point: finish or set aside the step in progress so nothing is left half-done, write down where to resume, and stop so the user can decide what comes next.

At the same moment you see a notice:

> usage-meter: 81% of the 5-hour limit used, resets 19:10. Claude was told to head for a stopping point.

And at any time:

```
/usage-meter
5h 81% (resets 19:10, in 1 h 12 min) | 7d 23% (resets Sat 09:00, in 3 d 13 h) | context 142k of 200k | warnings on: 70, 80, 90 (subagents 80, 90), stop at 80%
```

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install usage-meter --marketplace masterunix/usage-meter
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it load in every session). The settings screen comes next; the defaults are a good start. The mod works in that session at once.

From a shell instead:

```sh
claude plugin install usage-meter --marketplace masterunix/usage-meter
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `masterunix/usage-meter`, then **Add plugin**.

To update later: `claude plugin update usage-meter@masterunix-usage-meter`, then `/reload-plugins` in an open session.

### Requirements

- **Claude Code 2.1.290 or later** (built and tested on 2.1.330). Mods are on by default from 2.1.287.
- **Claude Code itself:** mods run in the terminal, the desktop app's Code tab and the VS Code extension, not in claude.ai chat or Cowork.
- **A claude.ai subscription**, signed in with `/login`. Claude Code reports the 5-hour and 7-day figures only for subscriptions, after a session's first reply. With an API key there are no figures: the mod stays quiet, and `/usage-meter` says so.

## Use

| Command | What it does |
|---|---|
| `/usage-meter` | One line: the 5-hour and 7-day figures with their reset times, the context size, and the warning settings. Runs even while Claude is working. |
| `/usage-meter off` | Stops the warnings in every session, until `/usage-meter on`. Same as turning off **Warnings** in `/config`. The figures and the command keep working. |
| `/usage-meter on` | Starts them again. |
| `/usage-meter mute` | Quiets the warnings for this session and its subagents only. Other sessions are unaffected, and the mute outlasts a reload or a resume. |
| `/usage-meter unmute` | Brings them back for this session. |

To remove the mod completely: `/plugin`, then the **Installed** tab, or `claude plugin uninstall usage-meter@masterunix-usage-meter`.

## Settings

Change these in `/config` (or on the install screen). A change takes effect at once.

| Setting | Default | What it does |
|---|---|---|
| **Warnings** (`enabled`) | on | Master switch for warnings. |
| **Thresholds** (`marks`) | `70, 80, 90` | Percent of the 5-hour window at which the main conversation is told, once each per window. |
| **Subagent thresholds** (`agentMarks`) | `80, 90` | The same for subagents. Below the highest they are told to wrap up and report; at the highest, to stop and report. Empty means subagents are never told. |
| **Subagent types to leave alone** (`skipAgents`) | none | Subagent types that are never told, such as `Explore, Plan`. `*` matches anything, as in `my-plugin:*`. Case doesn't matter. |
| **Stopping point** (`stopAt`) | `80` | Where Claude should be at a stopping point. Below it the warning is a heads-up to plan for it; at it, "stop"; past it, "stop now". |
| **What to do at the stopping point** (`instruction`) | built-in text | Your own words for what Claude should do, for example *"Commit the work, write down where to resume, and stop so the conversation can be compacted."* |
| **7-day thresholds** (`weeklyMarks`) | none | Optional thresholds for the 7-day window, for the main conversation. Below the highest, Claude is asked to prefer finishing over starting large new tasks and to mention it to you; at the highest, to follow your instruction. |
| **Custom message** (`template`) | none | Replaces the main conversation's warning text entirely. See below. |
| **Show a notice** (`toast`) | on | The short notice you see when Claude is warned. |
| **Status entry** (`showStatus`) | off | Keeps `5h 42% · 7d 12%` under the prompt. Off by default, so it doesn't crowd a status line you already have. |

Thresholds are written as comma-separated percents, such as `60, 75, 90`.

### Exceptions

| You want | Do this |
|---|---|
| No warnings for subagents at all | Clear **Subagent thresholds**. |
| No warnings for some kinds of subagent | List their types in **Subagent types to leave alone**. The type is the name you see when Claude starts one, such as `Explore`. |
| Quiet for the session you're in | `/usage-meter mute`. |
| Off in one project | Add `"enabledPlugins": { "usage-meter@masterunix-usage-meter": false }` to that project's `.claude/settings.local.json` (just you) or `.claude/settings.json` (everyone on the project). |
| Off everywhere for now | `/usage-meter off`. |

Thresholds and wording can't differ per project: Claude Code keeps a plugin's settings in your user settings only, and reading a file of each project's would cost the mod its "no file access" promise.

### Custom message

Set **Custom message** to take over the wording of the main conversation's warnings. These placeholders are filled in:

| Placeholder | Example |
|---|---|
| `{used}` | `81%` |
| `{window}` | `5-hour` or `7-day` |
| `{resets}` | `resets 19:10, in 1 h 12 min` |
| `{mark}` | `80%`, the threshold just passed |
| `{stopAt}` | `80%` |
| `{instruction}` | your instruction, or the built-in one |
| `{context}` | `142k tokens` |

For example: `Usage is at {used} of the {window} window ({resets}). {instruction}`

## How it works

- **The figures** come from Claude Code: `$.session.usage()` on each tool call, and the `session.measure` event for the status entry. They are the same figures the status line gets, from the latest response of the API, so every session reads the account's current usage.
- **The warning** is added to the result of the tool call that crossed a threshold (a `PostToolUse` hook returning `additionalContext`), so Claude reads it at its next step. A turn with no tool calls isn't interrupted.
- **Once per window:** which thresholds were told is remembered per session, per subagent and per window in the mod's own store, so a reload or a resumed session doesn't repeat a warning. When the window resets, the thresholds start over. Records for windows that have ended, and mutes older than a week, are cleaned up when a session starts.
- **It never gets in the way:** an error inside the mod is swallowed, and a tool call is never blocked, delayed for long, or changed.

### What it can access

`claude plugin validate` on this folder lists everything the mod does. It hooks `session.start`, `session.measure`, `classic.PostToolUse`, `classic.PostToolUseFailure` and its own `/usage-meter` command, and it calls:

| Call | Why |
|---|---|
| `$.session.usage` | Read the usage figures and context size. |
| `$.clock.now` | Work out reset times. |
| `$.store.get`, `set`, `keys`, `delete` | Remember which thresholds were told, and which sessions are muted. |
| `$.session.id` | Know which session `/usage-meter mute` applies to. |
| `$.ui.toast`, `$.ui.status` | The notice and the optional status entry. |
| `$.command.register` | The `/usage-meter` command. |
| `$.config.list`, `$.config.set` | `/usage-meter on` and `off` flip the mod's own **Warnings** setting. |

No file access, no processes, no network, no model calls.

## Develop

```sh
git clone https://github.com/masterunix/usage-meter
cd usage-meter
claude --plugin-dir .        # run a session with the mod loaded; edits reload it
claude plugin test .         # the tests in tests/
claude plugin validate .     # what the mod hooks and calls, and any problem
```

The logic (thresholds, windows, wording) is in `hooks/meter.ts`; `hooks/register.ts` wires it into Claude Code. After the first interactive `claude --plugin-dir .`, Claude Code writes the API's type declarations to `.claude-plugin/types/`, and `tsc -p .` type-checks the mod.

## License

[MIT](LICENSE)
