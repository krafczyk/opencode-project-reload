import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createReloadController, type ReloadController } from "../src/reload"

type Endpoint = "dispose" | "health" | "path" | "permission" | "question" | "session" | "status"
type RequestCall = {
  endpoint: Endpoint
  parameters: Record<string, unknown>
  options: { signal?: AbortSignal; throwOnError?: boolean } | undefined
}
type PlannedResponse = unknown | Error | (() => unknown | Promise<unknown>)

const targetDirectory = "/server/projects/selected"
const otherDirectory = "/server/projects/other"
const sessionID = "session-selected"
const ok = (data: unknown) => ({ data, error: undefined })
const pathData = (directory = targetDirectory) => ({
  home: "/server/home",
  state: "/server/state",
  config: "/server/config",
  worktree: directory,
  directory,
})

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
  let now = 0
  let nextID = 0
  const timers = new Map<number, { callback: () => void; due: number }>()
  return {
    advance(milliseconds: number) {
      now += milliseconds
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0]
        if (!due) break
        timers.delete(due[0])
        due[1].callback()
      }
    },
    clearTimeout(id: unknown) {
      timers.delete(id as number)
    },
    pending: () => timers.size,
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextID
      timers.set(id, { callback, due: now + delay })
      return id
    },
  }
}

async function flush() {
  for (let index = 0; index < 100; index += 1) await Promise.resolve()
}

function host(input: {
  responses?: Partial<Record<Endpoint, PlannedResponse[]>>
  onDispose?: () => unknown | Promise<unknown>
  abortOnToast?: boolean
} = {}) {
  const calls: RequestCall[] = []
  const forbidden: string[] = []
  const listeners = new Set<(event: { properties: { directory: string } }) => void>()
  const lifecycle = new AbortController()
  const responses = input.responses ?? {}
  const route = { name: "session", params: { sessionID } }
  const selected = {
    id: sessionID,
    directory: targetDirectory,
    messages: [{ id: "persisted-message", text: "must remain untouched" }],
    state: { custom: "persisted-state" },
  }
  const toasts: Array<{ message: string; title?: string; variant?: string }> = []

  const fallback = (endpoint: Endpoint) => {
    if (endpoint === "dispose") return input.onDispose?.() ?? ok(true)
    if (endpoint === "health") return ok({ healthy: true, version: "1.18.3" })
    if (endpoint === "path") return ok(pathData())
    if (endpoint === "session") return ok(selected)
    if (endpoint === "status") return ok({})
    return ok([])
  }
  const request = (endpoint: Endpoint) => async (
    parameters: Record<string, unknown>,
    options?: RequestCall["options"],
  ) => {
    calls.push({ endpoint, parameters, options })
    const planned = responses[endpoint]?.shift()
    const result = planned === undefined ? fallback(endpoint) : planned
    if (result instanceof Error) throw result
    return typeof result === "function" ? await result() : await result
  }

  const session = new Proxy({
    get: request("session"),
    status: request("status"),
  }, {
    get(target, property, receiver) {
      if (!(property in target)) forbidden.push(`session.${String(property)}`)
      return Reflect.get(target, property, receiver)
    },
  })
  const client = new Proxy({
    global: {
      health: (options?: RequestCall["options"]) => request("health")({}, options),
    },
    instance: { dispose: request("dispose") },
    path: { get: request("path") },
    permission: { list: request("permission") },
    question: { list: request("question") },
    session,
  }, {
    get(target, property, receiver) {
      if (!(property in target)) forbidden.push(`client.${String(property)}`)
      return Reflect.get(target, property, receiver)
    },
  })

  const api = {
    client,
    event: {
      on(_type: string, handler: (event: { properties: { directory: string } }) => void) {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    lifecycle: {
      signal: lifecycle.signal,
      onDispose() {
        forbidden.push("lifecycle.onDispose")
        return () => {}
      },
    },
    route: {
      current: route,
      navigate() {
        forbidden.push("route.navigate")
      },
    },
    state: {
      session: {
        get(id: string) {
          return id === selected.id ? selected : undefined
        },
      },
    },
    ui: {
      toast(toast: { message: string; title?: string; variant?: string }) {
        toasts.push(toast)
        if (input.abortOnToast) lifecycle.abort()
      },
    },
  } as unknown as TuiPluginApi

  return {
    abort: () => lifecycle.abort(),
    api,
    calls,
    client,
    emit(properties: { directory?: string }) {
      const event = { properties }
      for (const listener of listeners) listener(event as { properties: { directory: string } })
    },
    emitDisposed(directory = targetDirectory) {
      const event = { properties: { directory } }
      for (const listener of listeners) listener(event)
    },
    forbidden,
    listenerCount: () => listeners.size,
    route,
    selected,
    toasts,
  }
}

function invoke(controller: ReloadController, fake: ReturnType<typeof host>) {
  return controller({
    api: fake.api,
    target: { directory: targetDirectory, sessionID },
  })
}

function lifecycleController(clock = fakeClock(), options: Record<string, unknown> = {}) {
  return {
    clock,
    controller: createReloadController({
      clock,
      recoveryRetryMs: 10,
      recoveryTimeoutMs: 100,
      requestTimeoutMs: 50,
      ...options,
    }),
  }
}

function endpointCalls(fake: ReturnType<typeof host>, endpoint: Endpoint) {
  return fake.calls.filter((call) => call.endpoint === endpoint)
}

describe("disposal lifecycle", () => {
  test("accepts the response before the event and preserves the selected route and session object", async () => {
    const disposeStarted = deferred<void>()
    const fake = host({
      onDispose() {
        disposeStarted.resolve()
        return ok(true)
      },
    })
    const originalRoute = fake.route
    const originalSession = fake.selected
    const originalState = fake.selected.state
    const originalMessages = fake.selected.messages
    const { controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await disposeStarted.promise
    await flush()
    expect(endpointCalls(fake, "session")).toHaveLength(0)

    fake.emitDisposed()
    await pending

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(endpointCalls(fake, "path")).toHaveLength(3)
    expect(endpointCalls(fake, "session")).toHaveLength(1)
    expect(fake.route).toBe(originalRoute)
    expect(fake.selected).toBe(originalSession)
    expect(fake.selected.state).toBe(originalState)
    expect(fake.selected.messages).toBe(originalMessages)
    expect(fake.toasts.map((toast) => toast.variant)).toEqual(["info", "success"])
    expect(fake.toasts[1]?.message).toContain("Project state was reloaded")
    expect(fake.toasts[1]?.message).toContain("TUI or full-server restart")
  })

  test("treats an event observed before the disposal response as ambiguous", async () => {
    const response = deferred<unknown>()
    const disposeStarted = deferred<void>()
    let fake!: ReturnType<typeof host>
    fake = host({
      onDispose() {
        disposeStarted.resolve()
        fake.emitDisposed()
        return response.promise
      },
    })
    const { controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await disposeStarted.promise
    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(endpointCalls(fake, "path")).toHaveLength(2)

    response.resolve(ok(true))
    await pending
    await invoke(controller, fake)
    expect(endpointCalls(fake, "session")).toHaveLength(0)
    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
  })

  test("ignores unrelated and duplicate events without duplicating recovery or feedback", async () => {
    const fake = host({ onDispose: () => ok(true) })
    const pending = invoke(lifecycleController().controller, fake)
    await flush()
    fake.emitDisposed(otherDirectory)
    fake.emitDisposed()
    fake.emitDisposed(`${targetDirectory}/`)

    await pending

    expect(endpointCalls(fake, "path")).toHaveLength(3)
    expect(endpointCalls(fake, "session")).toHaveLength(1)
    expect(fake.toasts.filter((toast) => toast.variant === "success")).toHaveLength(1)
  })

  test("uses exactly one target-directory dispose and explicit target routing for every lifecycle request", async () => {
    const fake = host({ onDispose: () => ok(true) })
    const pending = invoke(lifecycleController().controller, fake)
    await flush()
    fake.emitDisposed()

    await pending

    expect(endpointCalls(fake, "dispose")).toEqual([
      expect.objectContaining({ parameters: { directory: targetDirectory } }),
    ])
    expect(fake.calls.filter((call) => call.endpoint !== "health")
      .every((call) => call.parameters.directory === targetDirectory)).toBe(true)
    expect(fake.calls.some((call) => call.parameters.directory === otherDirectory)).toBe(false)
    expect(fake.calls.every((call) => call.options?.throwOnError === false)).toBe(true)
    expect(fake.calls.every((call) => call.options?.signal instanceof AbortSignal)).toBe(true)
    expect(fake.forbidden).toEqual([])
  })
})

describe("unknown disposition", () => {
  test("reports an in-progress reload while a dispatched operation is still reconciling", async () => {
    const response = deferred<unknown>()
    const disposeStarted = deferred<void>()
    let fake!: ReturnType<typeof host>
    fake = host({
      onDispose() {
        disposeStarted.resolve()
        return response.promise
      },
    })
    const { controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await disposeStarted.promise
    await invoke(controller, fake)

    expect(fake.toasts.at(-1)?.message).toBe("Project reload is already in progress.")
    expect(endpointCalls(fake, "dispose")).toHaveLength(1)

    fake.emitDisposed()
    response.resolve(ok(true))
    await pending
  })

  test.each([
    ["a thrown response", new Error("dispose-private")],
    ["a malformed response", { data: "true", error: undefined }],
    ["an error response", { data: true, error: { message: "response-private" } }],
  ])("keeps a durable guard after %s even when the event was observed", async (_name, response) => {
    let fake!: ReturnType<typeof host>
    fake = host({
      onDispose() {
        fake.emitDisposed()
        return response
      },
    })
    const { controller } = lifecycleController()

    await invoke(controller, fake)
    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(endpointCalls(fake, "session")).toHaveLength(0)
    expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test.each([
    ["with an event", true],
    ["without an event", false],
  ])("times out a dropped response %s, does not retry disposal, and clears listener and timers", async (_name, emitEvent) => {
    const started = deferred<void>()
    let fake!: ReturnType<typeof host>
    fake = host({
      onDispose() {
        started.resolve()
        if (emitEvent) fake.emitDisposed()
        return new Promise(() => {})
      },
    })
    const { clock, controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await started.promise
    clock.advance(50)
    await pending
    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  test("treats a successful response without a matching post-dispatch event as unknown", async () => {
    const disposeStarted = deferred<void>()
    const { clock, controller } = lifecycleController()
    const fake = host({ onDispose: () => { disposeStarted.resolve(); return ok(true) } })

    const pending = invoke(controller, fake)
    await disposeStarted.promise
    await flush()
    clock.advance(50)
    await pending
    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
  })

  test("treats an unusable response without any event as unknown and does not wait for event evidence", async () => {
    const fake = host({ onDispose: () => ({ data: false, error: undefined }) })
    const { clock, controller } = lifecycleController()

    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(endpointCalls(fake, "path")).toHaveLength(2)
    expect(fake.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
  })

  test("releases the guard when the SDK throws before returning a disposal request", async () => {
    const fake = host()
    Object.defineProperty(fake.client, "instance", {
      configurable: true,
      get() {
        throw new Error("synchronous-client-private")
      },
    })
    const { controller } = lifecycleController()

    await invoke(controller, fake)
    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(0)
    expect(fake.toasts.filter((toast) => toast.message.includes("preflight request was unavailable"))).toHaveLength(2)
    expect(JSON.stringify(fake.toasts)).not.toContain("private")
  })

  test("does not accept inherited disposal response data", async () => {
    Object.defineProperty(Object.prototype, "data", { configurable: true, value: true })
    try {
      const fake = host({ onDispose: () => ({}) })
      const { controller } = lifecycleController()

      await invoke(controller, fake)
      await invoke(controller, fake)

      expect(endpointCalls(fake, "dispose")).toHaveLength(1)
      expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
    } finally {
      delete (Object.prototype as { data?: unknown }).data
    }
  })

  test("does not accept an inherited disposal event directory", async () => {
    Object.defineProperty(Object.prototype, "directory", { configurable: true, value: targetDirectory })
    try {
      const fake = host({ onDispose: () => ok(true) })
      const { clock, controller } = lifecycleController()
      const pending = invoke(controller, fake)
      await flush()
      fake.emit({})
      clock.advance(50)
      await pending

      expect(endpointCalls(fake, "dispose")).toHaveLength(1)
      expect(endpointCalls(fake, "session")).toHaveLength(0)
      expect(fake.toasts.at(-1)?.message).toContain("outcome is uncertain")
    } finally {
      delete (Object.prototype as { directory?: unknown }).directory
    }
  })
})

describe("bounded recovery", () => {
  test("retries stale path and session evidence in path-then-session order", async () => {
    const recoveryPathObserved = deferred<void>()
    const staleSessionObserved = deferred<void>()
    const responses: Partial<Record<Endpoint, PlannedResponse[]>> = {
      path: [ok(pathData()), ok(pathData()), () => {
        recoveryPathObserved.resolve()
        return ok(pathData(otherDirectory))
      }, ok(pathData()), ok(pathData())],
      session: [() => {
        staleSessionObserved.resolve()
        return ok({ id: "session-stale", directory: targetDirectory })
      }, ok({ id: sessionID, directory: otherDirectory }), ok({ id: sessionID, directory: targetDirectory })],
    }
    const fake = host({ responses, onDispose: () => ok(true) })
    const { clock, controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await flush()
    fake.emitDisposed()
    await recoveryPathObserved.promise
    await flush()
    clock.advance(10)
    await staleSessionObserved.promise
    await flush()
    clock.advance(10)
    await flush()
    clock.advance(10)
    await pending

    expect(fake.calls.slice(10).map((call) => call.endpoint)).toEqual([
      "dispose",
      "path",
      "path",
      "session",
      "path",
      "session",
      "path",
      "session",
    ])
    expect(fake.toasts.at(-1)?.variant).toBe("success")
  })

  test("rejects workspace recovery evidence before accepting the exact selected session", async () => {
    const workspaceSessionObserved = deferred<void>()
    const responses: Partial<Record<Endpoint, PlannedResponse[]>> = {
      session: [() => {
        workspaceSessionObserved.resolve()
        return ok({ id: sessionID, directory: targetDirectory, workspaceID: "workspace-private" })
      }, ok({ id: sessionID, directory: targetDirectory })],
    }
    const fake = host({ responses, onDispose: () => ok(true) })
    const { clock, controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await flush()
    fake.emitDisposed()
    await workspaceSessionObserved.promise
    await flush()
    clock.advance(10)
    await pending

    expect(endpointCalls(fake, "path")).toHaveLength(4)
    expect(endpointCalls(fake, "session")).toHaveLength(2)
    expect(fake.toasts.at(-1)?.variant).toBe("success")
    expect(JSON.stringify(fake.toasts)).not.toContain("workspace-private")
  })

  test("reports recovery failure, returns idle, and never disposes again without another command", async () => {
    const recoveryAttempted = deferred<void>()
    const responses: Partial<Record<Endpoint, PlannedResponse[]>> = {
      path: [ok(pathData()), ok(pathData()), () => {
        recoveryAttempted.resolve()
        return ok(pathData(otherDirectory))
      }],
    }
    const fake = host({ responses, onDispose: () => ok(true) })
    const { clock, controller } = lifecycleController()

    const first = invoke(controller, fake)
    await flush()
    fake.emitDisposed()
    await recoveryAttempted.promise
    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    clock.advance(100)
    await first
    await flush()

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(fake.toasts.at(-1)?.message).toContain("reloaded project state could not be verified")
    expect(fake.toasts.at(-1)?.message).toContain("TUI or full-server restart")

    const second = invoke(controller, fake)
    await flush()
    fake.emitDisposed()
    await second
    expect(endpointCalls(fake, "dispose")).toHaveLength(2)
    expect(fake.toasts.at(-1)?.variant).toBe("success")
  })

  test.each(["path", "session"] as const)("bounds a never-settling recovery %s probe", async (endpoint) => {
    const probeStarted = deferred<void>()
    const responses: Partial<Record<Endpoint, PlannedResponse[]>> = endpoint === "path"
      ? { path: [ok(pathData()), ok(pathData()), () => { probeStarted.resolve(); return new Promise(() => {}) }] }
      : { session: [() => { probeStarted.resolve(); return new Promise(() => {}) }] }
    const fake = host({ responses, onDispose: () => ok(true) })
    const { clock, controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await flush()
    fake.emitDisposed()
    await probeStarted.promise
    clock.advance(100)
    await pending

    expect(endpointCalls(fake, "dispose")).toHaveLength(1)
    expect(fake.toasts.at(-1)?.message).toContain("reloaded project state could not be verified")
    expect(fake.listenerCount()).toBe(0)
    expect(clock.pending()).toBe(0)
  })
})

describe("lifecycle cancellation and reactivation", () => {
  test("cancellation before disposal guarantees zero mutation, suppresses feedback, and releases the guard", async () => {
    const fake = host({ abortOnToast: true })
    const { controller } = lifecycleController()

    await invoke(controller, fake)

    expect(endpointCalls(fake, "dispose")).toHaveLength(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)

    const active = host({ onDispose: () => ok(true) })
    const activePending = invoke(controller, active)
    await flush()
    active.emitDisposed()
    await activePending
    expect(endpointCalls(active, "dispose")).toHaveLength(1)
  })

  test("cancellation after dispatch suppresses late UI and keeps the unknown guard across reactivation", async () => {
    const response = deferred<unknown>()
    const disposeStarted = deferred<void>()
    const fake = host({
      onDispose() {
        disposeStarted.resolve()
        return response.promise
      },
    })
    const { controller } = lifecycleController()

    const pending = invoke(controller, fake)
    await disposeStarted.promise
    fake.abort()
    fake.emitDisposed()
    response.reject(new Error("late-private"))
    await pending

    expect(fake.toasts).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)

    const reactivated = host()
    await invoke(controller, reactivated)
    expect(endpointCalls(reactivated, "dispose")).toHaveLength(0)
    expect(reactivated.toasts.at(-1)?.message).toContain("outcome is uncertain")
  })

  test("host-fatal lifecycle abort after the event produces no completion toast or unhandled controller rejection", async () => {
    const fake = host({ onDispose: () => ok(true) })
    const pending = invoke(lifecycleController().controller, fake)
    await flush()
    fake.emitDisposed()
    fake.abort()

    await expect(pending).resolves.toBeUndefined()

    expect(fake.toasts).toHaveLength(1)
    expect(endpointCalls(fake, "path")).toHaveLength(2)
    expect(fake.listenerCount()).toBe(0)
  })
})
