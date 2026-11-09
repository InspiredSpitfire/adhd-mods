/** One thing finished today. */
export type Done = {
  /** Epoch milliseconds it was finished. */
  at: number
  /** What it was. */
  label: string
  /** Minutes the block ran; 0 when it was typed in with /done. */
  minutes: number
  /** Where it came from: a focus block that ran out, or /done. */
  source: 'timer' | 'manual'
}

/** The task the pane shows, read from the tasks file. */
export type Task = {
  /** `T-001`, or empty when the heading had no id. */
  id: string
  title: string
  /** Its `next step:` line, or empty. */
  step: string
  /** Its `deadline:` line, or empty. */
  due: string
  /** The `# NOW`, `# TODAY` section it sits in. */
  bucket: string
}

/** The focus-timer mod's timer, as last written; null when none or unknown. */
export type Watched = {
  phase: 'focus' | 'break'
  status: 'running' | 'paused' | 'done'
  endsAt: number
  leftMs: number
  minutes: number
  label: string
}

declare module 'claude-code' {
  interface PluginState {
    'body-double': {
      task: Shaped<Task | null>
      /** Why no task shows, when none does; empty otherwise. */
      taskNote: string
      done: Shaped<Done[]>
      /** The local day the list is for, `YYYY-MM-DD`. */
      day: string
      timer: Shaped<Watched | null>
      /** Epoch milliseconds, mirrored from the focus timer's clock. */
      now: number
    }
  }
}
