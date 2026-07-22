import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { isSupportedOpenCodeVersion } from "./version"

export type ReloadInvocation = {
  api: TuiPluginApi
  target: {
    sessionID: string
    directory: string
  }
}

export type ReloadController = (invocation: ReloadInvocation) => void | Promise<void>

type Clock = {
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (handle: unknown) => void
}

type LifecycleTiming = {
  clock: Clock
  recoveryRetryMs: number
  recoveryTimeoutMs: number
  requestTimeoutMs: number
}

export type PreflightClearContext = ReloadInvocation & {
  directory: string
  markOutcomeUnknown: () => void
}

export type ReloadControllerOptions = {
  clock?: Clock
  recoveryRetryMs?: number
  recoveryTimeoutMs?: number
  requestTimeoutMs?: number
  onPreflightClear?: (context: PreflightClearContext) => void | Promise<void>
}

type RefusalCategory =
  | "active"
  | "already-running"
  | "directory-changed"
  | "instance-changed"
  | "path"
  | "permission"
  | "question"
  | "request"
  | "route"
  | "unknown"
  | "version"
  | "workspace"

const messages: Record<RefusalCategory, string> = {
  active: "Reload refused because active work was detected.",
  "already-running": "Project reload is already in progress.",
  "directory-changed": "Reload refused because the server directory changed during preflight.",
  "instance-changed": "Reload refused because the project instance changed during preflight.",
  path: "Reload refused because the server directory could not be verified.",
  permission: "Reload refused because a permission request is pending.",
  question: "Reload refused because a question is pending.",
  request: "Reload refused because a preflight request was unavailable.",
  route: "Reload refused because the selected session route changed.",
  unknown: "Project reload outcome is uncertain and project state was not verified. Restart the TUI before retrying; a full-server restart may still be needed.",
  version: "Reload refused because the connected OpenCode server version is unsupported.",
  workspace: "Reload refused because the selected session uses a workspace.",
}

class Refusal extends Error {
  constructor(readonly category: RefusalCategory) {
    super(category)
  }
}

class LifecycleCancelled extends Error {}
class OutcomeUnknown extends Error {}
class RecoveryDeadline extends Error {}

const defaultClock: Clock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function refuse(api: TuiPluginApi, category: RefusalCategory) {
  if (api.lifecycle.signal.aborted) return
  try {
    api.ui.toast({
      variant: "error",
      title: "Project reload",
      message: messages[category],
    })
  } catch {
    // Host UI teardown must not turn a contained refusal into an unhandled error.
  }
}

function feedback(
  api: TuiPluginApi,
  variant: "error" | "info" | "success",
  message: string,
) {
  if (api.lifecycle.signal.aborted) return
  try {
    api.ui.toast({ variant, title: "Project reload", message })
  } catch {
    // The host may tear down its UI immediately after instance disposal.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasDotSegment(path: string, start: number) {
  return path.slice(start).split("/").some((segment) => segment === "." || segment === "..")
}

function trimTrailingSeparators(path: string, minimumLength: number) {
  let end = path.length
  while (end > minimumLength && path[end - 1] === "/") end -= 1
  return path.slice(0, end)
}

function normalizeServerPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined

  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const normalized = `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("\\", "/")}`
    if (hasDotSegment(normalized, 3)) return undefined
    return trimTrailingSeparators(normalized, 3)
  }

  if (/^[\\/]{2}/.test(value)) {
    const normalized = value.replaceAll("\\", "/")
    const match = /^\/\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(normalized)
    if (!match || hasDotSegment(normalized, 2)) return undefined
    const rootLength = 2 + match[1]!.length + 1 + match[2]!.length
    return trimTrailingSeparators(normalized, rootLength)
  }

  if (!value.startsWith("/") || hasDotSegment(value, 1)) return undefined
  return trimTrailingSeparators(value, 1)
}

function readData(response: unknown): unknown {
  if (!isPlainObject(response) || !Object.hasOwn(response, "data")) {
    throw new Refusal("request")
  }
  if (response.error !== undefined) throw new Refusal("request")
  return response.data
}

function validateRoute(invocation: ReloadInvocation, targetDirectory: string) {
  const route = invocation.api.route.current
  const sessionID = route.name === "session" ? route.params?.sessionID : undefined
  if (sessionID !== invocation.target.sessionID) throw new Refusal("route")

  const selected = invocation.api.state.session.get(invocation.target.sessionID) as unknown
  if (!isPlainObject(selected)
    || !Object.hasOwn(selected, "id")
    || !Object.hasOwn(selected, "directory")
    || selected.id !== invocation.target.sessionID) throw new Refusal("route")
  if (selected.workspaceID !== undefined) throw new Refusal("workspace")
  if (normalizeServerPath(selected.directory) !== targetDirectory) throw new Refusal("route")
}

async function boundedRequest<T>(
  api: TuiPluginApi,
  clock: Clock,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
  external?: { signal: AbortSignal; error: () => Error },
  onStarted?: () => void,
): Promise<T> {
  const controller = new AbortController()
  let timeoutHandle: unknown
  let rejectCancellation!: (reason: Error) => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancel = (reason: Error) => {
    controller.abort()
    rejectCancellation(reason)
  }
  const lifecycleSignal = api.lifecycle.signal
  const cancelLifecycle = () => cancel(new LifecycleCancelled())
  const cancelExternal = () => cancel(external!.error())
  const cancelTimeout = () => cancel(new Refusal("request"))
  if (lifecycleSignal.aborted) throw new LifecycleCancelled()
  if (external?.signal.aborted) throw external.error()
  lifecycleSignal.addEventListener("abort", cancelLifecycle, { once: true })
  external?.signal.addEventListener("abort", cancelExternal, { once: true })
  timeoutHandle = clock.setTimeout(cancelTimeout, timeoutMs)

  let pending: Promise<T>
  try {
    pending = Promise.resolve(request(controller.signal))
    onStarted?.()
  } catch (error) {
    pending = Promise.reject(error)
  }

  try {
    return await Promise.race([pending, cancellation])
  } finally {
    clock.clearTimeout(timeoutHandle)
    lifecycleSignal.removeEventListener("abort", cancelLifecycle)
    external?.signal.removeEventListener("abort", cancelExternal)
  }
}

async function waitForEvent(
  api: TuiPluginApi,
  clock: Clock,
  timeoutMs: number,
  event: Promise<void>,
) {
  let timeoutHandle: unknown
  let rejectWait!: (reason: Error) => void
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectWait = reject
  })
  const signal = api.lifecycle.signal
  const cancel = () => rejectWait(new LifecycleCancelled())
  if (signal.aborted) throw new LifecycleCancelled()
  signal.addEventListener("abort", cancel, { once: true })
  timeoutHandle = clock.setTimeout(() => rejectWait(new OutcomeUnknown()), timeoutMs)
  try {
    await Promise.race([event, interruption])
  } finally {
    clock.clearTimeout(timeoutHandle)
    signal.removeEventListener("abort", cancel)
  }
}

async function waitForRetry(
  api: TuiPluginApi,
  clock: Clock,
  delay: number,
  recoverySignal: AbortSignal,
) {
  let timer: unknown
  let resolveWait!: () => void
  let rejectWait!: (reason: Error) => void
  const pending = new Promise<void>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  const lifecycleSignal = api.lifecycle.signal
  const cancelLifecycle = () => rejectWait(new LifecycleCancelled())
  const cancelRecovery = () => rejectWait(new RecoveryDeadline())
  if (lifecycleSignal.aborted) throw new LifecycleCancelled()
  if (recoverySignal.aborted) throw new RecoveryDeadline()
  lifecycleSignal.addEventListener("abort", cancelLifecycle, { once: true })
  recoverySignal.addEventListener("abort", cancelRecovery, { once: true })
  timer = clock.setTimeout(resolveWait, delay)
  try {
    await pending
  } finally {
    clock.clearTimeout(timer)
    lifecycleSignal.removeEventListener("abort", cancelLifecycle)
    recoverySignal.removeEventListener("abort", cancelRecovery)
  }
}

function recoveredPath(data: unknown, directory: string) {
  const path = readServerPath(data)
  return path?.directory === directory && path.home !== directory
}

function readServerPath(data: unknown) {
  if (!isPlainObject(data)
    || !Object.hasOwn(data, "home")
    || !Object.hasOwn(data, "state")
    || !Object.hasOwn(data, "config")
    || !Object.hasOwn(data, "worktree")
    || !Object.hasOwn(data, "directory")
    || typeof data.state !== "string"
    || typeof data.config !== "string"
    || typeof data.worktree !== "string") return
  const home = normalizeServerPath(data.home)
  const directory = normalizeServerPath(data.directory)
  if (!home || !directory) return
  return { directory, home }
}

function recoveredSession(data: unknown, sessionID: string, directory: string) {
  return isPlainObject(data)
    && Object.hasOwn(data, "id")
    && Object.hasOwn(data, "directory")
    && data.id === sessionID
    && data.workspaceID === undefined
    && normalizeServerPath(data.directory) === directory
}

async function recover(
  invocation: ReloadInvocation,
  directory: string,
  timing: LifecycleTiming,
) {
  const { clock, recoveryRetryMs, recoveryTimeoutMs, requestTimeoutMs } = timing
  const deadline = new AbortController()
  const deadlineTimer = clock.setTimeout(() => deadline.abort(), recoveryTimeoutMs)
  const external = { signal: deadline.signal, error: () => new RecoveryDeadline() }
  try {
    while (true) {
      try {
        const pathResponse = await boundedRequest(
          invocation.api,
          clock,
          requestTimeoutMs,
          (signal) => invocation.api.client.path.get(
            { directory },
            { signal, throwOnError: false },
          ),
          external,
        )
        if (!recoveredPath(readData(pathResponse), directory)) throw new Refusal("request")

        const sessionResponse = await boundedRequest(
          invocation.api,
          clock,
          requestTimeoutMs,
          (signal) => invocation.api.client.session.get(
            { sessionID: invocation.target.sessionID, directory },
            { signal, throwOnError: false },
          ),
          external,
        )
        if (!recoveredSession(readData(sessionResponse), invocation.target.sessionID, directory)) {
          throw new Refusal("request")
        }
        return true
      } catch (error) {
        if (error instanceof LifecycleCancelled) throw error
        if (error instanceof RecoveryDeadline) return false
        try {
          await waitForRetry(invocation.api, clock, recoveryRetryMs, deadline.signal)
        } catch (waitError) {
          if (waitError instanceof LifecycleCancelled) throw waitError
          if (waitError instanceof RecoveryDeadline) return false
          throw waitError
        }
      }
    }
  } finally {
    clock.clearTimeout(deadlineTimer)
  }
}

async function runDefaultLifecycle(
  invocation: ReloadInvocation,
  directory: string,
  disposalEvent: Promise<void>,
  timing: LifecycleTiming,
  markOutcomeUnknown: () => void,
  markResponseAccepted: () => void,
) {
  const { clock, requestTimeoutMs } = timing
  let disposalResponse: unknown
  let dispatched = false
  try {
    disposalResponse = await boundedRequest(
      invocation.api,
      clock,
      requestTimeoutMs,
      (signal) => invocation.api.client.instance.dispose(
        { directory },
        { signal, throwOnError: false },
      ),
      undefined,
      () => {
        dispatched = true
        markOutcomeUnknown()
      },
    )
  } catch {
    if (!dispatched) throw new Refusal("request")
    throw new OutcomeUnknown()
  }

  let disposalAccepted: unknown
  try {
    disposalAccepted = readData(disposalResponse)
  } catch {
    throw new OutcomeUnknown()
  }
  if (disposalAccepted !== true) {
    throw new OutcomeUnknown()
  }
  markResponseAccepted()

  try {
    await waitForEvent(invocation.api, clock, requestTimeoutMs, disposalEvent)
  } catch {
    throw new OutcomeUnknown()
  }

  return recover(
    invocation,
    directory,
    timing,
  )
}

export function createReloadController(options: ReloadControllerOptions = {}): ReloadController {
  const clock = options.clock ?? defaultClock
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000
  const recoveryTimeoutMs = Math.max(Math.min(options.recoveryTimeoutMs ?? 10_000, 10_000), 1)
  const recoveryRetryMs = Math.max(options.recoveryRetryMs ?? 250, 1)
  const timing = { clock, recoveryRetryMs, recoveryTimeoutMs, requestTimeoutMs }
  const onPreflightClear = options.onPreflightClear
  let state: "idle" | "running" | "unknown" = "idle"
  let inFlight: Promise<void> | undefined
  const currentState = () => state

  return async (invocation) => {
    if (state !== "idle") {
      refuse(invocation.api, inFlight ? "already-running" : "unknown")
      return
    }

    state = "running"
    const operation = (async () => {
      const initialDirectory = normalizeServerPath(invocation.target.directory)
      if (!initialDirectory) throw new Refusal("path")

      let authoritativeDirectory = initialDirectory
      let disposalObserved = false
      let actionStarted = false
      let responseAccepted = false
      let eventBeforeResponse = false
      let resolveDisposalEvent!: () => void
      const disposalEvent = new Promise<void>((resolve) => {
        resolveDisposalEvent = resolve
      })
      const unsubscribe = invocation.api.event.on("server.instance.disposed", (event) => {
        try {
          if (!isPlainObject(event.properties)
            || !Object.hasOwn(event.properties, "directory")
            || normalizeServerPath(event.properties.directory) !== authoritativeDirectory) return
          if (!actionStarted) {
            disposalObserved = true
            return
          }
          if (!responseAccepted) {
            eventBeforeResponse = true
            return
          }
          resolveDisposalEvent()
        } catch {
          // Malformed unrelated events are not evidence about the selected instance.
        }
      })

      const assertStable = () => {
        if (disposalObserved) throw new Refusal("instance-changed")
        validateRoute(invocation, initialDirectory)
      }
      const request = async <T>(call: (signal: AbortSignal) => Promise<T>) => {
        assertStable()
        const result = await boundedRequest(invocation.api, clock, requestTimeoutMs, call)
        assertStable()
        return result
      }

      try {
        for (let round = 0; round < 2; round += 1) {
          const healthResponse = await request((signal) => invocation.api.client.global.health({
            signal,
            throwOnError: false,
          }))
          const health = readData(healthResponse)
          if (!isPlainObject(health)
            || !Object.hasOwn(health, "healthy")
            || !Object.hasOwn(health, "version")
            || health.healthy !== true
            || !isSupportedOpenCodeVersion(health.version)) {
            throw new Refusal("version")
          }

          const pathResponse = await request((signal) => invocation.api.client.path.get(
            { directory: authoritativeDirectory },
            { signal, throwOnError: false },
          ))
          const path = readServerPath(readData(pathResponse))
          if (!path || path.directory === path.home) throw new Refusal("path")
          if (path.directory !== authoritativeDirectory) {
            throw new Refusal(round === 0 ? "path" : "directory-changed")
          }
          authoritativeDirectory = path.directory

          const statusResponse = await request((signal) => invocation.api.client.session.status(
            { directory: authoritativeDirectory },
            { signal, throwOnError: false },
          ))
          const status = readData(statusResponse)
          if (!isPlainObject(status)) throw new Refusal("request")
          if (Reflect.ownKeys(status).length > 0) throw new Refusal("active")

          const permissionResponse = await request((signal) => invocation.api.client.permission.list(
            { directory: authoritativeDirectory },
            { signal, throwOnError: false },
          ))
          const permissions = readData(permissionResponse)
          if (!Array.isArray(permissions)) throw new Refusal("request")
          if (permissions.length > 0) throw new Refusal("permission")

          const questionResponse = await request((signal) => invocation.api.client.question.list(
            { directory: authoritativeDirectory },
            { signal, throwOnError: false },
          ))
          const questions = readData(questionResponse)
          if (!Array.isArray(questions)) throw new Refusal("request")
          if (questions.length > 0) throw new Refusal("question")
        }

        assertStable()
        if (onPreflightClear) {
          actionStarted = true
          await onPreflightClear({
            ...invocation,
            directory: authoritativeDirectory,
            markOutcomeUnknown: () => {
              state = "unknown"
            },
          })
        } else {
          if (invocation.api.lifecycle.signal.aborted) throw new LifecycleCancelled()
          feedback(
            invocation.api,
            "info",
            "Reloading project state. The final preflight is best effort and cannot prevent new work from starting concurrently.",
          )
          if (invocation.api.lifecycle.signal.aborted) throw new LifecycleCancelled()
          assertStable()
          actionStarted = true
          const recovered = await runDefaultLifecycle(
            invocation,
            authoritativeDirectory,
            disposalEvent,
            timing,
            () => {
              state = "unknown"
            },
            () => {
              if (eventBeforeResponse) throw new OutcomeUnknown()
              responseAccepted = true
            },
          )
          state = "running"
          if (recovered) {
            feedback(
              invocation.api,
              "success",
              "Project state was reloaded and the selected session is available. A TUI or full-server restart may still be needed for TUI, global, or process-cached module changes.",
            )
          } else {
            feedback(
              invocation.api,
              "error",
              "Instance disposal completed, but reloaded project state could not be verified. A TUI or full-server restart may still be needed for TUI, global, or process-cached module changes.",
            )
          }
        }
      } finally {
        unsubscribe()
      }
    })()

    inFlight = operation
    try {
      await operation
    } catch (error) {
      if (currentState() === "unknown") refuse(invocation.api, "unknown")
      else if (!(error instanceof LifecycleCancelled)) {
        refuse(invocation.api, error instanceof Refusal ? error.category : "request")
      }
    } finally {
      if (inFlight === operation) inFlight = undefined
      if (state === "running") state = "idle"
    }
  }
}

export const reloadProject = createReloadController()
