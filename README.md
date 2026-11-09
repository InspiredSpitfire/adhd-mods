# adhd-mods

Two Claude Code mods for brains that need the clock and the list to live where the work is: a **focus timer** that sits above the prompt, and a **body double** pane that shows the task you are on, the timer, and everything you finished today. Install one or both. The body double works alone, and gets better with the timer next to it.

## Install

At the prompt of a terminal session:

```
/plugin install focus-timer --marketplace InspiredSpitfire/adhd-mods
```

```
/plugin install body-double --marketplace InspiredSpitfire/adhd-mods
```

Answer `y` to add the marketplace the first time, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install focus-timer --marketplace InspiredSpitfire/adhd-mods
```

```
claude plugin install body-double --marketplace InspiredSpitfire/adhd-mods
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `InspiredSpitfire/adhd-mods`, then **Add plugin**.

## focus-timer

A countdown in the band above the prompt, with a progress bar, pause, +5, break, and a done line with some personality, spoken out loud on a Mac (mute it if your office has opinions).

```
/timer                   25 minutes, or the status of what is running
/timer 45 write the essay
/timer 90s               seconds work too
/timer break             5 minutes; /timer break 10 for ten
/timer pause | resume | +5 | stop | status
/timer mute | unmute
```

The band shows buttons for the same things, so you never have to remember the words. When a block ends you get a toast, a voice line, and buttons for a break, going again, or dismissing. Claude can also run the timer for you in plain words ("start a 10 minute timer") through a tool the mod registers.

## body-double

A pane beside the chat with three things on it:

1. **The task you are on**, read from a markdown task list. It shows the first `## ` heading under `# NOW`, else `# TODAY`, else the first one, with its `- next step:` and `- deadline:` lines. Default file: `~/notes/tasks/tasks.md`. Point it anywhere with `/double tasks <path>`. The mod only reads the file; it never writes to it.
2. **The focus timer**, live, when the focus-timer mod is loaded.
3. **Done today**: every focus block that runs out lands here on its own with its name and minutes. Breaks and stopped blocks do not. Add anything else by hand.

```
/double                  open or close the pane
/double tasks <path>     read the task from another file
/double refresh          re-read the task file now
/done <what>             log something you finished
/done                    list today
/done undo               remove the last one
```

Two buttons on the pane: **Focus 25** starts a block named after the task (needs the focus-timer mod), **Mark done** logs the task without a timer.

The list is kept per local day and shared by every session you have open, so two windows add to the same day. On the desktop app the pane opens on its own at the start of a session; close it and it stays closed until you ask. In a terminal it waits for `/double`.

### Task file format

Any markdown works, but this is what the parser looks for:

```
# NOW

## T-001 · Call the vet
- deadline: today 12:00
- next step: Call while standing outside with the dog.

# TODAY

## Wash hair
- next step: Set an alarm for 4:30.
```

The `T-001 ·` id is optional. A `—` or `none stated` on a line is treated as empty.

## How they fit together

The body double watches the focus timer's state through the engine's hooks, so there is no setup: install both and a finished block shows up on the list. Without the timer, the body double still shows your task and takes `/done`.

## Develop

In either mod's folder:

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` is the whole mod in each case; `types/index.d.ts` declares its state; `tests/` covers the behaviour described above.

## License

MIT. Made by Inspired Spitfire.
