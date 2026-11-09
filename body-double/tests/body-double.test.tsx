import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { Register } from 'claude-code'

const PANE = {
  plugin: 'body-double',
  component: 'Pane',
  requestId: 'body-double',
  props: {
    title: 'Body double',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MINUTE = 60_000
// 2026-11-09 09:00 local, give or take the zone: the day key is read back,
// never assumed.
const START = Date.UTC(2026, 10, 9, 15, 0, 0)
const HOME = '/Users/someone'
const TASKS = `${HOME}/notes/tasks/tasks.md`

const TASKS_MD = `# Running list

Owned by the day-captain skill.

# NOW

## T-001 · Dog out
- bucket: NOW
- deadline: now
- next step: Grab the leash and take the dog out (2 min).
- notes: —

# TODAY

## T-005 · Play tonight
- next step: Tell Claude the curtain time.
`

// Stands for the focus-timer mod: it alone may write its values, so the test
// asks it to through two commands of its own.
const theirRegister: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'their-timer', description: 'test' })
    await $.command.register({ name: 'their-now', description: 'test' })
    await $.command.register({ name: 'their-timer-miss', description: 'test' })

    return next(e)
  })
  on('command.run', { command: 'their-timer' }, async ($, e) => {
    // As the focus-timer mod's shaped atom writes it: in its envelope.
    const value = { shape: 'timer-1', value: JSON.parse(e.args) as unknown }
    await $.state.set({ plugin: 'focus-timer', key: 'timer' } as const, value as never)

    return { text: 'set' }
  })
  // A write whose ifVersion misses: focus-timer's update() retries after one.
  on('command.run', { command: 'their-timer-miss' }, async ($, e) => {
    const value = { shape: 'timer-1', value: JSON.parse(e.args) as unknown }
    const out = await $.state.set({ plugin: 'focus-timer', key: 'timer' } as const, value as never, {
      ifVersion: 999,
    })

    return { text: `isSet ${out.isSet}` }
  })
  on('command.run', { command: 'their-now' }, async ($, e) => {
    await $.state.set({ plugin: 'focus-timer', key: 'now' } as const, Number(e.args) as never)

    return { text: 'set' }
  })
}
const THEIRS: readonly Plugin[] = [{ name: 'focus-timer', tier: 'append', register: theirRegister }]
const WITH_THEIRS = { plugins: THEIRS }

type Engine = Parameters<TestBody>[0]
const setTheirTimer = ($: Engine, value: unknown) =>
  $.command.run({ command: 'their-timer', args: JSON.stringify(value) })
const setTheirNow = ($: Engine, ms: number) =>
  $.command.run({ command: 'their-now', args: String(ms) })
const missTheirTimer = ($: Engine, value: unknown) =>
  $.command.run({ command: 'their-timer-miss', args: JSON.stringify(value) })

const dayKey = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Stands for the engine beneath the mod, and records what the mod asked of it.
function engine(
  on: Parameters<TestBody>[1],
  options: { stored?: Record<string, unknown>; files?: Record<string, string> } = {},
) {
  const files = options.files ?? { [TASKS]: TASKS_MD }
  const opened: string[] = []
  const closed: string[] = []
  const toasts: string[] = []
  const ran: string[] = []
  // The store, in memory, so a test reads back what the mod kept.
  const store = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const clock = mock.clock(on, { now: START })
  mock.env(on, { HOME })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) {
      return { deny: `ENOENT: ${e.path}` }
    }

    return { value: text }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  // The focus-timer mod's own command, as the Focus button runs it.
  on('command.run', { command: 'timer' }, (_, e) => {
    ran.push(`/${e.command} ${e.args}`)

    return { text: 'ok' }
  })

  return { clock, opened, closed, toasts, ran, store }
}

const running = (endsAt: number, label: string, minutes = 25) => ({
  phase: 'focus',
  status: 'running',
  minutes,
  focusMinutes: minutes,
  endsAt,
  leftMs: 0,
  label,
})

test('the pane shows the NOW task from the tasks file, on every surface', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['body-double'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /T-001/ }))?.text).toBe('NOW  T-001')
    expect(await ui.find({ type: 'Text', text: /^Dog out$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Grab the leash/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished focus block lands on the list and in the store', WITH_THEIRS, async ($, on) => {
  const { clock, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const endsAt = clock.now() + 25 * MINUTE
  await setTheirTimer($, running(endsAt, 'write the essay'))
  await setTheirNow($, clock.now())

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^FOCUS/ }))?.text).toBe(
    'FOCUS 25:00  write the essay',
  )

  await clock.advance(25 * MINUTE)
  await setTheirNow($, clock.now())
  await setTheirTimer($, { ...running(endsAt, 'write the essay'), status: 'done', line: 'Time.' })

  expect(await ui.find({ type: 'Text', text: /✓ .*write the essay  25 min/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^DONE TODAY/ }))?.text).toBe(
    'DONE TODAY  1 thing · 1 block · 25 min',
  )
  expect(await ui.find({ type: 'Text', text: /Block finished/ })).toBeDefined()

  expect(store.get(`done:${dayKey(clock.now())}`)).toHaveLength(1)
  await ui.unmount()
})

test('a break ending, a stop, or a nameless block are handled', WITH_THEIRS, async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // A break that ends is not a thing finished.
  const breakEnd = clock.now() + 5 * MINUTE
  await setTheirTimer($, { ...running(breakEnd, '', 5), phase: 'break' })
  await setTheirTimer($, { ...running(breakEnd, '', 5), phase: 'break', status: 'done' })
  // A stop clears the timer: nothing finished either.
  await setTheirTimer($, running(clock.now() + MINUTE, 'thing'))
  await setTheirTimer($, null)
  // A nameless block that runs out gets a name.
  const endsAt = clock.now() + MINUTE
  await setTheirTimer($, running(endsAt, '', 1))
  await setTheirTimer($, { ...running(endsAt, '', 1), status: 'done' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ .*Focus block  1 min/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^DONE TODAY/ }))?.text).toBe(
    'DONE TODAY  1 thing · 1 block · 1 min',
  )
  await ui.unmount()
})

test('/done adds, lists and undoes; the list survives a reload', async ($, on) => {
  const { clock, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let out = await $.command.run({ command: 'done', args: 'answered the vet' })
  expect(out.text).toBe("Logged: answered the vet. That's 1 thing today.")
  out = await $.command.run({ command: 'done', args: 'booked the dog' })
  expect(out.text).toBe("Logged: booked the dog. That's 2 things today.")
  out = await $.command.run({ command: 'done', args: '' })
  expect(out.text).toMatch(/^Today: 2 things\n.* answered the vet\n.* booked the dog$/)
  out = await $.command.run({ command: 'done', args: 'undo' })
  expect(out.text).toBe('Removed: booked the dog')

  // The reload: the module's variables are gone, the store is not.
  expect(store.get(`done:${dayKey(clock.now())}`)).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /✓ .*answered the vet$/ })).toBeDefined()
  await ui.unmount()
})

test('a stored list from another day, or a broken one, is left alone', async ($, on) => {
  const today = dayKey(START)
  engine(on, {
    stored: {
      [`done:${today}`]: [
        { at: START - MINUTE, label: 'kept', minutes: 10, source: 'timer' },
        { label: 'no time on this one' },
        'not even an object',
      ],
      'done:2020-01-01': [{ at: 0, label: 'ancient', minutes: 5, source: 'timer' }],
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /✓ .*kept  10 min/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ancient/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /no time/ })).toBeUndefined()
  await ui.unmount()
})

test('no task file: the pane says so and /double tasks points at one', async ($, on) => {
  const { store } = engine(on, {
    files: { '/elsewhere/list.md': '# TODAY\n\n## Ship it\n- next step: push\n' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No task file at .*tasks\.md/ })).toBeDefined()
  await ui.unmount()

  const out = await $.command.run({ command: 'double', args: 'tasks /elsewhere/list.md' })
  expect(out.text).toBe('Reading tasks from /elsewhere/list.md.')
  expect(store.get('tasksPath')).toBe('/elsewhere/list.md')

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Ship it$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ push/ })).toBeDefined()
  await ui.unmount()
})

test('the buttons start a block on the task and mark it done', async ($, on) => {
  const { ran, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'focus' })
  expect(ran).toEqual(['/timer 25 Dog out'])

  await ui.press({ key: 'mark' })
  expect(toasts).toEqual(['Logged: Dog out'])
  expect(await ui.find({ type: 'Text', text: /✓ .*Dog out$/ })).toBeDefined()
  await ui.unmount()
})

test('/double toggles the pane and remembers a close', async ($, on) => {
  const { opened, closed, store } = engine(on, { stored: { isOpen: false } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Closed last time: it stays closed on start.
  expect(opened).toEqual([])

  let out = await $.command.run({ command: 'double', args: '' })
  expect(out.text).toBe('Body double is up.')
  expect(opened).toEqual(['body-double'])

  out = await $.command.run({ command: 'double', args: '' })
  expect(out.text).toBe('Body double closed. /double brings it back.')
  expect(closed).toEqual(['body-double'])
  expect(store.get('isOpen')).toBe(false)
})

test('the day rolls over on the minute tick', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'done', args: 'yesterday thing' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /yesterday thing/ })).toBeDefined()

  // Past midnight, local: the list is a new day's.
  const before = dayKey(clock.now())
  while (dayKey(clock.now()) === before) {
    await clock.advance(60 * MINUTE)
  }
  await clock.advance(MINUTE)
  expect(await ui.find({ type: 'Text', text: /yesterday thing/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
  await ui.unmount()
})

test('a write that misses its version, a pause, a swap: recorded once or not at all', WITH_THEIRS, async ($, on) => {
  const { clock, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const key = `done:${dayKey(clock.now())}`

  // Paused and resumed, then a finish whose first write misses: one entry.
  const endsAt = clock.now() + 25 * MINUTE
  const block = running(endsAt, 'essay')
  await setTheirTimer($, block)
  await setTheirTimer($, { ...block, status: 'paused', leftMs: 10 * MINUTE })
  await setTheirTimer($, { ...block, status: 'running' })
  const missed = await missTheirTimer($, { ...block, status: 'done' })
  expect(missed.text).toBe('isSet false')
  expect(store.get(key)).toBeUndefined()
  await setTheirTimer($, { ...block, status: 'done' })
  expect(store.get(key)).toHaveLength(1)
  // The same done written again (a replay) does not land twice.
  await setTheirTimer($, { ...block, status: 'done' })
  expect(store.get(key)).toHaveLength(1)

  // A block swapped for another mid-run: the first never finished.
  const second = running(clock.now() + 50 * MINUTE, 'other thing', 50)
  await setTheirTimer($, running(clock.now() + 5 * MINUTE, 'abandoned', 5))
  await setTheirTimer($, second)
  await setTheirTimer($, { ...second, status: 'done' })
  const list = store.get(key) as { label: string }[]
  expect(list.map(one => one.label)).toEqual(['essay', 'other thing'])

  // A value under another shape tag, or junk, is no timer at all.
  await $.command.run({
    command: 'their-timer',
    args: JSON.stringify({ shape: 'timer-9', value: { phase: 'focus', status: 'running' } }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^No timer/ })).toBeDefined()
  await ui.unmount()
})

test('odd task files: empty, no NOW, placeholder lines', async ($, on) => {
  const files: Record<string, string> = { [TASKS]: '' }
  engine(on, { files })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Nothing under a ## heading/ })).toBeDefined()
  await ui.unmount()

  files[TASKS] = '# THIS WEEK\n\n## T-011 · Fix the bio links\n- deadline: —\n- next step: —\n\n# TODAY\n\n## Wash hair\n- deadline: none stated\n- next step: set an alarm\n'
  await $.command.run({ command: 'double', args: 'refresh' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^TODAY/ }))?.text).toBe('TODAY')
  expect(await ui.find({ type: 'Text', text: /^Wash hair$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ set an alarm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^due/ })).toBeUndefined()
  await ui.unmount()
})

test('yesterday stays in the store after the day rolls over', async ($, on) => {
  const { clock, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const before = dayKey(clock.now())
  await $.command.run({ command: 'done', args: 'late one' })

  while (dayKey(clock.now()) === before) {
    await clock.advance(60 * MINUTE)
  }
  await clock.advance(MINUTE)
  await $.command.run({ command: 'done', args: 'early one' })

  expect((store.get(`done:${before}`) as { label: string }[]).map(one => one.label)).toEqual(['late one'])
  expect((store.get(`done:${dayKey(clock.now())}`) as { label: string }[]).map(one => one.label)).toEqual([
    'early one',
  ])
})

test('another open session adds to the same day: nothing of theirs is lost', async ($, on) => {
  const { clock, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const key = `done:${dayKey(clock.now())}`
  await $.command.run({ command: 'done', args: 'mine' })

  // The other session writes the store behind this one's back.
  const theirs = { at: clock.now(), label: 'their block', minutes: 25, source: 'timer' }
  store.set(key, [...(store.get(key) as unknown[]), theirs])

  await $.command.run({ command: 'done', args: 'mine too' })
  expect((store.get(key) as { label: string }[]).map(one => one.label)).toEqual([
    'mine',
    'their block',
    'mine too',
  ])

  // The minute tick shows theirs here too.
  store.set(key, [...(store.get(key) as unknown[]), { ...theirs, label: 'their second' }])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /their second/ })).toBeUndefined()
  await clock.advance(MINUTE)
  expect(await ui.find({ type: 'Text', text: /their second/ })).toBeDefined()
  await ui.unmount()

  const out = await $.command.run({ command: 'done', args: 'undo' })
  expect(out.text).toBe('Removed: their second')
})

test('a terminal gets the pane on /double, not unasked', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual([])
  await $.command.run({ command: 'double', args: '' })
  expect(opened).toEqual(['body-double'])
})

test('/double tasks expands a leading ~', async ($, on) => {
  const { store } = engine(on, { files: { [`${HOME}/lists/today.md`]: '# NOW\n\n## Call mom\n' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'double', args: 'tasks ~/lists/today.md' })
  expect(out.text).toBe(`Reading tasks from ${HOME}/lists/today.md.`)
  expect(store.get('tasksPath')).toBe(`${HOME}/lists/today.md`)
})
