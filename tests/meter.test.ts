import type { On, SessionRateLimit, SessionUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// Nothing sits beneath the plugin in a test: the hooks registered here stand
// for Claude Code. `$.session.usage()` reads the figures a test sets, the
// store and the clock live in memory, and a toast is recorded.

const NOW = Date.parse('2026-11-24T10:00:00Z')
const RESET = '2026-11-24T12:30:00Z'
const NEXT_RESET = '2026-11-24T17:30:00Z'
const WEEK_RESET = '2026-11-28T09:00:00Z'

type World = {
  setFive: (percentUsed: number, resetsAt?: string) => void
  setWeek: (percentUsed: number) => void
  clear: () => void
  toasts: string[]
  statuses: Array<string | undefined>
}

function world(on: On, store: Record<string, unknown> = {}): World {
  let limits: SessionRateLimit[] = []
  const toasts: string[] = []
  const statuses: Array<string | undefined> = []

  mock.store(on, store)
  mock.clock(on, { now: NOW })
  on('session.usage', () => {
    const usage: SessionUsage = {
      startedAt: NOW,
      context: { tokens: 53_000, window: 200_000, percent: 27 },
      rateLimits: limits,
    }

    return { value: usage }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))

  const set = (kind: string, percentUsed: number, resetsAt?: string): void => {
    limits = [...limits.filter(one => one.kind !== kind), { kind, percentUsed, resetsAt }]
  }

  return {
    setFive: (percentUsed, resetsAt = RESET) => set('five_hour', percentUsed, resetsAt),
    setWeek: percentUsed => set('seven_day', percentUsed, WEEK_RESET),
    clear: () => {
      limits = []
    },
    toasts,
    statuses,
  }
}

/** One tool call, as Claude Code raises PostToolUse; what the model is told after it. */
async function toolCall($: Engine, agentId?: string, agentType = 'general-purpose'): Promise<string> {
  const result = await $.classic.PostToolUse({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: '' },
    tool_use_id: `t${Math.random()}`,
    ...(agentId ? { agent_id: agentId, agent_type: agentType } : {}),
  })

  return (result.additionalContext ?? []).join('\n')
}

test('each threshold is told once per window', async ($, on) => {
  const w = world(on)

  w.setFive(65)
  expect(await toolCall($)).toBe('')

  w.setFive(72)
  const first = await toolCall($)
  expect(first).toContain('72% of the 5-hour window used')
  expect(first).toContain('Heads-up: the stopping point is 80%')
  expect(first).toContain('Context: 53k tokens.')
  expect(await toolCall($)).toBe('')

  w.setFive(76)
  expect(await toolCall($)).toBe('')

  w.setFive(81)
  expect(await toolCall($)).toContain('That has reached the 80% stopping point.')
  expect(await toolCall($)).toBe('')

  w.setFive(90)
  expect(await toolCall($)).toContain('That is past the 80% stopping point.')
  expect(await toolCall($)).toBe('')

  expect(w.toasts).toHaveLength(3)
  expect(w.toasts[0]).toContain('72% of the 5-hour limit used, resets')
  expect(w.toasts[0]).toContain('Claude was told to plan for a stop at 80%.')
  expect(w.toasts[1]).toContain('Claude was told to head for a stopping point.')
})

test('a jump past several thresholds tells once, at the highest', async ($, on) => {
  const w = world(on)

  w.setFive(93)
  const told = await toolCall($)
  expect(told).toContain('past the 80% stopping point')
  expect(told.match(/Usage limit/g)).toHaveLength(1)

  w.setFive(97)
  expect(await toolCall($)).toBe('')
})

test('a new window starts the thresholds over', async ($, on) => {
  const w = world(on)

  w.setFive(85)
  expect(await toolCall($)).toContain('reached the 80% stopping point')
  expect(await toolCall($)).toBe('')

  w.setFive(71, NEXT_RESET)
  expect(await toolCall($)).toContain('Heads-up')
})

test('a reset is noticed even without reset times', async ($, on) => {
  const w = world(on)

  w.setFive(85, undefined)
  expect(await toolCall($)).toContain('reached the 80% stopping point')

  // The figure falls below every mark told: that is a new window.
  w.setFive(12, undefined)
  expect(await toolCall($)).toBe('')

  w.setFive(71, undefined)
  expect(await toolCall($)).toContain('Heads-up')
})

test('subagents have their own thresholds and wording, and no toast', async ($, on) => {
  const w = world(on)

  w.setFive(75)
  expect(await toolCall($, 'agent-1')).toBe('')

  w.setFive(82)
  const wrapUp = await toolCall($, 'agent-1')
  expect(wrapUp).toContain('finish the step you are on')
  expect(await toolCall($, 'agent-1')).toBe('')

  w.setFive(91)
  expect(await toolCall($, 'agent-1')).toContain(
    'Stop here and hand back what you have: say what is done and what is not.',
  )

  // Another subagent, and the main conversation, are told on their own.
  expect(await toolCall($, 'agent-2')).toContain('Stop here')
  expect(await toolCall($)).toContain('past the 80% stopping point')
  expect(w.toasts).toHaveLength(1)
})

test('switched off, nothing is told', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)

  w.setFive(95)
  w.setWeek(95)
  expect(await toolCall($)).toBe('')
  expect(await toolCall($, 'agent-1')).toBe('')
  expect(w.toasts).toHaveLength(0)
})

test('without figures (an API key), nothing is told', async ($, on) => {
  const w = world(on)

  w.clear()
  expect(await toolCall($)).toBe('')
  expect(await toolCall($, 'agent-1')).toBe('')
  expect(w.toasts).toHaveLength(0)
})

test(
  'the wording follows the stopping point and the instruction',
  {
    options: {
      marks: '50, 60, 75',
      stopAt: 60,
      instruction: 'Commit the work and stop.',
      toast: false,
    },
  },
  async ($, on) => {
    const w = world(on)

    w.setFive(55)
    const before = await toolCall($)
    expect(before).toContain('the stopping point is 60% of this window')
    expect(before).toContain('When usage reaches it: Commit the work and stop.')

    w.setFive(61)
    expect(await toolCall($)).toContain('That has reached the 60% stopping point. Commit the work and stop.')

    w.setFive(77)
    expect(await toolCall($)).toContain(
      'past the 60% stopping point. Do this now, before the limit is reached: Commit the work and stop.',
    )
    expect(w.toasts).toHaveLength(0)
  },
)

test('7-day thresholds warn the main conversation only', { options: { weeklyMarks: '50, 90' } }, async ($, on) => {
  const w = world(on)

  w.setFive(10)
  w.setWeek(55)
  expect(await toolCall($, 'agent-1')).toBe('')
  const told = await toolCall($)
  expect(told).toContain('55% of the 7-day window used')
  expect(told).toContain('prefer finishing the current work')
  expect(await toolCall($)).toBe('')

  w.setWeek(92)
  expect(await toolCall($)).toContain('The weekly limit is close.')
  expect(w.toasts.at(-1)).toContain('92% of the 7-day limit used')
})

test(
  'a custom message replaces the wording',
  { options: { template: 'LIMIT {used} of {window} at mark {mark}, stop at {stopAt}: {instruction}' } },
  async ($, on) => {
    const w = world(on)

    w.setFive(81)
    expect(await toolCall($)).toMatch(/^LIMIT 81% of 5-hour at mark 80%, stop at 80%: Bring the work/)
  },
)

test('a warning told before a reload or a resume is not repeated', async ($, on) => {
  const w = world(on, {
    'told/s1/main/five_hour': { resetsAt: RESET, told: [70, 80], at: NOW - 60_000 },
  })

  w.setFive(84)
  expect(await toolCall($)).toBe('')

  w.setFive(90)
  expect(await toolCall($)).toContain('past the 80% stopping point')
})

test('a failure inside the meter never fails the tool call', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.usage', () => {
    throw new Error('no figures today')
  })
  on('classic.PostToolUse', () => ({ additionalContext: ['from another hook'] }))

  expect(await toolCall($)).toBe('from another hook')
})

test('PostToolUseFailure warns too', async ($, on) => {
  const w = world(on)

  w.setFive(72)
  const result = await $.classic.PostToolUseFailure({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'false' },
    tool_use_id: 'fail-1',
    error: 'exit 1',
  })
  expect((result.additionalContext ?? []).join('')).toContain('Heads-up')
})

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

function commandWorld(on: On): string[] {
  const sets: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('config.list', () => ({
    value: [
      {
        key: 'usage-meter.enabled',
        label: 'Warnings',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'usage-meter', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', (_, e) => {
    sets.push(`${e.key}=${String(e.value)}`)

    return { value: e.value }
  })

  return sets
}

async function command($: Engine, args: string): Promise<string> {
  const result = await $.command.run({
    command: 'usage-meter',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  return result.text ?? ''
}

test('/usage-meter prints the figures in one line', async ($, on) => {
  const w = world(on)
  commandWorld(on)
  await $.session.start(START)

  w.setFive(72)
  w.setWeek(7)
  const line = await command($, '')
  expect(line).toMatch(/^5h 72% \(resets \d\d:\d\d, in 2 h 30 min\) \| 7d 7% \(resets \w{3} \d\d:\d\d, in 3 d 23 h\)/)
  expect(line).toContain('context 53k of 200k')
  expect(line).toContain('warnings on: 70, 80, 90 (subagents 80, 90), stop at 80%')

  w.clear()
  expect(await command($, '')).toContain('No usage figures yet')
})

test('/usage-meter on and off switch the warnings through /config', async ($, on) => {
  world(on)
  const sets = commandWorld(on)
  await $.session.start(START)

  expect(await command($, 'off')).toBe('warnings off.')
  expect(await command($, 'on')).toBe('warnings on.')
  expect(sets).toEqual(['usage-meter.enabled=false', 'usage-meter.enabled=true'])
  expect(await command($, 'sideways')).toContain('mute or unmute, for this session only')
})

test('/usage-meter mute quiets this session and its subagents until unmuted', async ($, on) => {
  const w = world(on)
  commandWorld(on)
  await $.session.start(START)

  expect(await command($, 'mute')).toContain('muted for this session')
  w.setFive(95)
  expect(await toolCall($)).toBe('')
  expect(await toolCall($, 'agent-1')).toBe('')
  expect(await command($, '')).toContain('warnings muted for this session (/usage-meter unmute)')

  expect(await command($, 'unmute')).toBe('warnings back on for this session.')
  expect(await toolCall($)).toContain('past the 80% stopping point')
  expect(await toolCall($, 'agent-1')).toContain('Stop here')
})

test('a mute outlasts a reload or a resume', async ($, on) => {
  const w = world(on, { 'muted/s1': { at: NOW - 60_000 } })

  w.setFive(95)
  expect(await toolCall($)).toBe('')
  expect(w.toasts).toHaveLength(0)
})

test(
  'subagent types on the skip list are left alone',
  { options: { skipAgents: 'Explore, my-plugin:*' } },
  async ($, on) => {
    const w = world(on)

    w.setFive(95)
    expect(await toolCall($, 'a1', 'Explore')).toBe('')
    expect(await toolCall($, 'a2', 'explore')).toBe('')
    expect(await toolCall($, 'a3', 'my-plugin:scout')).toBe('')
    expect(await toolCall($, 'a4', 'general-purpose')).toContain('Stop here')
    expect(await toolCall($)).toContain('past the 80% stopping point')
  },
)

test('the status entry is off unless asked for', async ($, on) => {
  const w = world(on)
  commandWorld(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start(START)

  w.setFive(42)
  await $.session.measure({
    context: { tokens: 1000, window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: RESET }],
    changed: ['rateLimits'],
  })
  expect(w.statuses.filter(Boolean)).toHaveLength(0)
})

test('the status entry shows both windows', { options: { showStatus: true } }, async ($, on) => {
  const w = world(on)
  commandWorld(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure({
    context: { tokens: 1000, window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: 12, resetsAt: WEEK_RESET },
    ],
    changed: ['rateLimits'],
  })
  expect(w.statuses.at(-1)).toBe('5h 42% · 7d 12%')
})

test('old records are cleared when a session starts', async ($, on) => {
  const store: Record<string, unknown> = {
    'told/old/main/five_hour': { resetsAt: '2026-11-20T12:00:00Z', told: [70], at: NOW - 4 * 86_400_000 },
    'told/undated/agent-9/five_hour': { resetsAt: null, told: [80], at: NOW - 9 * 86_400_000 },
    'told/s1/main/five_hour': { resetsAt: RESET, told: [70], at: NOW },
    'told/s1/main/seven_day': { resetsAt: null, told: [50], at: NOW - 86_400_000 },
    'muted/old': { at: NOW - 9 * 86_400_000 },
    'muted/s1': { at: NOW - 3_600_000 },
  }
  mock.clock(on, { now: NOW })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.delete', (_, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  commandWorld(on)
  await $.session.start(START)

  expect(Object.keys(store)).toEqual(['told/s1/main/five_hour', 'told/s1/main/seven_day', 'muted/s1'])
})
