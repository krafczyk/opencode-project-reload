import { describe, expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { ReloadController, ReloadInvocation } from "../src/reload"

type Session = {
  id: string
  directory: string
  workspaceID?: string
}

type Command = {
  name: string
  title?: string
  category?: string
  namespace?: string
  slashName?: string
  run: (...args: unknown[]) => unknown
}

type TuiExports = {
  default: TuiPluginModule & { id: string }
  createTuiPlugin: (reload: ReloadController) => TuiPluginModule & { id: string }
}

const pluginMeta = {
  id: "opencode-project-reload",
  source: "npm",
  spec: "opencode-project-reload",
  target: "tui",
  state: "same",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
} as const

async function loadPackage() {
  const packageExport: string = "opencode-project-reload/tui"
  return (await import(packageExport)) as TuiExports
}

function session(input: Partial<Session> = {}): Session {
  return {
    id: "session-selected",
    directory: "/server/projects/selected",
    ...input,
  }
}

function host(input: {
  version?: string
  ready?: boolean
  route?: { name: string; params?: { sessionID?: string } }
  sessions?: Session[]
} = {}) {
  const registrations: Array<{ commands?: Command[]; bindings?: unknown[] }> = []
  const toasts: unknown[] = []
  const forbiddenAccesses: string[] = []
  const routeReads: string[] = []
  const sessionReads: string[] = []
  const sessions = new Map((input.sessions ?? [session()]).map((item) => [item.id, item]))
  const route = input.route ?? { name: "session", params: { sessionID: "session-selected" } }

  const base = {
    app: { version: input.version ?? "1.18.3" },
    keymap: {
      registerLayer(layer: { commands?: Command[]; bindings?: unknown[] }) {
        registrations.push(layer)
        return () => {}
      },
    },
    route: {
      get current() {
        routeReads.push("current")
        return route
      },
    },
    state: {
      ready: input.ready ?? true,
      session: {
        get(sessionID: string) {
          sessionReads.push(sessionID)
          return sessions.get(sessionID)
        },
      },
    },
    ui: {
      toast(input: unknown) {
        toasts.push(input)
      },
    },
  }

  const api = new Proxy(base, {
    get(target, property, receiver) {
      if (["client", "command", "event", "lifecycle", "plugins"].includes(String(property))) {
        forbiddenAccesses.push(String(property))
        throw new Error(`Unexpected lifecycle or model API access: ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as TuiPluginApi

  return { api, forbiddenAccesses, registrations, routeReads, sessionReads, toasts }
}

async function registeredCommand(reload: ReloadController, input: Parameters<typeof host>[0] = {}) {
  const module = await loadPackage()
  const fake = host(input)
  await module.createTuiPlugin(reload).tui(fake.api, undefined, pluginMeta)
  expect(fake.registrations).toHaveLength(1)
  expect(fake.registrations[0]?.commands).toHaveLength(1)
  return { ...fake, command: fake.registrations[0]!.commands![0]! }
}

describe("package contract", () => {
  test("imports a target-exclusive module through the package ./tui export", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const module = await loadPackage()

    expect(manifest.exports).toEqual({ "./tui": "./dist/tui.js" })
    expect(manifest.files).toEqual(["dist/tui.js"])
    expect(manifest.engines.opencode).toBe(">=1.18.3 <=1.18.4")
    expect(manifest.devDependencies).toEqual({
      "@opencode-ai/plugin": "1.18.3",
      "@opentui/core": "0.4.3",
      "@opentui/keymap": "0.4.3",
      "@opentui/solid": "0.4.3",
      "@types/bun": "1.3.13",
      "@types/node": "24.12.2",
      typescript: "5.8.2",
    })
    expect(module.default.id).toBe("opencode-project-reload")
    expect(typeof module.default.tui).toBe("function")
    expect("server" in module.default).toBe(false)
  })
})

describe("native command registration", () => {
  test("registers one ungated palette command with slash autocomplete metadata", async () => {
    const fake = await registeredCommand(() => {})

    expect(fake.command).toMatchObject({
      name: "project.reload",
      title: "Reload project",
      category: "Project",
      namespace: "palette",
      slashName: "reload-project",
    })
    expect(fake.command.run).toHaveLength(0)
    expect(fake.registrations[0]).not.toHaveProperty("mode")
    expect(fake.registrations[0]?.bindings ?? []).toHaveLength(0)
    expect(fake.routeReads).toHaveLength(0)
    expect(fake.sessionReads).toHaveLength(0)
    expect(fake.forbiddenAccesses).toHaveLength(0)
  })

  test("dispatches the registered native command and delegates exactly once", async () => {
    const invocations: ReloadInvocation[] = []
    const fake = await registeredCommand((input) => {
      invocations.push(input)
    })

    await fake.command.run()

    expect(invocations).toEqual([
      {
        api: fake.api,
        target: {
          sessionID: "session-selected",
          directory: "/server/projects/selected",
        },
      },
    ])
    expect(fake.routeReads).toEqual(["current"])
    expect(fake.sessionReads).toEqual(["session-selected"])
    expect(fake.forbiddenAccesses).toHaveLength(0)
  })

  test("performs no route, session, lifecycle, or model work while loading", async () => {
    const fake = await registeredCommand(() => {
      throw new Error("controller must not run during plugin initialization")
    })

    expect(fake.routeReads).toHaveLength(0)
    expect(fake.sessionReads).toHaveLength(0)
    expect(fake.toasts).toHaveLength(0)
    expect(fake.forbiddenAccesses).toHaveLength(0)
  })

  test("dispatches on the upper supported OpenCode patch", async () => {
    let calls = 0
    const fake = await registeredCommand(() => {
      calls += 1
    }, {
      version: "1.18.4",
    })

    await fake.command.run()

    expect(calls).toBe(1)
    expect(fake.toasts).toHaveLength(0)
  })
})

describe("invocation scope", () => {
  test("allows an ordinary attached-server session without consulting TUI-host paths", async () => {
    const invocations: ReloadInvocation[] = []
    const attached = session({ directory: "/remote/server/project" })
    const fake = await registeredCommand((input) => {
      invocations.push(input)
    }, {
      sessions: [attached],
    })

    await fake.command.run()

    expect(invocations[0]?.target).toEqual({
      sessionID: attached.id,
      directory: "/remote/server/project",
    })
    expect(fake.forbiddenAccesses).toHaveLength(0)
  })

  test.each([
    ["home route", { route: { name: "home" } }],
    ["missing selected session", { sessions: [] }],
    ["workspace session", { sessions: [session({ workspaceID: "workspace-1" })] }],
    ["TUI state that is not ready", { ready: false }],
    ["unsupported app version", { version: "1.18.5" }],
  ] as const)("refuses %s before delegation", async (_name, input) => {
    let calls = 0
    const fake = await registeredCommand(() => {
      calls += 1
    }, {
      ...input,
      sessions: "sessions" in input ? [...input.sessions] : undefined,
    })

    await fake.command.run()

    expect(calls).toBe(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.forbiddenAccesses).toHaveLength(0)
  })
})
