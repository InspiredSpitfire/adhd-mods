export type Phase = 'focus' | 'break'

export type Timer = {
  phase: Phase
  status: 'running' | 'paused' | 'done'
  /** Planned length in minutes, every +5 included. */
  minutes: number
  /** The focus length a break hands back to. */
  focusMinutes: number
  /** Epoch milliseconds the countdown reaches zero; read while running. */
  endsAt: number
  /** Milliseconds left when it was paused. */
  leftMs: number
  /** What the block is for; empty when nothing was named. */
  label: string
  /** What it said when it ended; absent until then, and on one an earlier version ended. */
  line?: string
}

declare module 'claude-code' {
  interface PluginState {
    'focus-timer': {
      timer: Shaped<Timer | null>
      now: number
      rounds: number
      isMuted: boolean
    }
  }
}
