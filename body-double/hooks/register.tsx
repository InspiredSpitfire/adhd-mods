import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Done, Task, Watched } from '../types'

const PANE = 'body-double'
const TITLE = 'Body double'
const TONE = '#ff0073'
const REFRESH_MS = 60_000
const FOCUS_MIN = 25
/** Under the home folder, unless `/double tasks <path>` says otherwise. */
const DEFAULT_TASKS = 'notes/tasks/tasks.md'
const PATH_KEY = 'tasksPath'
const OPEN_KEY = 'isOpen'
const doneKey = (day: string): string => `done:${day}`

const HELP = [
  '/double            open or close the pane',
  '/double tasks <path>   read the task from another file',
  '/double refresh    re-read the task file now',
  '/done <what>       add something you finished',
  '/done              list today',
  '/done undo         remove the last one',
].join('\n')

const EMPTY_LINES = [
  "Nothing yet. The first one counts double. (It doesn't. Do it anyway.)",
  'Nothing yet. The list is hungry.',
  'Nothing yet. Even a 10-second block counts here, I checked.',
] as const

// Change a tag when its fields change: an earlier version's value is declined.
const task = atom({ plugin: 'body-double', key: 'task' } as const, null, {
  shape: 'task-1',
})
const taskNote = atom({ plugin: 'body-double', key: 'taskNote' } as const, '')
const done = atom({ plugin: 'body-double', key: 'done' } as const, [], {
  shape: 'done-1',
})
const day = atom({ plugin: 'body-double', key: 'day' } as const, '')
const timer = atom({ plugin: 'body-double', key: 'timer' } as const, null, {
  shape: 'watched-1',
})
const now = atom({ plugin: 'body-double', key: 'now' } as const, 0)

// The focus-timer mod's own values, hooked (never written) here.
const THEIR_TIMER = { plugin: 'focus-timer', key: 'timer' } as const
const THEIR_NOW = { plugin: 'focus-timer', key: 'now' } as const

// ---- small helpers ---------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day, `YYYY-MM-DD`. */
const dayOf = (ms: number): string => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `9:05 am`, local time. */
const clockOf = (ms: number): string => {
  const d = new Date(ms)
  const h = d.getHours()

  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())} ${h < 12 ? 'am' : 'pm'}`
}

const countdown = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
}

const brief = (minutes: number): string => {
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} s`
  }
  const whole = Math.floor(minutes)
  const seconds = Math.round((minutes - whole) * 60)

  return seconds === 0 ? `${whole} min` : `${whole} min ${seconds} s`
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** Whether a `state.set` the hook passed on landed: its answer, in or out of a `{ value }` envelope. */
const didSet = (out: unknown): boolean => {
  const inner = isRecord(out) && 'value' in out ? out.value : out

  return isRecord(inner) && inner.isSet === true
}

/** A shaped atom keeps its value in a `{ shape, value }` envelope. */
const unwrap = (v: unknown): unknown =>
  isRecord(v) && typeof v.shape === 'string' && 'value' in v ? v.value : v

/** The focus timer's value, if it is one this mod understands. */
const asWatched = (raw: unknown): Watched | null => {
  const v = unwrap(raw)
  if (!isRecord(v)) {
    return null
  }
  const { phase, status, endsAt, leftMs, minutes, label } = v
  const isPhase = phase === 'focus' || phase === 'break'
  const isStatus = status === 'running' || status === 'paused' || status === 'done'
  if (
    !isPhase ||
    !isStatus ||
    typeof endsAt !== 'number' ||
    typeof leftMs !== 'number' ||
    typeof minutes !== 'number'
  ) {
    return null
  }

  return {
    phase,
    status,
    endsAt,
    leftMs,
    minutes,
    label: typeof label === 'string' ? label : '',
  }
}

/** The stored list, keeping only entries that are whole. */
const asDoneList = (v: unknown): Done[] => {
  if (!Array.isArray(v)) {
    return []
  }
  const list: Done[] = []
  for (const one of v) {
    if (
      isRecord(one) &&
      typeof one.at === 'number' &&
      typeof one.label === 'string' &&
      typeof one.minutes === 'number' &&
      (one.source === 'timer' || one.source === 'manual')
    ) {
      list.push({
        at: one.at,
        label: one.label,
        minutes: one.minutes,
        source: one.source,
      })
    }
  }

  return list
}

const HEADING = /^# (.+?)\s*$/
const TASK = /^## (?:(T-\d+)\s*[·•:-]\s*)?(.+?)\s*$/
const STEP = /^- next step:\s*(.*?)\s*$/
const DUE = /^- deadline:\s*(.*?)\s*$/
const BUCKET_ORDER = ['NOW', 'TODAY', 'THIS WEEK']

/** The task to show: the first under NOW, else TODAY, else the first at all. */
export const parseTasks = (text: string): Task | null => {
  const tasks: Task[] = []
  let bucket = ''
  let open: Task | null = null
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      bucket = heading[1] ?? ''
      open = null
      continue
    }
    const head = TASK.exec(line)
    if (head) {
      open = { id: head[1] ?? '', title: head[2] ?? '', step: '', due: '', bucket }
      tasks.push(open)
      continue
    }
    if (!open) {
      continue
    }
    const step = STEP.exec(line)
    if (step) {
      open.step = step[1] === '—' ? '' : (step[1] ?? '')
    }
    const due = DUE.exec(line)
    if (due) {
      open.due = due[1] === '—' || due[1] === 'none stated' ? '' : (due[1] ?? '')
    }
  }
  for (const name of BUCKET_ORDER) {
    const first = tasks.find(one => one.bucket.toUpperCase() === name)
    if (first) {
      return first
    }
  }

  return tasks[0] ?? null
}

// ---- actions ---------------------------------------------------------------

const tasksPath = async ($: EngineInterface): Promise<string> => {
  const stored = await $.store.get(PATH_KEY)
  if (typeof stored === 'string' && stored !== '') {
    return stored
  }
  const home = (await $.env.get('HOME')) ?? ''

  return home === '' ? DEFAULT_TASKS : `${home}/${DEFAULT_TASKS}`
}

const loadTask = async ($: EngineInterface): Promise<void> => {
  const path = await tasksPath($)
  let text: string
  try {
    const got = await $.fs.read(path)
    text = typeof got === 'string' ? got : ''
  } catch {
    await update($, task, () => null)
    await update($, taskNote, () => `No task file at ${path}. /double tasks <path> points me at one.`)

    return
  }
  const found = parseTasks(text)
  await update($, task, () => found)
  await update($, taskNote, () => (found ? '' : `Nothing under a ## heading in ${path}.`))
}

/**
 * The store is the list's home, shared by every open session; this session's
 * atom is a view of it. Reads the day's list from the store, rolling the day
 * over when it changed, and answers the day with the list as the store has it.
 */
const loadDay = async ($: EngineInterface): Promise<{ today: string; list: Done[] }> => {
  const today = dayOf(await $.clock.now())
  const list = asDoneList(await $.store.get(doneKey(today)))
  if ((await read($, day)) !== today) {
    await update($, day, () => today)
  }
  await update($, done, () => list)

  return { today, list }
}

const same = (a: Done, b: Done): boolean =>
  a.at === b.at && a.label === b.label && a.source === b.source

/** Adds to the day's list as the store holds it now, so another session's entries stay. */
const record = async ($: EngineInterface, one: Done): Promise<void> => {
  const { today, list } = await loadDay($)
  if (list.some(kept => same(kept, one))) {
    return
  }
  const next = [...list, one].slice(-200)
  await $.store.set(doneKey(today), next)
  await update($, done, () => next)
}

const undo = async ($: EngineInterface): Promise<Done | null> => {
  const { today, list } = await loadDay($)
  const last = list[list.length - 1] ?? null
  if (!last) {
    return null
  }
  const rest = list.slice(0, -1)
  await $.store.set(doneKey(today), rest)
  await update($, done, () => rest)

  return last
}

const openPane = async ($: EngineInterface): Promise<void> => {
  await $.ui.open({ id: PANE, title: TITLE })
  await $.store.set(OPEN_KEY, true)
}

const closePane = async ($: EngineInterface): Promise<void> => {
  await $.ui.close({ id: PANE })
  await $.store.set(OPEN_KEY, false)
}

/** Starts a focus block on the shown task, through the focus-timer mod. */
const focusOn = async ($: EngineInterface, one: Task): Promise<void> => {
  try {
    await $.command.run({ command: 'timer', args: `${FOCUS_MIN} ${one.title}` })
  } catch {
    $.ui.toast('That needs the focus-timer mod loaded.')
  }
}

const markDone = async ($: EngineInterface, one: Task): Promise<void> => {
  const at = await $.clock.now()
  await record($, { at, label: one.title, minutes: 0, source: 'manual' })
  $.ui.toast(`Logged: ${one.title}`)
}

const totalOf = (list: readonly Done[]): number =>
  list.reduce((sum, one) => sum + one.minutes, 0)

const summary = (list: readonly Done[]): string => {
  const blocks = list.filter(one => one.source === 'timer').length
  const parts = [`${list.length} ${list.length === 1 ? 'thing' : 'things'}`]
  if (blocks > 0) {
    parts.push(`${blocks} ${blocks === 1 ? 'block' : 'blocks'}`)
  }
  const total = totalOf(list)
  if (total > 0) {
    parts.push(brief(total))
  }

  return parts.join(' · ')
}

const runDouble = async ($: EngineInterface, args: string): Promise<string> => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const first = (words[0] ?? '').toLowerCase()
  if (first === 'help' || first === '?') {
    return HELP
  }
  if (first === 'tasks' || first === 'file') {
    const path = words.slice(1).join(' ')
    if (path === '') {
      return `Task file: ${await tasksPath($)}`
    }
    const home = (await $.env.get('HOME')) ?? ''
    const full = path.startsWith('~/') && home !== '' ? `${home}${path.slice(1)}` : path
    await $.store.set(PATH_KEY, full)
    await loadTask($)
    const note = await read($, taskNote)

    return note === '' ? `Reading tasks from ${full}.` : note
  }
  if (first === 'refresh' || first === 'reload') {
    await loadTask($)
    const note = await read($, taskNote)

    return note === '' ? 'Task re-read.' : note
  }
  if (first === 'off' || first === 'close' || first === 'hide') {
    await closePane($)

    return 'Body double closed. /double brings it back.'
  }
  if (first === 'on' || first === 'open' || first === 'show' || first === '') {
    const wasOpen = (await $.store.get(OPEN_KEY)) === true
    if (first === '' && wasOpen) {
      await closePane($)

      return 'Body double closed. /double brings it back.'
    }
    await loadDay($)
    await loadTask($)
    await openPane($)

    return 'Body double is up.'
  }

  return `Not sure what "${args.trim()}" means.\n${HELP}`
}

const runDone = async ($: EngineInterface, args: string): Promise<string> => {
  const text = args.trim()
  const lower = text.toLowerCase()
  if (lower === 'help' || lower === '?') {
    return HELP
  }
  if (lower === 'undo') {
    const last = await undo($)

    return last ? `Removed: ${last.label}` : 'Nothing to remove.'
  }
  if (text === '') {
    await loadDay($)
    const list = await read($, done)
    if (list.length === 0) {
      return 'Nothing logged today yet. /done <what> adds one.'
    }
    const lines = list.map(
      one => `${clockOf(one.at)}  ${one.label}${one.minutes > 0 ? ` (${brief(one.minutes)})` : ''}`,
    )

    return [`Today: ${summary(list)}`, ...lines].join('\n')
  }
  const at = await $.clock.now()
  await record($, { at, label: text, minutes: 0, source: 'manual' })
  const list = await read($, done)

  return `Logged: ${text}. That's ${summary(list)} today.`
}

/** The focus timer ran out: its block lands on the list. */
const onTheirTimer = async (
  $: EngineInterface,
  value: unknown,
  previous: unknown,
): Promise<void> => {
  const next = asWatched(value)
  const before = asWatched(previous)
  await update($, timer, () => next)
  const didFinish =
    next !== null &&
    next.phase === 'focus' &&
    next.status === 'done' &&
    before?.status === 'running' &&
    before.endsAt === next.endsAt
  if (!didFinish) {
    return
  }
  await record($, {
    at: next.endsAt,
    label: next.label === '' ? 'Focus block' : next.label,
    minutes: next.minutes,
    source: 'timer',
  })
}

const refresh = async ($: EngineInterface): Promise<void> => {
  await loadDay($)
  await loadTask($)
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'double',
      description: 'Open or close the body-double pane: your task, the timer, what you finished today',
      argumentHint: '[tasks <path> | refresh | off]',
    })
    await $.command.register({
      name: 'done',
      description: 'Log something you finished today, or list the day',
      argumentHint: '[what you finished | undo]',
    })
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    // Opens unasked only where a pane is a sidebar; a terminal gets it on /double.
    if (e.surface !== 'terminal' && (await $.store.get(OPEN_KEY)) !== false) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('command.run', { command: 'double' }, async ($, e) => ({
    text: await runDouble($, e.args),
  }))

  on('command.run', { command: 'done' }, async ($, e) => ({
    text: await runDone($, e.args),
  }))

  // The focus timer's writes pass through here; this mod only watches them.
  on('state.set', THEIR_TIMER, async ($, e, next) => {
    const out = await next(e)
    if (didSet(out)) {
      await onTheirTimer($, e.value, e.previous)
    }

    return out
  }).catch(($, e, next) => next(e))

  on('state.set', THEIR_NOW, async ($, e, next) => {
    const out = await next(e)
    if (didSet(out) && typeof e.value === 'number') {
      await update($, now, () => e.value as number)
    }

    return out
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await $.store.set(OPEN_KEY, false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const one = await read($, task)
    const note = await read($, taskNote)
    const list = await read($, done)
    const watched = await read($, timer)
    const at = await read($, now)
    const today = await read($, day)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 12)
    const recent = list.slice(-room).reverse()
    const emptyLine = EMPTY_LINES[Number(today.slice(-2)) % EMPTY_LINES.length] ?? EMPTY_LINES[0]

    let timerLine = 'No timer. Focus 25 above, or /timer.'
    let timerTone: string | undefined
    if (watched && watched.status === 'running') {
      const left = watched.endsAt - at
      timerLine = `${watched.phase === 'focus' ? 'FOCUS' : 'BREAK'} ${countdown(left)}${watched.label ? `  ${watched.label}` : ''}`
      timerTone = watched.phase === 'focus' ? TONE : undefined
    } else if (watched && watched.status === 'paused') {
      timerLine = `${watched.phase === 'focus' ? 'FOCUS' : 'BREAK'} paused ${countdown(watched.leftMs)}${watched.label ? `  ${watched.label}` : ''}`
    } else if (watched && watched.status === 'done') {
      timerLine = watched.phase === 'focus' ? 'Block finished. Break, or go again.' : 'Break is over.'
    }

    return (
      <Box flexDirection="column">
        <Text bold color={TONE}>
          {one ? `${one.bucket || 'NOW'}${one.id ? `  ${one.id}` : ''}` : 'NOW'}
        </Text>
        {one ? <Text bold>{one.title}</Text> : <Text dimColor>{note || 'No task yet.'}</Text>}
        {one && one.step !== '' && <Text>→ {one.step}</Text>}
        {one && one.due !== '' && <Text dimColor>due {one.due}</Text>}
        {one && (
          <Box>
            <Button
              key="focus"
              variant="primary"
              label={`Focus ${FOCUS_MIN}`}
              onPress={() => focusOn($, one)}
            />
            <Text> </Text>
            <Button key="mark" label="Mark done" onPress={() => markDone($, one)} />
          </Box>
        )}
        <Text> </Text>
        <Text color={timerTone} bold={timerTone !== undefined}>
          {timerLine}
        </Text>
        <Text> </Text>
        <Text bold color={TONE}>
          {`DONE TODAY${list.length > 0 ? `  ${summary(list)}` : ''}`}
        </Text>
        {list.length === 0 && <Text dimColor>{emptyLine}</Text>}
        {recent.map(entry => (
          <Text>
            ✓ {clockOf(entry.at)}  {entry.label}
            {entry.minutes > 0 ? `  ${brief(entry.minutes)}` : ''}
          </Text>
        ))}
        {list.length > recent.length && (
          <Text dimColor>and {list.length - recent.length} more. /done lists them all.</Text>
        )}
        <Text> </Text>
        <Text dimColor>/done {'<what>'} · /double · /double tasks {'<path>'}</Text>
      </Box>
    )
  })
}
