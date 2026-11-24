// The meter's own logic: settings, thresholds, windows and wording.
// Pure functions only, so the hooks module stays thin and the tests can read
// every message without a session.

import type { PluginOptions, SessionRateLimit, SessionUsage } from 'claude-code'

export type Settings = {
  enabled: boolean
  marks: number[]
  agentMarks: number[]
  weeklyMarks: number[]
  stopAt: number
  instruction: string
  template: string
  toast: boolean
  showStatus: boolean
}

export type Audience = 'main' | 'agent'

/** What the model is asked to do at the stopping point, unless the person sets their own. */
export const DEFAULT_INSTRUCTION =
  'Bring the work to a clean stopping point: finish or set aside the step in progress so ' +
  'nothing is left half-done, write down where to resume, and stop so the user can decide ' +
  'what comes next.'

/** Reset times this close together are read as one window. */
const SAME_WINDOW_MS = 5 * 60 * 1000

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  spend_limit: 'spend',
}

const SHORT: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ---------------------------------------------------------------- settings

/**
 * Thresholds from a setting such as "70, 80, 90": whole or decimal percents
 * above 0 and up to 100, sorted, each once. Anything else is ignored.
 */
export function parseMarks(value: unknown): number[] {
  const parts = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'number'
      ? [String(value)]
      : typeof value === 'string'
        ? value.split(/[\s,;]+/)
        : []
  const marks = parts
    .map(part => Number(part.replace(/%$/, '')))
    .filter(mark => Number.isFinite(mark) && mark > 0 && mark <= 100)

  return [...new Set(marks)].sort((a, b) => a - b)
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readSettings(options: PluginOptions): Settings {
  const stopAt = Number(options.stopAt)

  return {
    enabled: flag(options.enabled, true),
    marks: parseMarks(options.marks ?? '70, 80, 90'),
    agentMarks: parseMarks(options.agentMarks ?? '80, 90'),
    weeklyMarks: parseMarks(options.weeklyMarks ?? ''),
    stopAt: Number.isFinite(stopAt) && stopAt > 0 && stopAt <= 100 ? stopAt : 80,
    instruction: text(options.instruction) || DEFAULT_INSTRUCTION,
    template: text(options.template),
    toast: flag(options.toast, true),
    showStatus: flag(options.showStatus, false),
  }
}

// ----------------------------------------------------------------- windows

export function findWindow(
  limits: readonly SessionRateLimit[],
  kind: string,
): SessionRateLimit | undefined {
  return limits.find(limit => limit.kind === kind && Number.isFinite(limit.percentUsed))
}

function epoch(iso: string | null | undefined): number | undefined {
  if (typeof iso !== 'string') return undefined
  const ms = Date.parse(iso)

  return Number.isFinite(ms) ? ms : undefined
}

/** What the meter remembers for one audience and one window kind. */
export type Told = { resetsAt: string | null; told: number[]; at: number }

export function asTold(value: unknown): Told | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Told>
  const told = Array.isArray(record.told)
    ? record.told.filter((mark): mark is number => typeof mark === 'number')
    : []

  return {
    resetsAt: typeof record.resetsAt === 'string' ? record.resetsAt : null,
    told,
    at: typeof record.at === 'number' ? record.at : 0,
  }
}

/**
 * Whether a reading belongs to the window a record was made in. A window's
 * figure only grows, so a figure below a mark already told means the window
 * reset; otherwise two reset times more than five minutes apart do.
 */
export function isSameWindow(record: Told, reading: SessionRateLimit): boolean {
  const lowest = Math.min(...record.told)
  if (record.told.length > 0 && reading.percentUsed < lowest) return false
  const was = epoch(record.resetsAt)
  const now = epoch(reading.resetsAt)
  if (was === undefined || now === undefined) return true

  return Math.abs(was - now) <= SAME_WINDOW_MS
}

/**
 * The marks the reading has passed that this audience has not been told
 * about in this window, and what to keep afterwards: a new record, `null` to
 * forget the old one (its window ended), or `undefined` to leave it.
 */
export function claimMarks(
  marks: readonly number[],
  reading: SessionRateLimit,
  record: Told | undefined,
  now: number,
): { fresh: number[]; next?: Told | null } {
  const isSame = record !== undefined && isSameWindow(record, reading)
  const told = isSame ? record.told : []
  const passed = marks.filter(mark => reading.percentUsed >= mark)
  const fresh = passed.filter(mark => !told.includes(mark))

  if (fresh.length > 0) {
    return {
      fresh,
      next: {
        resetsAt: reading.resetsAt ?? null,
        told: [...new Set([...told, ...passed])].sort((a, b) => a - b),
        at: now,
      },
    }
  }

  return record !== undefined && !isSame ? { fresh: [], next: null } : { fresh: [] }
}

/** Whether a kept record can go: its window reset, or it is over eight days old. */
export function isStale(record: Told, now: number): boolean {
  const reset = epoch(record.resetsAt)
  if (reset !== undefined) return reset + 60 * 60 * 1000 < now

  return record.at + 8 * 24 * 60 * 60 * 1000 < now
}

// ---------------------------------------------------------------- wording

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "19:10" for a reset within a day, "Mon 09:00" further out, in local time. */
export function clockTime(iso: string, now: number): string {
  const at = new Date(iso)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`

  return at.getTime() - now > 20 * 60 * 60 * 1000 ? `${DAYS[at.getDay()]} ${time}` : time
}

/** "2 h 10 min", "45 min", "3 d 4 h". */
export function untilText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)

  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`
}

/** "resets 19:10, in 2 h 10 min", or '' when the window gives no reset time. */
export function resetText(reading: SessionRateLimit, now: number): string {
  if (epoch(reading.resetsAt) === undefined) return ''
  const iso = reading.resetsAt as string

  return `resets ${clockTime(iso, now)}, in ${untilText(iso, now)}`
}

export function percent(reading: SessionRateLimit): string {
  return `${Math.floor(reading.percentUsed)}%`
}

export function label(kind: string): string {
  return LABELS[kind] ?? kind
}

function head(reading: SessionRateLimit, now: number): string {
  const reset = resetText(reading, now)

  return `Usage limit: ${percent(reading)} of the ${label(reading.kind)} window used${reset ? ` (${reset})` : ''}.`
}

function contextText(tokens: number | undefined): string {
  return tokens ? `${Math.round(tokens / 1000)}k tokens` : ''
}

/** Where the reading stands against the stopping point. */
export type Phase = 'before' | 'at' | 'past'

export function phaseOf(used: number, mark: number, stopAt: number): Phase {
  if (used < stopAt) return 'before'

  return mark > stopAt ? 'past' : 'at'
}

export type Note = {
  audience: Audience
  reading: SessionRateLimit
  /** The highest mark passed and not yet told. */
  mark: number
  settings: Settings
  now: number
  contextTokens?: number
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/** The message for the model. */
export function modelMessage(note: Note): string {
  const { audience, reading, mark, settings, now, contextTokens } = note
  const top = head(reading, now)

  if (audience === 'agent') {
    const highest = Math.max(...settings.agentMarks)

    return mark >= highest
      ? `${top} Stop here and hand back what you have: say what is done and what is not.`
      : `${top} The session that started you will have to stop soon: finish the step you are on, ` +
          'leave out anything optional, and hand back a short report.'
  }

  const context = contextText(contextTokens)
  if (settings.template) {
    return fill(settings.template, {
      used: percent(reading),
      window: label(reading.kind),
      resets: resetText(reading, now),
      mark: `${mark}%`,
      stopAt: `${settings.stopAt}%`,
      instruction: settings.instruction,
      context,
    })
  }

  const lead = context ? `${top} Context: ${context}.` : top

  if (reading.kind === 'seven_day') {
    const highest = Math.max(...settings.weeklyMarks)

    return mark >= highest
      ? `${lead} The weekly limit is close. ${settings.instruction}`
      : `${lead} Keep it in mind: prefer finishing the current work over starting large new ` +
          'tasks, and mention it to the user at a natural break.'
  }

  const stop = `${settings.stopAt}%`
  switch (phaseOf(reading.percentUsed, mark, settings.stopAt)) {
    case 'before':
      return `${lead} Heads-up: the stopping point is ${stop} of this window. When usage reaches it: ` +
        `${settings.instruction} Plan the next steps so that you can stop there.`
    case 'at':
      return `${lead} That has reached the ${stop} stopping point. ${settings.instruction}`
    case 'past':
      return `${lead} That is past the ${stop} stopping point. Do this now, before the limit is ` +
        `reached: ${settings.instruction}`
  }
}

/** The short notice for the person, shown when the main session is told. */
export function personToast(note: Note): string {
  const { reading, mark, settings, now } = note
  const at = epoch(reading.resetsAt) === undefined
    ? ''
    : `, resets ${clockTime(reading.resetsAt as string, now)}`
  const figure = `${percent(reading)} of the ${label(reading.kind)} limit used${at}.`
  if (reading.kind === 'seven_day') return `${figure} Claude was told.`
  const phase = phaseOf(reading.percentUsed, mark, settings.stopAt)

  return phase === 'before'
    ? `${figure} Claude was told to plan for a stop at ${settings.stopAt}%.`
    : `${figure} Claude was told to head for a stopping point.`
}

/** The status line entry: "5h 72% · 7d 7%", or undefined without figures. */
export function statusText(limits: readonly SessionRateLimit[]): string | undefined {
  const parts = ['five_hour', 'seven_day', 'spend_limit']
    .map(kind => findWindow(limits, kind))
    .filter((reading): reading is SessionRateLimit => reading !== undefined)
    .map(reading => `${SHORT[reading.kind]} ${percent(reading)}`)

  return parts.length ? parts.join(' · ') : undefined
}

function list(marks: readonly number[]): string {
  return marks.length ? marks.join(', ') : 'none'
}

/** The one line `/usage-meter` prints. */
export function summaryLine(usage: SessionUsage, settings: Settings, now: number): string {
  const parts: string[] = []
  const windows = ['five_hour', 'seven_day', 'spend_limit']
    .map(kind => findWindow(usage.rateLimits, kind))
    .filter((reading): reading is SessionRateLimit => reading !== undefined)

  if (windows.length === 0) {
    parts.push(
      'No usage figures yet. Claude Code reports them for a claude.ai subscription, after ' +
        "the session's first reply; with an API key there are none, and the meter stays quiet.",
    )
  }
  for (const reading of windows) {
    const reset = resetText(reading, now)
    parts.push(`${SHORT[reading.kind]} ${percent(reading)}${reset ? ` (${reset})` : ''}`)
  }

  const tokens = usage.context.tokens
  if (tokens) parts.push(`context ${Math.round(tokens / 1000)}k of ${Math.round(usage.context.window / 1000)}k`)

  parts.push(
    settings.enabled
      ? `warnings on: ${list(settings.marks)} (subagents ${list(settings.agentMarks)}` +
          `${settings.weeklyMarks.length ? `, 7-day ${list(settings.weeklyMarks)}` : ''}), ` +
          `stop at ${settings.stopAt}%`
      : 'warnings off (/usage-meter on)',
  )

  return parts.join(' | ')
}
