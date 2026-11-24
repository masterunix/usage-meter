// usage-meter: tells Claude, and you, when the account's usage limit runs high.
//
// Figures come from Claude Code itself ($.session.usage() and session.measure),
// the warning reaches the model as additionalContext on the tool call that
// crossed a threshold, and which thresholds were told is kept in $.store per
// session, audience and window, so a reload or a resume does not repeat one.

import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import {
  asTold,
  claimMarks,
  findWindow,
  isStale,
  modelMessage,
  personToast,
  readSettings,
  statusText,
  summaryLine,
  type Audience,
  type Settings,
  type Told,
} from './meter'

const PREFIX = 'told/'

type ToolEvent = { session_id: string; agent_id?: string }

// Module state: a reload evaluates the module afresh, so these start over
// while $.store keeps what was told.
let settings: Settings = readSettings({})
// Records read this load, so a run of tool calls past a mark reads the store once.
const cache = new Map<string, Told | undefined>()
// One check at a time: parallel tool calls must not both tell the same mark.
let queue: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)

  return run
}

async function recall($: EngineInterface, key: string): Promise<Told | undefined> {
  if (!cache.has(key)) cache.set(key, asTold(await $.store.get(key)))

  return cache.get(key)
}

/** The marks newly passed for one audience and window, recorded as told. */
async function claim(
  $: EngineInterface,
  key: string,
  marks: readonly number[],
  reading: SessionRateLimit,
  now: number,
): Promise<number[]> {
  const { fresh, next } = claimMarks(marks, reading, await recall($, key), now)
  if (next) {
    await $.store.set(key, next)
    cache.set(key, next)
  } else if (next === null) {
    await $.store.delete(key)
    cache.set(key, undefined)
  }

  return fresh
}

/** What to tell the model after this tool call, if anything. */
async function check($: EngineInterface, e: ToolEvent): Promise<string | undefined> {
  const usage = await $.session.usage()
  const five = findWindow(usage.rateLimits, 'five_hour')
  const week = findWindow(usage.rateLimits, 'seven_day')
  if (!five && !week) return undefined

  const now = await $.clock.now()
  const audience: Audience = e.agent_id ? 'agent' : 'main'
  const who = `${PREFIX}${e.session_id || 'session'}/${e.agent_id || 'main'}`
  const notes: string[] = []
  const windows: Array<[SessionRateLimit | undefined, readonly number[]]> = [
    [five, audience === 'agent' ? settings.agentMarks : settings.marks],
    [audience === 'main' ? week : undefined, settings.weeklyMarks],
  ]

  for (const [reading, marks] of windows) {
    if (!reading || marks.length === 0) continue
    const fresh = await claim($, `${who}/${reading.kind}`, marks, reading, now)
    if (fresh.length === 0) continue
    const note = {
      audience,
      reading,
      mark: Math.max(...fresh),
      settings,
      now,
      contextTokens: usage.context.tokens,
    }
    notes.push(modelMessage(note))
    if (audience === 'main' && settings.toast) $.ui.toast(personToast(note), { timeoutMs: 8000 })
  }

  return notes.length ? notes.join('\n\n') : undefined
}

/** The warning for this tool call, or nothing; never an error. */
async function warning($: EngineInterface, e: ToolEvent): Promise<string | undefined> {
  if (!settings.enabled) return undefined
  try {
    return await serially(() => check($, e))
  } catch {
    return undefined
  }
}

/** Drops kept records whose window has reset, so the store stays small. */
async function prune($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const keys = (await $.store.keys()).filter(key => key.startsWith(PREFIX)).slice(0, 300)
  for (const key of keys) {
    const record = asTold(await $.store.get(key))
    if (!record || isStale(record, now)) await $.store.delete(key)
  }
}

/** Flips the `enabled` setting through /config, as the person would. */
async function switchWarnings($: EngineInterface, value: boolean): Promise<string | undefined> {
  const row = (await $.config.list()).find(
    one => one.provider.plugin === $.plugin.name && one.key.endsWith('.enabled'),
  )
  if (!row) return 'its setting is not in /config'

  return (await $.config.set({ key: row.key, value })).deny
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'usage-meter',
        description: 'Show the 5-hour and 7-day usage figures; "on" or "off" switches the warnings',
        argumentHint: '[on|off]',
        immediate: true,
      })
    } catch {
      // Without the command the warnings still work.
    }
    try {
      await prune($)
    } catch {
      // Older records then stay a while longer.
    }
    try {
      $.ui.status(settings.showStatus ? statusText((await $.session.usage()).rateLimits) : undefined)
    } catch {
      // The status entry is optional.
    }

    return next(e)
  })

  on('session.measure', ($, e, next) => {
    try {
      if (settings.showStatus && e.changed.includes('rateLimits')) $.ui.status(statusText(e.rateLimits))
    } catch {
      // The status entry is optional.
    }

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    const text = await warning($, e)

    return text ? { ...result, additionalContext: [...(result.additionalContext ?? []), text] } : result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const result = await next(e)
    const text = await warning($, e)

    return text ? { ...result, additionalContext: [...(result.additionalContext ?? []), text] } : result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-meter' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      let deny: string | undefined
      try {
        deny = await switchWarnings($, arg === 'on')
      } catch (error) {
        deny = reason(error)
      }

      return {
        text: deny
          ? `usage-meter: could not switch the warnings ${arg} (${deny}). Use /config instead.`
          : `usage-meter: warnings ${arg}.`,
        isTextDisplayOnly: true,
      }
    }

    if (arg && arg !== 'status') {
      return {
        text: 'usage-meter: /usage-meter shows the figures; /usage-meter on or off switches the warnings.',
        isTextDisplayOnly: true,
      }
    }

    try {
      const usage = await $.session.usage()

      return { text: summaryLine(usage, settings, await $.clock.now()), isTextDisplayOnly: true }
    } catch (error) {
      return { text: `usage-meter: could not read the figures (${reason(error)}).`, isTextDisplayOnly: true }
    }
  })
}
