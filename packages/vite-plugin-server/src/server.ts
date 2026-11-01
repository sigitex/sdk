import type { Plugin } from "vite"
import {
  spawn,
  type ChildProcess,
} from "node:child_process"

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export default function server(command: string[]): Plugin {
  let child: ChildProcess | null = null
  let pgid: number | null = null
  let shutdown: Promise<void> | null = null
  let childExit: Promise<void> | null = null
  let receivedSignal = false

  function signalGroup(signal: NodeJS.Signals): boolean {
    if (pgid === null) {
      return false
    }

    try {
      process.kill(-pgid, signal)
      return true
    // oxlint-disable-next-line typescript/no-explicit-any
    } catch (error: any) {
      if (error?.code !== "ESRCH") {
        console.error(
          `[server] failed to send ${signal} to process group ${pgid}:`,
          error,
        )
      }
      return false
    }
  }

  function groupExists(): boolean {
    if (pgid === null) {
      return false
    }

    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }

  function kill(): Promise<void> {
    if (shutdown !== null) {
      return shutdown
    }

    if (pgid === null) {
      return Promise.resolve()
    }

    shutdown = (async () => {
      signalGroup("SIGINT")

      // Give graceful shutdown a chance.
      await sleep(1000)

      if (groupExists()) {
        signalGroup("SIGKILL")
      }

      await childExit

      child = null
      pgid = null
      childExit = null
    })()

    return shutdown
  }

  // An "exit" handler can't wait, so make the final cleanup forceful.
  function killOnExit() {
    signalGroup("SIGKILL")
  }

  async function stopOnSignal(exitCode: number) {
    if (receivedSignal) {
      signalGroup("SIGKILL")
    }
    receivedSignal = true

    await kill()
    removeHandlers()
    process.exit(exitCode)
  }

  async function interrupt() {
    await stopOnSignal(130)
  }

  async function terminate() {
    await stopOnSignal(143)
  }

  function addHandlers() {
    process.once("exit", killOnExit)
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
  }

  function removeHandlers() {
    process.off("exit", killOnExit)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }

  return {
    name: "server",

    configureServer() {
      const serverProcess = spawn(
        command[0],
        command.slice(1),
        {
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
        },
      )

      child = serverProcess
      pgid = serverProcess.pid ?? null
      shutdown = null
      receivedSignal = false
      childExit = new Promise<void>((resolve) => {
        serverProcess.once("exit", () => resolve())
        serverProcess.once("error", () => resolve())
      })

      serverProcess.once("error", (error) => {
        console.error("[server] failed:", error)
      })

      serverProcess.once("exit", (code, signal) => {
        if (child === serverProcess) {
          console.error(
            `[server] process exited with code ${code}, signal ${signal}`,
          )

          if (shutdown !== null) {
            return
          }

          child = null

          // Don't blindly clear pgid: descendants might still be alive.
          if (groupExists()) {
            console.error(
              `[server] process group ${pgid} survived its leader; killing it`,
            )
            signalGroup("SIGKILL")
          }

          pgid = null
        }
      })

      addHandlers()
    },

    async buildEnd() {
      await kill()
      removeHandlers()
    },
  }
}
