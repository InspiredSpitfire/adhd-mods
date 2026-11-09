import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  Timer as Ticker,
} from 'claude-code'

import type { Phase, Timer } from '../types'

const FOCUS_MIN = 25
const BREAK_MIN = 5
const MAX_MIN = 240
const MINUTE = 60_000
const MUTE_KEY = 'isMuted'
const FOCUS_TONE = '#ff0073'
// What Claude calls when the person asks for the timer in plain words.
const TOOL = 'mcp__focus-timer__timer'

const HELP = [
  '/timer                      start 25 minutes (or show what is running)',
  '/timer 45 write the essay   45 minutes, named',
  '/timer 90s                  seconds work too: 10s, 90s',
  '/timer write the essay      25 minutes, named',
  '/timer break [10]           a break, 5 minutes unless you say',
  '/timer pause | resume | stop | status',
  '/timer +5                   add minutes to the one running',
  '/timer mute | unmute        the spoken "done" at the end',
].join('\n')

// What it says when a block ends: toast, voice and band alike. They take
// turns by round, so no line comes twice in a row.
const FOCUS_DONE = [
  'Time. You actually did the thing. Who even are you?',
  'Block done. Your brain showed up and everything.',
  "That's a wrap. Put the keyboard down and back away slowly.",
  "Ding. Focus achieved. Tell no one, they'll expect it again.",
  'Done. Look at you, finishing things like a person with a plan.',
  "Time's up. That was focus. On purpose. Wild.",
  "Block's over. Go drink some water, you gorgeous houseplant.",
  'And scene. Stand up before your spine files a complaint.',
] as const
const BREAK_DONE = [
  "Break's over. The thing is still there. Rude, I know.",
  "Okay, back in. You've got the brain, I've got the clock.",
  'Recess is done. Butts in seats.',
  "Break's up. You can do anything for one more round.",
  'Tick tock. Future you would like a word, and the word is go.',
] as const

const lineFor = (lines: readonly string[], round: number): string =>
  lines[round % lines.length] ?? ''

// Change the tag when a Timer's fields change: it declines what an earlier
// version stored, which outlives a reload.
const timer = atom({ plugin: 'focus-timer', key: 'timer' } as const, null, {
  shape: 'timer-1',
})
const now = atom({ plugin: 'focus-timer', key: 'now' } as const, 0)
const rounds = atom({ plugin: 'focus-timer', key: 'rounds' } as const, 0)
const isMuted = atom({ plugin: 'focus-timer', key: 'isMuted' } as const, false)

const countdown = (ms: number): string => {
  const seconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(seconds / 60)

  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

const bar = (fraction: number, cells = 10): string => {
  const filled = Math.min(cells, Math.max(0, Math.round(fraction * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const leftOf = (one: Timer, at: number): number =>
  one.status === 'running' ? Math.max(0, one.endsAt - at) : one.leftMs

// A length is kept in minutes and may be part of one: `10s` is a sixth.
const span = (minutes: number): string => {
  const seconds = Math.round(minutes * 60)

  if (seconds % 60 === 0) {
    return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`
  }

  return seconds < 60
    ? `${seconds} second${seconds === 1 ? '' : 's'}`
    : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

// Whole milliseconds, so a part of a minute never shows a second too many.
const lengthMs = (minutes: number): number => Math.round(minutes * MINUTE)

const brief = (minutes: number): string => {
  const seconds = Math.round(minutes * 60)
  const whole = Math.floor(seconds / 60)

  return seconds % 60 === 0
    ? `${whole} min`
    : whole === 0
      ? `${seconds} s`
      : `${whole} min ${seconds % 60} s`
}

const named = (one: Timer): string => (one.label === '' ? '' : `: ${one.label}`)

// The module's own: a reload starts these over, and `session.start` picks
// a running timer back up from `$.state`.
let ticker: Ticker | null = null
let isTicking = false

// The helpers sit at the top of the file: `$` is passed only to functions
// declared there.

const stopTicking = (): void => {
  ticker?.cancel()
  ticker = null
}

const finish = async ($: EngineInterface, ended: Timer): Promise<void> => {
  const isFocus = ended.phase === 'focus'
  const line = lineFor(isFocus ? FOCUS_DONE : BREAK_DONE, await read($, rounds))
  let didEnd = false
  await update($, timer, one => {
    didEnd = one?.status === 'running' && one.endsAt === ended.endsAt

    return one && didEnd ? { ...one, status: 'done', leftMs: 0, line } : one
  })

  if (!didEnd) {
    return
  }

  if (isFocus) {
    await update($, rounds, count => count + 1)
  }

  const shown = isFocus && ended.label !== '' ? `${line} (${ended.label})` : line
  $.ui.toast(shown, { timeoutMs: 10_000 })
  void $.ui.notify(shown, { title: 'Focus timer' }).catch(() => undefined)

  if (!(await read($, isMuted))) {
    void $.audio.speak(line).catch(() => undefined)
  }
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (isTicking) {
    return
  }

  isTicking = true

  try {
    const one = await read($, timer)

    if (one === null || one.status !== 'running') {
      stopTicking()

      return
    }

    const at = await $.clock.now()
    await update($, now, () => at)

    if (at >= one.endsAt) {
      await finish($, one)

      // A +5 or a new block that landed during this tick keeps the ticker:
      // it stops only once nothing is left running. The read and the cancel
      // are one step, so a start after them makes a ticker of its own.
      if ((await read($, timer))?.status !== 'running') {
        stopTicking()
      }
    }
  } catch (error) {
    $.ui.log(`focus-timer: tick failed: ${String(error)}`)
  } finally {
    isTicking = false
  }
}

const startTicking = ($: EngineInterface): void => {
  ticker ??= $.clock.every(1000, () => void tick($))
}

const start = async (
  $: EngineInterface,
  phase: Phase,
  minutes: number,
  label: string,
  focusMinutes = minutes,
): Promise<void> => {
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, timer, () => ({
    phase,
    status: 'running' as const,
    minutes,
    focusMinutes,
    endsAt: at + lengthMs(minutes),
    leftMs: lengthMs(minutes),
    label,
  }))
  startTicking($)
}

const startBreak = async (
  $: EngineInterface,
  minutes: number,
): Promise<void> => {
  const one = await read($, timer)

  await start(
    $,
    'break',
    minutes,
    one?.label ?? '',
    one?.focusMinutes ?? FOCUS_MIN,
  )
}

const pause = async ($: EngineInterface): Promise<boolean> => {
  const at = await $.clock.now()
  let didPause = false
  await update($, timer, one => {
    didPause = one?.status === 'running'

    return one && didPause
      ? { ...one, status: 'paused', leftMs: Math.max(0, one.endsAt - at) }
      : one
  })

  return didPause
}

const resume = async ($: EngineInterface): Promise<boolean> => {
  const at = await $.clock.now()
  let didResume = false
  await update($, now, () => at)
  await update($, timer, one => {
    didResume = one?.status === 'paused'

    return one && didResume
      ? { ...one, status: 'running', endsAt: at + one.leftMs }
      : one
  })

  if (didResume) {
    startTicking($)
  }

  return didResume
}

const extend = async (
  $: EngineInterface,
  minutes: number,
): Promise<'added' | 'nothing-live' | 'too-long'> => {
  let outcome: 'added' | 'nothing-live' | 'too-long' = 'nothing-live'
  await update($, timer, one => {
    const isLive = one?.status === 'running' || one?.status === 'paused'
    outcome = !one || !isLive
      ? 'nothing-live'
      : one.minutes + minutes > MAX_MIN
        ? 'too-long'
        : 'added'

    return one && outcome === 'added'
      ? {
          ...one,
          minutes: one.minutes + minutes,
          endsAt: one.endsAt + lengthMs(minutes),
          leftMs: one.leftMs + lengthMs(minutes),
        }
      : one
  })

  return outcome
}

const clear = async ($: EngineInterface): Promise<void> => {
  stopTicking()
  await update($, timer, () => null)
}

const setMuted = async ($: EngineInterface, muted: boolean): Promise<void> => {
  await update($, isMuted, () => muted)
  await $.store.set(MUTE_KEY, muted)
}

const describe = async ($: EngineInterface): Promise<string> => {
  const one = await read($, timer)

  if (one === null) {
    return 'No timer running.'
  }

  if (one.status === 'done') {
    return `${one.phase === 'focus' ? 'Focus block' : 'Break'} finished.`
  }

  const left = countdown(leftOf(one, await $.clock.now()))
  const state = one.status === 'paused' ? 'paused, ' : ''

  return `${one.phase === 'focus' ? 'Focus' : 'Break'}${named(one)}: ${state}${left} left of ${brief(one.minutes)}.`
}

// `45`, `45m`, `45mins` are minutes; `10s`, `90sec`, `30seconds` are seconds.
const LENGTH = /^(\d+)(s|secs?|seconds?|m|mins?|minutes?)?$/
const BARE = /^\+?\d+$/
const UNIT = /^(s|secs?|seconds?|m|mins?|minutes?)$/i

// The words of a command, with a unit typed as a word of its own joined to
// its number where a length goes: `10 seconds`, `+30 seconds`, `break 30
// seconds`. Without that the unit would be read as the block's name and the
// number as minutes.
const wordsOf = (args: string): string[] => {
  const words = args.trim().split(/\s+/).filter(Boolean)

  if (words[0]?.toLowerCase() === '/timer') {
    words.shift()
  }

  const at = words[0]?.toLowerCase() === 'break' ? 1 : 0
  const count = words[at] ?? ''
  const unit = words[at + 1] ?? ''

  if (BARE.test(count) && UNIT.test(unit)) {
    words.splice(at, 2, count + unit.toLowerCase())
  }

  return words
}

// "10 second timer", "25 minute timer for the essay": the word is not a name.
const labelOf = (rest: string): string =>
  rest.replace(/^timer\b\s*(for\s+)?/i, '')

const minutesFrom = (word: string): number | null => {
  const match = LENGTH.exec(word)

  if (!match) {
    return null
  }

  const isSeconds = (match[2] ?? 'm').startsWith('s')
  const minutes = isSeconds ? Number(match[1]) / 60 : Number(match[1])

  return minutes > 0 && (isSeconds || minutes >= 1) && minutes <= MAX_MIN
    ? minutes
    : null
}

const run = async ($: EngineInterface, args: string): Promise<string> => {
  const words = wordsOf(args)
  const first = (words[0] ?? '').toLowerCase()
  const rest = labelOf(words.slice(1).join(' '))
  const one = await read($, timer)
  const isLive = one?.status === 'running' || one?.status === 'paused'

  if (first === '') {
    if (isLive) {
      return describe($)
    }

    await start($, 'focus', FOCUS_MIN, '')

    return `Focus: ${span(FOCUS_MIN)}. Go.`
  }

  if (first === 'help' || first === '?') {
    return HELP
  }

  if (first === 'status') {
    return describe($)
  }

  if (first === 'pause') {
    return (await pause($)) ? `Paused. ${await describe($)}` : 'Nothing running to pause.'
  }

  if (first === 'resume') {
    return (await resume($)) ? `Back on. ${await describe($)}` : 'Nothing paused to resume.'
  }

  if (first === 'stop' || first === 'cancel' || first === 'off') {
    await clear($)

    return one === null ? 'No timer running.' : 'Timer stopped.'
  }

  if (first === 'mute' || first === 'unmute') {
    await setMuted($, first === 'mute')

    return first === 'mute'
      ? 'Muted: it ends with a toast, no voice.'
      : 'Unmuted: it says so out loud when it ends.'
  }

  if (first === 'break') {
    const length = (words[1] ?? '').toLowerCase()
    const minutes = length === '' ? BREAK_MIN : minutesFrom(length)

    if (minutes === null) {
      return `A break is 1 to ${MAX_MIN} minutes, or seconds like 30s: /timer break 10`
    }

    await startBreak($, minutes)

    return `Break: ${span(minutes)}.`
  }

  if (first.startsWith('+')) {
    const minutes = minutesFrom(first.slice(1))

    if (minutes === null) {
      return 'Add minutes or seconds: /timer +5, /timer +30s'
    }

    const outcome = await extend($, minutes)

    return outcome === 'added'
      ? `Added ${brief(minutes)}. ${await describe($)}`
      : outcome === 'too-long'
        ? `A block tops out at ${MAX_MIN} minutes.`
        : 'Nothing running to add to.'
  }

  if (LENGTH.test(first)) {
    const minutes = minutesFrom(first)

    if (minutes === null) {
      return `A block is 1 to ${MAX_MIN} minutes, or seconds like 30s: /timer 45 write the essay`
    }

    await start($, 'focus', minutes, rest)

    return `Focus${rest === '' ? '' : `: ${rest}`}: ${span(minutes)}. Go.`
  }

  // Anything else names the block, but a typo never wipes one in flight.
  if (isLive) {
    return `${await describe($)} To swap it: /timer ${FOCUS_MIN} ${words.join(' ')}`
  }

  const label = words.join(' ')
  await start($, 'focus', FOCUS_MIN, label)

  return `Focus: ${label}: ${span(FOCUS_MIN)}. Go.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timer',
      description:
        'Focus timer above the prompt: /timer 25 write the essay, break, pause, resume, +5, stop',
      argumentHint: '[minutes] [what for] | break | pause | resume | +5 | stop',
      immediate: true,
    })
    // The same words without the slash, for "start a 25 minute timer" said
    // to Claude: in the tool list from the start, so no search is needed.
    await $.tool.register({
      name: 'timer',
      description:
        "Runs the person's focus timer, shown as a band above their prompt. Call it when they ask in plain words to start, pause, resume, extend, stop or check a focus timer or a break. `command` is what would follow /timer. Returns the timer's one-line reply; pass it on briefly.",
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'One of: "" (start 25 minutes, or report what is running), "45 write the essay" (minutes, then an optional name for the block), "10s" or "90s the essay" (seconds), "break" or "break 10", "pause", "resume", "+5" (add minutes), "stop", "status", "mute", "unmute".',
          },
        },
        required: ['command'],
      },
      isDeferred: false,
    })

    const stored = await $.store.get(MUTE_KEY)

    if (typeof stored === 'boolean') {
      await update($, isMuted, () => stored)
    }

    // A reload cancelled the old ticker; a timer still running needs a new one.
    if ((await read($, timer))?.status === 'running') {
      startTicking($)
    }

    return next(e)
  })

  on('command.run', { command: 'timer' }, async ($, e) => ({
    text: await run($, e.args),
  }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { command } = e as { command?: unknown }

    return { result: await run($, typeof command === 'string' ? command : '') }
  }).catch(() => ({ deny: 'focus-timer: the timer could not run that.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const one = await read($, timer)

    if (e.props.hasSurvey || one === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    if (one.status === 'done') {
      const count = await read($, rounds)

      if (one.phase === 'focus') {
        return (
          <Box gap={1}>
            <Text color="success" weight="bold">
              {one.line ?? 'Focus block done.'}
            </Text>
            <Text dimColor>
              {brief(one.minutes)}{named(one)}, round {count}
            </Text>
            <Button
              key="break"
              variant="primary"
              label={`Break ${BREAK_MIN}`}
              onPress={() => startBreak($, BREAK_MIN)}
            />
            <Button
              key="again"
              label={`Go again ${brief(one.focusMinutes)}`}
              onPress={() => start($, 'focus', one.focusMinutes, one.label)}
            />
            <Button key="dismiss" label="Dismiss" onPress={() => clear($)} />
          </Box>
        )
      }

      return (
        <Box gap={1}>
          <Text color="success" weight="bold">
            {one.line ?? 'Break is over.'}
          </Text>
          <Button
            key="focus"
            variant="primary"
            label={`Focus ${brief(one.focusMinutes)}`}
            onPress={() => start($, 'focus', one.focusMinutes, one.label)}
          />
          <Button key="dismiss" label="Dismiss" onPress={() => clear($)} />
        </Box>
      )
    }

    const isPaused = one.status === 'paused'
    const left = leftOf(one, await read($, now))
    const tone = isPaused
      ? 'warning'
      : one.phase === 'focus'
        ? FOCUS_TONE
        : 'success'
    const title = `${one.phase === 'focus' ? 'FOCUS' : 'BREAK'}${isPaused ? ' paused' : ''}`

    return (
      <Box gap={1}>
        <Text color={tone} weight="bold">
          {title}
        </Text>
        <Text weight="semibold" tabular>
          {countdown(left)}
        </Text>
        <Text color={tone}>{bar(1 - left / (one.minutes * MINUTE))}</Text>
        {one.phase === 'focus' && one.label !== '' && (
          <Text dimColor>{one.label}</Text>
        )}
        {isPaused ? (
          <Button
            key="resume"
            variant="primary"
            label="Resume"
            onPress={() => resume($)}
          />
        ) : (
          <Button key="pause" label="Pause" onPress={() => pause($)} />
        )}
        <Button key="plus5" label="+5" onPress={() => extend($, 5)} />
        <Button key="stop" label="Stop" onPress={() => clear($)} />
      </Box>
    )
  })
}
