import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createReloadController, reloadProject, type ReloadController } from "../src/reload"

type Endpoint = "health" | "path" | "status" | "permission" | "question"
type RequestCall = {
  endpoint: Endpoint
  parameters: unknown
  options: { signal?: AbortSignal; throwOnError?: boolean } | undefined
}
type PlannedResponse = unknown | Error | (() => unknown | Promise<unknown>)

const targetDirectory = "/server/projects/selected"
const serverPath = (directory = targetDirectory, home = "/server/home") => ({
  home,
  state: "/server/state",
  config: "/server/config",
  worktree: directory,
  directory,
})
const ok = (data: unknown, extras: Record<string, unknown> = {}) => ({ data, error: undefined, ...extras })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fakeClock() {
  let nextID = 0
  const callbacks = new Map<number, () => void>()
  return {
    clearTimeout(id: unknown) {
      callbacks.delete(id as number)
    },
    fireAll() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback()
    },
    setTimeout(callback: () => void) {
      const id = ++nextID
      callbacks.set(id, callback)
      return id
    },
  }
}

function host(input: {
  directory?: string
  pathDirectory?: string
  home?: string
  responses?: Partial<Record<Endpoint, PlannedResponse[]>>
  workspaceID?: unknown
} = {}) {
  const calls: RequestCall[] = []
  const order: string[] = []
  const toasts: Array<{ message?: string; title?: string; variant?: string }> = []
  const listeners = new Set<(event: unknown) => void>()
  const responses = input.responses ?? {}
  const selected: Record<string, unknown> = {
    id: "session-selected",
    directory: input.directory ?? targetDirectory,
  }
  if ("workspaceID" in input) selected.workspaceID = input.workspaceID
  let route: Record<string, unknown> = {
    name: "session",
    params: { sessionID: selected.id },
  }

  const fallback = (endpoint: Endpoint) => {
    if (endpoint === "health") return ok({ healthy: true, version: "1.18.3" })
    if (endpoint === "path") return ok(serverPath(input.pathDirectory ?? String(selected.directory), input.home))
    if (endpoint === "status") return ok({})
    return ok([])
  }
  const request = (endpoint: Endpoint) => async (parameters: unknown, options?: RequestCall["options"]) => {
    order.push(endpoint)
    calls.push({ endpoint, parameters, options })
    const planned = responses[endpoint]?.shift()
    const result = planned === undefined ? fallback(endpoint) : planned
    if (result instanceof Error) throw result
    return typeof result === "function" ? await result() : await result
  }

  const api = {
    client: {
      defaultDirectory: "/client/default/must-not-be-used",
      global: {
        health: (options?: RequestCall["options"]) => request("health")(undefined, options),
      },
      path: { get: request("path") },
      session: { status: request("status") },
      permission: { list: request("permission") },
      question: { list: request("question") },
    },
    event: {
      on(type: string, handler: (event: unknown) => void) {
        order.push(`subscribe:${type}`)
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    lifecycle: { signal: new AbortController().signal },
    route: {
      get current() {
        return route
      },
    },
    state: {
      session: {
        get(sessionID: string) {
          return selected.id === sessionID ? selected : undefined
        },
      },
    },
    ui: {
      toast(toast: { message?: string; title?: string; variant?: string }) {
        toasts.push(toast)
      },
    },
  } as unknown as TuiPluginApi

  return {
    api,
    calls,
    emitDisposed(directory: string) {
      const event = { id: "event-private", type: "server.instance.disposed", properties: { directory } }
      for (const listener of listeners) listener(event)
    },
    listenerCount: () => listeners.size,
    order,
    selected,
    setRoute(next: Record<string, unknown>) {
      route = next
    },
    toasts,
  }
}

function invoke(controller: ReloadController, fake: ReturnType<typeof host>) {
  return controller({
    api: fake.api,
    target: {
      sessionID: "session-selected",
      directory: String(fake.selected.directory),
    },
  })
}

function toastMessages(fake: ReturnType<typeof host>) {
  return fake.toasts.map((toast) => toast.message ?? "")
}

describe("clear preflight", () => {
  test("subscribes first, proves the target, and checks every blocker twice with bounded explicit-directory requests", async () => {
    const actions: string[] = []
    const fake = host()
    const controller = createReloadController({
      onPreflightClear: ({ directory }) => {
        actions.push(directory)
      },
    })

    await invoke(controller, fake)

    expect(fake.order).toEqual([
      "subscribe:server.instance.disposed",
      "health",
      "path",
      "status",
      "permission",
      "question",
      "health",
      "path",
      "status",
      "permission",
      "question",
    ])
    expect(fake.calls).toHaveLength(10)
    expect(fake.calls.filter((call) => call.endpoint !== "health")
      .every((call) => JSON.stringify(call.parameters) === JSON.stringify({ directory: targetDirectory }))).toBe(true)
    expect(fake.calls.every((call) => call.options?.throwOnError === false)).toBe(true)
    expect(fake.calls.every((call) => call.options?.signal instanceof AbortSignal)).toBe(true)
    expect(actions).toEqual([targetDirectory])
    expect(fake.toasts).toHaveLength(0)
    expect(fake.listenerCount()).toBe(0)
  })

  test.each([
    ["POSIX trailing separator", "/server/projects/selected/", targetDirectory, targetDirectory],
    ["drive-letter separators", "c:\\projects\\selected\\", "C:/projects/selected", "C:/projects/selected"],
    ["UNC separators", "\\\\server\\share\\selected\\", "//server/share/selected", "//server/share/selected"],
  ])("accepts a portable canonical alias: %s", async (_name, selectedDirectory, pathDirectory, expected) => {
    const actions: string[] = []
    const fake = host({ directory: selectedDirectory, pathDirectory })
    await invoke(createReloadController({
      onPreflightClear: ({ directory }) => {
        actions.push(directory)
      },
    }), fake)

    expect(actions).toEqual([expected])
    expect(fake.toasts).toHaveLength(0)
  })

  test("accepts the documented race after the final check without performing a third check", async () => {
    let actions = 0
    const fake = host()
    const controller = createReloadController({
      onPreflightClear: () => {
        actions += 1
        fake.emitDisposed(targetDirectory)
      },
    })

    await invoke(controller, fake)

    expect(actions).toBe(1)
    expect(fake.calls.filter((call) => call.endpoint === "status")).toHaveLength(2)
    expect(fake.toasts).toHaveLength(0)
  })

  test("refuses an unsupported connected server even when the TUI version is supported", async () => {
    let actions = 0
    const fake = host({ responses: { health: [ok({ healthy: true, version: "1.18.5" })] } })

    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(toastMessages(fake)).toEqual([
      "Reload refused because the connected OpenCode server version is unsupported.",
    ])
  })
})

describe("observed blockers", () => {
  test.each([
    ["busy", { privateSession: { type: "busy" } }],
    ["retry", { privateSession: { type: "retry", message: "retry-private" } }],
    ["an unrecognized status entry", { privateSession: null }],
  ])("refuses %s status without inspecting the entry", async (_name, status) => {
    let actions = 0
    const fake = host({ responses: { status: [ok(status)] } })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(toastMessages(fake)).toEqual(["Reload refused because active work was detected."])
  })

  test.each([
    ["permission", [Object.freeze({ private: "permission-private" })], [], "a permission request"],
    ["question", [], [Object.freeze({ private: "question-private" })], "a question"],
    ["permission and question", [Object.freeze({ private: "permission-private" })], [Object.freeze({ private: "question-private" })], "a permission request"],
  ])("refuses pending %s", async (_name, permissions, questions, category) => {
    let actions = 0
    const fake = host({
      responses: {
        permission: [ok(permissions)],
        question: [ok(questions)],
      },
    })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(toastMessages(fake)).toEqual([`Reload refused because ${category} is pending.`])
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test("refuses a blocker that appears only in the final check", async () => {
    let actions = 0
    const fake = host({ responses: { status: [ok({}), ok({ privateSession: { type: "busy" } })] } })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(fake.calls.filter((call) => call.endpoint === "status")).toHaveLength(2)
    expect(toastMessages(fake)).toEqual(["Reload refused because active work was detected."])
  })
})

describe("fail-closed uncertainty", () => {
  test.each([
    ["path wrapper", "path", null],
    ["missing data", "status", { error: undefined }],
    ["status array", "status", ok([])],
    ["non-plain status", "status", ok(Object.create({ inherited: true }))],
    ["permission object", "permission", ok({})],
    ["question object", "question", ok({})],
    ["response error", "status", { data: {}, error: { message: "error-private" } }],
  ] as const)("refuses a malformed %s response", async (_name, endpoint, response) => {
    let actions = 0
    const fake = host({ responses: { [endpoint]: [response] } })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(fake.toasts).toHaveLength(1)
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test.each(["health", "path", "status", "permission", "question"] as const)("contains a thrown %s request failure", async (endpoint) => {
    const fake = host({ responses: { [endpoint]: [new Error(`${endpoint}-error-private`)] } })
    await expect(invoke(createReloadController(), fake)).resolves.toBeUndefined()

    expect(fake.toasts).toHaveLength(1)
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test.each(["health", "path", "status", "permission", "question"] as const)("bounds a never-settling %s request", async (endpoint) => {
    const started = deferred<void>()
    const clock = fakeClock()
    const fake = host({
      responses: {
        [endpoint]: [() => {
          started.resolve()
          return new Promise(() => {})
        }],
      },
    })
    const pending = invoke(createReloadController({ clock, requestTimeoutMs: 50 }), fake)
    await started.promise
    clock.fireAll()
    await pending

    expect(fake.toasts).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)
  })

  test.each([
    ["relative", "server/projects/selected", "/server/home"],
    ["bare drive", "C:", "C:/Users/person"],
    ["incomplete UNC", "\\\\server", "C:/Users/person"],
    ["server home", "/server/home/", "/server/home"],
  ])("refuses an unprovable server path: %s", async (_name, directory, home) => {
    let actions = 0
    const fake = host({ directory, pathDirectory: directory, home })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(toastMessages(fake)).toEqual(["Reload refused because the server directory could not be verified."])
  })

  test("refuses a path response that changes directory", async () => {
    let actions = 0
    const fake = host({
      responses: {
        path: [ok(serverPath()), ok(serverPath("/server/projects/other"))],
      },
    })
    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(toastMessages(fake)).toEqual(["Reload refused because the server directory changed during preflight."])
  })
})

describe("route and lifecycle drift", () => {
  test.each([
    ["route", (fake: ReturnType<typeof host>) => fake.setRoute({ name: "home" })],
    ["session", (fake: ReturnType<typeof host>) => { fake.selected.id = "session-other" }],
    ["directory", (fake: ReturnType<typeof host>) => { fake.selected.directory = "/server/projects/other" }],
    ["workspace", (fake: ReturnType<typeof host>) => { fake.selected.workspaceID = "workspace-private" }],
  ])("refuses %s drift across a request await", async (_name, drift) => {
    let actions = 0
    const pathResponses: PlannedResponse[] = []
    const fake = host({ responses: { path: pathResponses } })
    pathResponses.push(() => {
      drift(fake)
      return ok(serverPath())
    })

    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(fake.toasts).toHaveLength(1)
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test.each(["workspace-private", null, { malformed: "workspace-private" }])("refuses an initially present or malformed workspace identity", async (workspaceID) => {
    const fake = host({ workspaceID })
    await invoke(createReloadController(), fake)

    expect(fake.calls).toHaveLength(0)
    expect(toastMessages(fake)).toEqual(["Reload refused because the selected session uses a workspace."])
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test("refuses a same-directory disposal observed during preflight", async () => {
    let actions = 0
    const statusResponses: PlannedResponse[] = []
    const fake = host({ responses: { status: statusResponses } })
    statusResponses.push(() => {
      fake.emitDisposed(`${targetDirectory}/`)
      return ok({})
    })

    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(0)
    expect(toastMessages(fake)).toEqual(["Reload refused because the project instance changed during preflight."])
  })

  test("ignores an unrelated disposal during preflight", async () => {
    let actions = 0
    const statusResponses: PlannedResponse[] = []
    const fake = host({ responses: { status: statusResponses } })
    statusResponses.push(() => {
      fake.emitDisposed("/server/projects/unrelated")
      return ok({})
    })

    await invoke(createReloadController({ onPreflightClear: () => { actions += 1 } }), fake)

    expect(actions).toBe(1)
    expect(fake.toasts).toHaveLength(0)
  })
})

describe("single-flight coordination", () => {
  test("prevents simultaneous work and permits a later invocation after completion", async () => {
    const actionStarted = deferred<void>()
    const actionRelease = deferred<void>()
    let actions = 0
    const fake = host()
    const controller = createReloadController({
      async onPreflightClear() {
        actions += 1
        actionStarted.resolve()
        await actionRelease.promise
      },
    })

    const first = invoke(controller, fake)
    await actionStarted.promise
    const requestCount = fake.calls.length
    await invoke(controller, fake)

    expect(actions).toBe(1)
    expect(fake.calls).toHaveLength(requestCount)
    expect(toastMessages(fake)).toEqual(["Project reload is already in progress."])

    actionRelease.resolve()
    await first
    await invoke(controller, fake)
    expect(actions).toBe(2)
  })

  test("releases the guard after a pre-dispatch refusal", async () => {
    let actions = 0
    const fake = host({
      responses: {
        status: [ok({ active: { type: "busy" } }), ok({}), ok({})],
      },
    })
    const controller = createReloadController({ onPreflightClear: () => { actions += 1 } })

    await invoke(controller, fake)
    await invoke(controller, fake)

    expect(actions).toBe(1)
    expect(fake.toasts).toHaveLength(1)
  })

  test("reserves a durable unknown-disposition guard for the later lifecycle unit", async () => {
    let actions = 0
    const fake = host()
    const controller = createReloadController({
      onPreflightClear({ markOutcomeUnknown }) {
        actions += 1
        markOutcomeUnknown()
      },
    })

    await invoke(controller, fake)
    const requestCount = fake.calls.length
    await invoke(controller, fake)

    expect(actions).toBe(1)
    expect(fake.calls).toHaveLength(requestCount)
    expect(toastMessages(fake)).toEqual([
      "Project reload outcome is uncertain and project state was not verified. Restart the TUI before retrying; a full-server restart may still be needed.",
    ])
  })

  test("the default export controller is also a module-process singleton", async () => {
    const pathStarted = deferred<void>()
    const pathRelease = deferred<unknown>()
    const fake = host({
      responses: {
        path: [() => {
          pathStarted.resolve()
          return pathRelease.promise
        }],
      },
    })

    const first = invoke(reloadProject, fake)
    await pathStarted.promise
    await invoke(reloadProject, fake)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.map((call) => call.endpoint)).toEqual(["health", "path"])
    expect(toastMessages(fake)).toEqual(["Project reload is already in progress."])

    pathRelease.resolve(ok(serverPath()))
    await first
  })
})

describe("privacy", () => {
  test("never exposes pending bodies, response metadata, session identifiers, paths, or raw failures", async () => {
    const canaries = [
      "permission-body-private",
      "question-body-private",
      "request-private",
      "response-private",
      "transport-private",
      "session-selected",
      targetDirectory,
    ]
    const logs: unknown[] = []
    const original = { error: console.error, log: console.log, warn: console.warn }
    console.error = (...args: unknown[]) => { logs.push(args) }
    console.log = (...args: unknown[]) => { logs.push(args) }
    console.warn = (...args: unknown[]) => { logs.push(args) }
    try {
      const pending = host({
        responses: {
          permission: [ok([
            new Proxy({ body: "permission-body-private" }, {
              get() {
                throw new Error("permission-body-private")
              },
            }),
          ], {
            request: { body: "request-private" },
            response: { body: "response-private" },
          })],
          question: [ok([{ body: "question-body-private" }])],
        },
      })
      const failed = host({ responses: { path: [new Error("transport-private")] } })

      await expect(invoke(createReloadController(), pending)).resolves.toBeUndefined()
      await expect(invoke(createReloadController(), failed)).resolves.toBeUndefined()

      const output = JSON.stringify({ logs, pending: pending.toasts, failed: failed.toasts })
      for (const canary of canaries) expect(output).not.toContain(canary)
    } finally {
      console.error = original.error
      console.log = original.log
      console.warn = original.warn
    }
  })
})
