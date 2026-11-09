import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'focus-timer',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const MINUTE = 60_000
// The lines a block ends on, in the order the rounds take them.
const F0 = 'Time. You actually did the thing. Who even are you?'
const F1 = 'Block done. Your brain showed up and everything.'
const B0 = "Break's over. The thing is still there. Rude, I know."
const B1 = "Okay, back in. You've got the brain, I've got the clock."
// A Text takes no `key`: the countdown is found by its shape.
const LEFT = { type: 'Text', text: /^\d+:\d\d$/ } as const

// Stands for the engine beneath the mod, and records what the mod raised.
function engine(
  on: Parameters<TestBody>[1],
  stored: Record<string, unknown> = {},
) {
  const heard: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, stored)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'timer' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__focus-timer__timer' } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('audio.speak', (_, e) => {
    heard.push(e.text)

    return { value: { via: 'system' } }
  })
  // Stands for the engine's empty band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return { clock, heard, toasts }
}

test('a block counts down and ends with a toast and a voice', async ($, on) => {
  const { clock, heard, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run({ command: 'timer', args: '2 write the essay' })
  expect(ran.text).toBe('Focus: write the essay: 2 minutes. Go.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find(LEFT))?.text).toBe('2:00')
    expect(await ui.find({ type: 'Text', text: /write the essay/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(30_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find(LEFT))?.text).toBe('1:30')
  expect(toasts).toEqual([])

  await clock.advance(91_000)
  expect(toasts).toEqual([`${F0} (write the essay)`])
  expect(heard).toEqual([F0])
  expect(await ui.find({ type: 'Text', text: F0 })).toBeDefined()
  expect(
    (await ui.find({ type: 'Text', text: /round/ }))?.text,
  ).toBe('2 min: write the essay, round 1')

  // The break hands the same block back when it ends.
  await ui.press({ key: 'break' })
  expect((await ui.find(LEFT))?.text).toBe('5:00')
  await clock.advance(5 * MINUTE + 1000)
  expect(toasts.at(-1)).toBe(B1)
  expect(await ui.find({ type: 'Text', text: B1 })).toBeDefined()
  await ui.press({ key: 'focus' })
  expect((await ui.find(LEFT))?.text).toBe('2:00')
  expect(await ui.find({ type: 'Text', text: /write the essay/ })).toBeDefined()
  await ui.unmount()
})

test('pause holds the time, resume and +5 move it', async ($, on) => {
  const { clock, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'timer', args: '' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(LEFT))?.text).toBe('25:00')

  await clock.advance(5 * MINUTE)
  await ui.press({ key: 'pause' })
  await clock.advance(60 * MINUTE)
  expect((await ui.find(LEFT))?.text).toBe('20:00')
  expect(await ui.find({ type: 'Text', text: /FOCUS paused/ })).toBeDefined()
  expect(toasts).toEqual([])

  await ui.press({ key: 'resume' })
  await clock.advance(MINUTE)
  expect((await ui.find(LEFT))?.text).toBe('19:00')

  await ui.press({ key: 'plus5' })
  expect((await ui.find(LEFT))?.text).toBe('24:00')
  expect((await $.command.run({ command: 'timer', args: 'status' })).text).toBe(
    'Focus: 24:00 left of 30 min.',
  )

  await ui.press({ key: 'stop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await clock.advance(60 * MINUTE)
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('mute keeps the toast, drops the voice, and is remembered', async ($, on) => {
  const { clock, heard, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'timer', args: 'mute' })
  await $.command.run({ command: 'timer', args: '1' })
  await clock.advance(MINUTE + 1000)

  expect(toasts).toEqual([F0])
  expect(heard).toEqual([])
})

test('a mute stored by an earlier session still holds', async ($, on) => {
  const { clock, heard, toasts } = engine(on, { isMuted: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'timer', args: 'break 1' })
  await clock.advance(MINUTE + 1000)

  expect(toasts).toEqual([B0])
  expect(heard).toEqual([])
})

test('words it cannot read start nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect((await $.command.run({ command: 'timer', args: '999' })).text).toMatch(
    /1 to 240 minutes/,
  )
  expect((await $.command.run({ command: 'timer', args: 'pause' })).text).toBe(
    'Nothing running to pause.',
  )
  expect((await $.command.run({ command: 'timer', args: '+5' })).text).toBe(
    'Nothing running to add to.',
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

test('a timer an earlier version stored is declined', async ($, on) => {
  engine(on)
  // What the code before an edit wrote stays through the reload.
  on('state.get', () => ({
    value: { value: { phase: 'focus', endsAt: 5 }, version: 1 },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

// Runs `act` once, in the middle of the next tick: after the tick has read
// the timer and before it compares the time (the tick writes `now` between).
function duringNextTick(
  on: Parameters<TestBody>[1],
): (act: () => Promise<unknown>) => void {
  let pending: (() => Promise<unknown>) | null = null
  on('state.set', async (_, e, next) => {
    if (e.key === 'now' && pending !== null) {
      const act = pending
      pending = null
      await act()
    }

    return next(e)
  })

  return act => {
    pending = act
  }
}

test('a +5 that lands in the last tick keeps the clock going', async ($, on) => {
  const { clock, toasts } = engine(on)
  const during = duringNextTick(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'timer', args: '1' })
  await clock.advance(59_000)

  during(() => $.command.run({ command: 'timer', args: '+5' }))
  await clock.advance(1000)
  expect(toasts).toEqual([])

  await clock.advance(2 * MINUTE)
  expect((await $.command.run({ command: 'timer', args: 'status' })).text).toBe(
    'Focus: 3:00 left of 6 min.',
  )
  await clock.advance(3 * MINUTE + 1000)
  expect(toasts).toEqual([F0])
})

test('a new block started in the last tick runs to its own end', async ($, on) => {
  const { clock, toasts } = engine(on)
  const during = duringNextTick(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'timer', args: '1' })
  await clock.advance(59_000)

  during(() => $.command.run({ command: 'timer', args: '2 next thing' }))
  await clock.advance(1000)
  expect(toasts).toEqual([])

  await clock.advance(2 * MINUTE + 1000)
  expect(toasts).toEqual([`${F0} (next thing)`])
})

test('a stop in the last tick ends it quietly', async ($, on) => {
  const { clock, heard, toasts } = engine(on)
  const during = duringNextTick(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'timer', args: '1' })
  await clock.advance(59_000)

  during(() => $.command.run({ command: 'timer', args: 'stop' }))
  await clock.advance(10_000)
  expect(toasts).toEqual([])
  expect(heard).toEqual([])
})

test('a typo never wipes a block, and odd words are read kindly', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const say = async (args: string) =>
    (await $.command.run({ command: 'timer', args })).text

  // A label may open with a digit.
  expect(await say('3d printing notes')).toBe(
    'Focus: 3d printing notes: 25 minutes. Go.',
  )
  await clock.advance(5 * MINUTE)
  expect(await say('paws')).toBe(
    'Focus: 3d printing notes: 20:00 left of 25 min. To swap it: /timer 25 paws',
  )
  expect(await say('status')).toBe(
    'Focus: 3d printing notes: 20:00 left of 25 min.',
  )

  // +N stays inside the longest block.
  expect(await say('+240')).toBe('A block tops out at 240 minutes.')
  expect(await say('+215')).toMatch(/^Added 215 min\. /)
  expect(await say('+1')).toBe('A block tops out at 240 minutes.')

  // The word after `break` is its length; more words are let go.
  expect(await say('break 10 stretch')).toBe('Break: 10 minutes.')
  expect(await say('break soon')).toMatch(/1 to 240 minutes/)
  expect(await say('help')).toMatch(/status/)
})

test('a block still running after a reload is picked back up', async ($, on) => {
  const { clock, toasts } = engine(on)
  // What the code before the reload left in `$.state`: a block with a minute
  // to go. The module's own ticker is gone, as after a reload.
  const endsAt = clock.now() + MINUTE
  let isWritten = false
  on('state.set', (_, e, next) => {
    isWritten ||= e.key === 'timer'

    return next(e)
  })
  on('state.get', (_, e, next) =>
    e.key === 'timer' && !isWritten
      ? {
          value: {
            value: {
              shape: 'timer-1',
              value: {
                phase: 'focus',
                status: 'running',
                minutes: 25,
                focusMinutes: 25,
                endsAt,
                leftMs: 25 * MINUTE,
                label: 'the essay',
              },
            },
            version: 0,
          },
        }
      : next(e),
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(30_000)
  expect(toasts).toEqual([])
  await clock.advance(31_000)
  expect(toasts).toEqual([`${F0} (the essay)`])
})

test('Claude runs the timer from plain words through its tool', async ($, on) => {
  const { clock, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ask = async (command: string) =>
    (await $.tool.call({ tool: 'mcp__focus-timer__timer', command })).result

  expect(await ask('1 the essay')).toBe('Focus: the essay: 1 minute. Go.')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find(LEFT))?.text).toBe('1:00')
  await clock.advance(30_000)
  expect(await ask('status')).toBe('Focus: the essay: 0:30 left of 1 min.')
  expect(await ask('pause')).toMatch(/^Paused\. /)
  expect(await ask('resume')).toMatch(/^Back on\. /)

  await clock.advance(31_000)
  expect(toasts).toEqual([`${F0} (the essay)`])
  expect(await ask('stop')).toBe('Timer stopped.')
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

test('seconds work: a 10 second block, a 30 second break, +30s', async ($, on) => {
  const { clock, heard, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const say = async (args: string) =>
    (await $.command.run({ command: 'timer', args })).text

  // Every length in seconds starts on the second it names.
  for (const seconds of [7, 20, 35, 50, 55, 70, 100, 110]) {
    await say(`${seconds}s`)
    expect(await say('status')).toBe(
      `Focus: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left of ${
        seconds < 60 ? `${seconds} s` : `1 min ${seconds % 60} s`
      }.`,
    )
  }

  expect(await say('10s')).toBe('Focus: 10 seconds. Go.')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find(LEFT))?.text).toBe('0:10')
  await clock.advance(4000)
  expect(await say('status')).toBe('Focus: 0:06 left of 10 s.')
  await clock.advance(7000)
  expect(toasts).toEqual([F0])
  expect(heard).toEqual([F0])
  expect((await ui.find({ type: 'Text', text: /round/ }))?.text).toBe(
    '10 s, round 1',
  )
  // Going again hands back the same ten seconds.
  await ui.press({ key: 'again' })
  expect((await ui.find(LEFT))?.text).toBe('0:10')
  await ui.unmount()

  expect(await say('90sec the essay')).toBe(
    'Focus: the essay: 1 min 30 s. Go.',
  )
  expect(await say('+30s')).toBe(
    'Added 30 s. Focus: the essay: 2:00 left of 2 min.',
  )
  expect(await say('break 30s')).toBe('Break: 30 seconds.')
  expect(await say('45mins deep work')).toBe(
    'Focus: deep work: 45 minutes. Go.',
  )

  // Still refused: nothing, too long, and a word that is no length.
  expect(await say('0s')).toMatch(/1 to 240 minutes/)
  expect(await say('0')).toMatch(/1 to 240 minutes/)
  expect(await say('14401s')).toMatch(/1 to 240 minutes/)
  expect(await say('stop')).toBe('Timer stopped.')
  expect(await say('3d printing notes')).toBe(
    'Focus: 3d printing notes: 25 minutes. Go.',
  )
})

test('each round ends on a line of its own, said as it is shown', async ($, on) => {
  const { clock, heard, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (let round = 0; round < 10; round += 1) {
    await $.command.run({ command: 'timer', args: '5s' })
    await clock.advance(6000)
    // The band, the toast and the voice agree.
    const said = heard.at(-1) ?? ''
    expect(toasts.at(-1)).toBe(said)
    expect(await ui.find({ type: 'Text', text: said })).toBeDefined()
  }

  expect(heard.slice(0, 2)).toEqual([F0, F1])
  expect(new Set(heard.slice(0, 8)).size).toBe(8)
  // Past the last line it starts over rather than going quiet.
  expect(heard[8]).toBe(F0)
  expect(heard.every(line => line.length > 0)).toBe(true)
  await ui.unmount()
})

test('a block an earlier version ended still reads as done', async ($, on) => {
  engine(on)
  on('state.get', (_, e, next) =>
    e.key === 'timer'
      ? {
          value: {
            value: {
              shape: 'timer-1',
              value: {
                phase: 'focus',
                status: 'done',
                minutes: 25,
                focusMinutes: 25,
                endsAt: 0,
                leftMs: 0,
                label: '',
              },
            },
            version: 0,
          },
        }
      : next(e),
  )

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Focus block done.' })).toBeDefined()
  await ui.unmount()
})

test('a unit typed as its own word is still the unit', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const say = async (args: string) =>
    (await $.command.run({ command: 'timer', args })).text

  expect(await say('10 seconds')).toBe('Focus: 10 seconds. Go.')
  expect(await say('status')).toBe('Focus: 0:10 left of 10 s.')
  expect(await say('10 second timer')).toBe('Focus: 10 seconds. Go.')
  expect(await say('90 Seconds the essay')).toBe(
    'Focus: the essay: 1 min 30 s. Go.',
  )
  expect(await say('+30 seconds')).toBe(
    'Added 30 s. Focus: the essay: 2:00 left of 2 min.',
  )
  expect(await say('5 min essay')).toBe('Focus: essay: 5 minutes. Go.')
  expect(await say('25 minute timer for the essay')).toBe(
    'Focus: the essay: 25 minutes. Go.',
  )
  expect(await say('break 30 seconds')).toBe('Break: 30 seconds.')
  expect(await say('break 10 min stretch')).toBe('Break: 10 minutes.')
  expect(await say('/timer 2')).toBe('Focus: 2 minutes. Go.')

  // A unit word anywhere else is part of the name, and a huge number is refused.
  expect(await say('45 essay 2 min read')).toBe(
    'Focus: essay 2 min read: 45 minutes. Go.',
  )
  expect(await say('100000')).toMatch(/1 to 240 minutes/)
  expect(await say('100000 seconds')).toMatch(/1 to 240 minutes/)
})
