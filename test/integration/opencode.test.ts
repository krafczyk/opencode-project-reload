import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { isSupportedOpenCodeVersion } from "../../src/version"
import { startProviderCapture, type ProviderFixture } from "../fixtures/provider"

type Client = TuiPluginApi["client"]
type CreateClient = (config: {
  baseUrl: string
  fetch: typeof fetch
  headers: Record<string, string>
}) => Client
type GlobalEvent = {
  payload: {
    properties: Record<string, unknown>
    type: string
  }
}
type Command = { name: string; run: () => Promise<void> | void; slashName?: string }
type PackedModule = {
  default: { id: string; tui: (api: TuiPluginApi, options?: undefined, meta?: unknown) => Promise<void> }
}

const version = process.env.OPENCODE_COMPAT_VERSION
if (!isSupportedOpenCodeVersion(version)) {
  throw new Error("OPENCODE_COMPAT_VERSION must be exactly 1.18.3 or 1.18.4")
}

const workspace = resolve(import.meta.dir, "../..")

async function taskTempRoot() {
  const preferred = "/tmp/opencode-mkchad/opencode-project-reload-u4"
  await mkdir(preferred, { recursive: true })
  return preferred
}

async function bounded<T>(label: string, promise: Promise<T>, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stderr: "pipe", stdout: "pipe" })
  let result: [number, string, string]
  try {
    result = await bounded(
      command.join(" "),
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      60_000,
    )
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    throw error
  }
  const [exitCode, stdout, stderr] = result
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr || stdout}`)
  return stdout
}

async function packAndInstall(root: string) {
  const archive = join(root, "archive")
  const install = join(root, "install")
  await mkdir(archive, { recursive: true })
  await mkdir(install, { recursive: true })
  const npmCache = join(root, "npm-cache")
  const npmConfig = join(root, "empty-npmrc")
  const npmHome = join(root, "npm-home")
  await Promise.all([mkdir(npmCache, { recursive: true }), mkdir(npmHome, { recursive: true })])
  await writeFile(npmConfig, "")
  const packageEnv = {
    HOME: npmHome,
    LANG: "C.UTF-8",
    NO_UPDATE_NOTIFIER: "1",
    PATH: process.env.PATH,
    npm_config_cache: npmCache,
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_userconfig: npmConfig,
  }
  const packed = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", archive, "."], workspace, packageEnv)) as Array<{
    filename: string
    files: Array<{ path: string }>
  }>
  expect(packed).toHaveLength(1)
  expect(packed[0]!.files.map((file) => file.path).sort()).toEqual([
    "LICENSE",
    "README.md",
    "dist/tui.js",
    "package.json",
  ])

  await writeFile(join(install, "package.json"), JSON.stringify({ name: "compat-host", private: true, type: "module" }))
  await run([
    "npm",
    "install",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    `opencode-ai@${version}`,
    `@opencode-ai/sdk@${version}`,
  ], install, packageEnv)
  const pluginArchive = join(archive, packed[0]!.filename)
  await run([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    pluginArchive,
  ], install, packageEnv)

  const pluginRoot = join(install, "node_modules", "opencode-project-reload")
  const manifest = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")) as {
    engines: { opencode: string }
    exports: { "./tui": string }
    name: string
    version: string
  }
  expect(manifest).toMatchObject({
    engines: { opencode: ">=1.18.3 <=1.18.4" },
    exports: { "./tui": "./dist/tui.js" },
    name: "opencode-project-reload",
    version: "0.1.0",
  })
  expect(await readFile(join(pluginRoot, manifest.exports["./tui"]), "utf8")).toContain("opencode-project-reload")

  const load = await run([
    process.execPath,
    "--eval",
    "const p = await import('opencode-project-reload/tui'); console.log(JSON.stringify({id:p.default.id,tui:typeof p.default.tui}))",
  ], install, packageEnv)
  expect(JSON.parse(load.trim())).toEqual({ id: "opencode-project-reload", tui: "function" })

  const binaryManifest = JSON.parse(await readFile(join(install, "node_modules", "opencode-ai", "package.json"), "utf8"))
  const sdkManifest = JSON.parse(await readFile(join(install, "node_modules", "@opencode-ai", "sdk", "package.json"), "utf8"))
  expect(binaryManifest.version).toBe(version)
  expect(sdkManifest.version).toBe(version)
  return {
    binary: join(install, "node_modules", ".bin", "opencode"),
    clientModule: join(install, "node_modules", "@opencode-ai", "sdk", "dist", "v2", "client.js"),
    pluginModule: join(pluginRoot, manifest.exports["./tui"]),
  }
}

async function writeProject(project: string, provider: ProviderFixture, phase: "before" | "after") {
  const configDir = join(project, ".opencode")
  await mkdir(join(configDir, "agents"), { recursive: true })
  await mkdir(join(configDir, "commands"), { recursive: true })
  await mkdir(join(configDir, "skills", `${phase}-skill`), { recursive: true })
  const marker = join(project, "plugin-initialized")
  const plugin = join(project, "server-plugin.ts")
  if (phase === "before") {
    await writeFile(plugin, [
      `const marker = ${JSON.stringify(marker)}`,
      "export default async () => {",
      "  const previous = await Bun.file(marker).text().catch(() => '')",
      "  await Bun.write(marker, previous + 'initialized\\n')",
      "  return {}",
      "}",
      "",
    ].join("\n"))
  } else {
    await Promise.all([
      rm(join(configDir, "agents", "before-agent.md"), { force: true }),
      rm(join(configDir, "commands", "before-command.md"), { force: true }),
      rm(join(configDir, "skills", "before-skill"), { recursive: true, force: true }),
    ])
  }

  await writeFile(join(project, "AGENTS.md"), `root-instruction-${phase}\n`)
  await writeFile(join(project, `${phase}-extra.md`), `configured-instruction-${phase}\n`)
  await writeFile(join(configDir, "agents", `${phase}-agent.md`), `---\ndescription: ${phase} agent\nmode: subagent\n---\n${phase}\n`)
  await writeFile(join(configDir, "commands", `${phase}-command.md`), `${phase} command\n`)
  await writeFile(join(configDir, "skills", `${phase}-skill`, "SKILL.md"), `---\nname: ${phase}-skill\ndescription: ${phase} skill\n---\n${phase}\n`)
  await writeFile(join(project, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    instructions: [`${phase}-extra.md`],
    plugin: [pathToFileURL(plugin).href],
    provider: {
      capture: {
        name: "Compatibility capture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          model: {
            name: "Capture model",
            tool_call: true,
            limit: { context: 32_000, output: 1_024 },
          },
        },
        options: { apiKey: "local-fixture", baseURL: provider.url },
      },
    },
  }))
}

function data<T>(response: { data?: T; error?: unknown }, label: string): T {
  if (response.error !== undefined || response.data === undefined) {
    throw new Error(`${label} failed`)
  }
  return response.data
}

function names(items: unknown[], field: "name" | "id") {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const value = (item as Record<string, unknown>)[field]
    return typeof value === "string" ? [value] : []
  })
}

async function startServer(binary: string, root: string, password: string) {
  const isolated = {
    HOME: join(root, "home"),
    LANG: "C.UTF-8",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "compat-user",
    OPENCODE_TEST_HOME: join(root, "home"),
    PATH: process.env.PATH,
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  }
  await Promise.all([
    isolated.HOME,
    isolated.TMPDIR,
    isolated.XDG_CACHE_HOME,
    isolated.XDG_CONFIG_HOME,
    isolated.XDG_DATA_HOME,
    isolated.XDG_STATE_HOME,
  ].map((directory) => mkdir(directory, { recursive: true })))
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  })
  const port = reservation.port
  await reservation.stop(true)
  const url = `http://127.0.0.1:${port}`
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: isolated,
    stderr: "pipe",
    stdout: "pipe",
  })
  async function drain(stream: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      while (!(await stream.read()).done) {}
    } catch {
      // Process shutdown can close a pipe while a read is pending.
    }
  }
  void drain(child.stdout.getReader())
  void drain(child.stderr.getReader())
  try {
    const authorization = `Basic ${btoa(`compat-user:${password}`)}`
    await bounded("OpenCode server startup", (async () => {
      while (child.exitCode === null) {
        const response = await fetch(`${url}/global/health`, {
          headers: { authorization },
          signal: AbortSignal.timeout(1_000),
        }).catch(() => undefined)
        if (response?.ok) return
        await Bun.sleep(25)
      }
      throw new Error("OpenCode server exited before becoming healthy")
    })(), 20_000)
    return { child, url }
  } catch (error) {
    await stopServer(child)
    throw error
  }
}

async function stopServer(child: {
  exitCode: number | null
  exited: Promise<number>
  kill: (signal?: number | NodeJS.Signals) => void
}) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  try {
    await bounded("OpenCode server shutdown", child.exited, 5_000)
  } catch {
    child.kill("SIGKILL")
    await child.exited
  }
}

function eventBridge(client: Client) {
  const controller = new AbortController()
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const seen: GlobalEvent[] = []
  let connectedResolve!: () => void
  let connectedReject!: (error: unknown) => void
  const connected = new Promise<void>((resolve, reject) => {
    connectedResolve = resolve
    connectedReject = reject
  })
  let streamError: unknown
  const running = (async () => {
    const result = await client.global.event({ signal: controller.signal })
    for await (const event of result.stream as AsyncGenerator<GlobalEvent>) {
      seen.push(event)
      const payload = event.payload
      if (payload.type === "server.connected") connectedResolve()
      for (const listener of listeners.get(payload.type) ?? []) listener(payload)
    }
  })().catch((error) => {
    if (controller.signal.aborted) return
    streamError = error
    connectedReject(error)
  })
  return {
    connected,
    event: {
      on(type: string, listener: (event: unknown) => void) {
        const current = listeners.get(type) ?? new Set()
        current.add(listener)
        listeners.set(type, current)
        return () => current.delete(listener)
      },
    },
    seen,
    async stop() {
      controller.abort()
      await bounded("event stream shutdown", running, 5_000)
      if (streamError) throw streamError
    },
  }
}

async function deterministicLifecycleSeams(pluginModule: string, directory: string, session: { id: string }) {
  async function commandFor(scenario: string, client: Record<string, unknown>, hostVersion = version) {
    const packed = await import(`${pathToFileURL(pluginModule).href}?seam=${scenario}-${version}`) as PackedModule
    const commands: Command[] = []
    const toasts: Array<{ message: string; variant: string }> = []
    const api = {
      app: { version: hostVersion },
      client,
      event: { on: () => () => {} },
      keymap: {
        registerLayer(layer: { commands?: Command[] }) {
          commands.push(...(layer.commands ?? []))
          return () => {}
        },
      },
      lifecycle: { signal: new AbortController().signal },
      route: { current: { name: "session", params: { sessionID: session.id } } },
      state: {
        ready: true,
        session: { get: (sessionID: string) => sessionID === session.id ? { ...session, directory } : undefined },
      },
      ui: { toast: (toast: { message: string; variant: string }) => { toasts.push(toast) } },
    } as unknown as TuiPluginApi
    await packed.default.tui(api)
    return { command: commands[0]!, toasts }
  }

  const unsupported = await commandFor("unsupported-version", new Proxy({}, {
    get() {
      throw new Error("unsupported versions must not access lifecycle APIs")
    },
  }), "1.18.5")
  await unsupported.command.run()
  expect(unsupported.toasts.at(-1)?.message).toContain("requires OpenCode 1.18.3 or 1.18.4")

  let malformedDisposals = 0
  const malformed = await commandFor("malformed-preflight", {
    global: { health: async () => ({ data: { healthy: true, version } }) },
    path: { get: async () => ({ data: { home: resolve(directory, "..", ".."), state: "/state", config: "/config", worktree: directory, directory } }) },
    session: { status: async () => ({ data: [] }) },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    instance: { dispose: async () => { malformedDisposals += 1; return { data: true } } },
  })
  await malformed.command.run()
  expect(malformedDisposals).toBe(0)
  expect(malformed.toasts.at(-1)?.message).toContain("preflight request was unavailable")

  let ambiguousDisposals = 0
  const ambiguous = await commandFor("ambiguous-disposal", {
    global: { health: async () => ({ data: { healthy: true, version } }) },
    path: { get: async () => ({ data: { home: resolve(directory, "..", ".."), state: "/state", config: "/config", worktree: directory, directory } }) },
    session: {
      get: async () => ({ data: { ...session, directory } }),
      status: async () => ({ data: {} }),
    },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    instance: { dispose: async () => { ambiguousDisposals += 1; return { data: "ambiguous" } } },
  })
  await ambiguous.command.run()
  await ambiguous.command.run()
  expect(ambiguousDisposals).toBe(1)
  expect(ambiguous.toasts.at(-1)?.message).toContain("outcome is uncertain")
}

test(`packed lifecycle is compatible with real OpenCode ${version}`, async () => {
  const parent = await taskTempRoot()
  const root = await mkdtemp(join(parent, `compat-${version}-`))
  const provider = startProviderCapture()
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let events: ReturnType<typeof eventBridge> | undefined
  const lifecycle = new AbortController()
  try {
    const installed = await packAndInstall(root)
    const target = join(root, "projects", "target")
    const other = join(root, "projects", "other")
    await Promise.all([mkdir(target, { recursive: true }), mkdir(other, { recursive: true })])
    await writeProject(target, provider, "before")
    const password = `compat-${crypto.randomUUID()}`
    server = await startServer(installed.binary, root, password)

    const unauthenticated = await fetch(`${server.url}/global/health`, { signal: AbortSignal.timeout(10_000) })
    expect(unauthenticated.status).toBe(401)
    const authorization = `Basic ${btoa(`compat-user:${password}`)}`
    const requests: Array<{ authenticated: boolean; hostname: string; method: string; pathname: string }> = []
    const sdk = await import(pathToFileURL(installed.clientModule).href) as {
      createOpencodeClient: CreateClient
    }
    const client = sdk.createOpencodeClient({
      baseUrl: server.url,
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        requests.push({
          authenticated: request.headers.get("authorization") === authorization,
          hostname: url.hostname,
          method: request.method,
          pathname: url.pathname,
        })
        if (url.pathname === "/global/event") return fetch(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        return fetch(new Request(request, { signal }))
      }) as typeof fetch,
      headers: { authorization },
    })
    expect(data(await client.global.health(), "authenticated health").version).toBe(version)
    events = eventBridge(client)
    await bounded("global event connection", events.connected)

    const selected = data(await client.session.create({ directory: target, title: "persisted compatibility session" }), "create selected session")
    data(await client.session.prompt({
      directory: target,
      sessionID: selected.id,
      noReply: true,
      parts: [{ type: "text", text: "persisted-before-reload" }],
    }), "persist selected message")
    const otherSession = data(await client.session.create({ directory: other, title: "other directory session" }), "create other session")

    const beforeConfig = data(await client.config.get({ directory: target }), "before config") as { instructions?: string[] }
    const beforeAgents = data(await client.app.agents({ directory: target }), "before agents") as unknown[]
    const beforeSkills = data(await client.app.skills({ directory: target }), "before skills") as unknown[]
    const beforeCommands = data(await client.command.list({ directory: target }), "before commands") as unknown[]
    expect(beforeConfig.instructions).toContain("before-extra.md")
    expect(names(beforeAgents, "name")).toContain("before-agent")
    expect(names(beforeSkills, "name")).toContain("before-skill")
    expect(names(beforeCommands, "name")).toContain("before-command")
    expect((await readFile(join(target, "plugin-initialized"), "utf8")).trim().split("\n")).toHaveLength(1)

    await writeProject(target, provider, "after")
    const packed = await import(`${pathToFileURL(installed.pluginModule).href}?compat=${version}`) as PackedModule
    const commands: Command[] = []
    const toasts: Array<{ message: string; variant: string }> = []
    const api = {
      app: { version },
      client,
      event: events.event,
      keymap: {
        registerLayer(layer: { commands?: Command[] }) {
          commands.push(...(layer.commands ?? []))
          return () => {}
        },
      },
      lifecycle: { signal: lifecycle.signal },
      route: { current: { name: "session", params: { sessionID: selected.id } } },
      state: {
        ready: true,
        session: { get: (sessionID: string) => sessionID === selected.id ? selected : undefined },
      },
      ui: { toast: (toast: { message: string; variant: string }) => { toasts.push(toast) } },
    } as unknown as TuiPluginApi
    await packed.default.tui(api, undefined, {
      id: packed.default.id,
      source: "npm",
      spec: "opencode-project-reload@0.1.0",
      target: installed.pluginModule,
      state: "first",
    })
    expect(commands.map((command) => ({ name: command.name, slashName: command.slashName }))).toEqual([
      { name: "project.reload", slashName: "reload-project" },
    ])

    const providerCallsBeforeReload = provider.captures.length
    await bounded("production reload controller", Promise.resolve(commands[0]!.run()), 20_000)
    expect(provider.captures).toHaveLength(providerCallsBeforeReload)
    expect(toasts.map((toast) => toast.variant)).toEqual(["info", "success"])
    expect(toasts.at(-1)?.message).toContain("Project state was reloaded")

    const persisted = data(await client.session.get({ directory: target, sessionID: selected.id }), "persisted session")
    expect(persisted.id).toBe(selected.id)
    const messages = data(await client.session.messages({ directory: target, sessionID: selected.id }), "persisted messages")
    expect(JSON.stringify(messages)).toContain("persisted-before-reload")
    expect(data(await client.session.get({ directory: other, sessionID: otherSession.id }), "other session").id).toBe(otherSession.id)
    expect(data(await client.path.get({ directory: other }), "other path").directory).toBe(other)

    const afterConfig = data(await client.config.get({ directory: target }), "after config") as { instructions?: string[] }
    const afterAgents = data(await client.app.agents({ directory: target }), "after agents") as unknown[]
    const afterSkills = data(await client.app.skills({ directory: target }), "after skills") as unknown[]
    const afterCommands = data(await client.command.list({ directory: target }), "after commands") as unknown[]
    expect(afterConfig.instructions).toContain("after-extra.md")
    expect(afterConfig.instructions).not.toContain("before-extra.md")
    expect(names(afterAgents, "name")).toContain("after-agent")
    expect(names(afterAgents, "name")).not.toContain("before-agent")
    expect(names(afterSkills, "name")).toContain("after-skill")
    expect(names(afterSkills, "name")).not.toContain("before-skill")
    expect(names(afterCommands, "name")).toContain("after-command")
    expect(names(afterCommands, "name")).not.toContain("before-command")
    expect((await readFile(join(target, "plugin-initialized"), "utf8")).trim().split("\n")).toHaveLength(2)

    data(await client.session.prompt({
      directory: target,
      sessionID: selected.id,
      model: { providerID: "capture", modelID: "model" },
      parts: [{ type: "text", text: "capture current instructions" }],
    }), "provider capture prompt")
    expect(provider.captures).toHaveLength(providerCallsBeforeReload + 1)
    const providerBody = JSON.stringify(provider.captures.at(-1)!.body)
    expect(providerBody).toContain("root-instruction-after")
    expect(providerBody).toContain("configured-instruction-after")
    expect(providerBody).not.toContain("root-instruction-before")
    expect(providerBody).not.toContain("configured-instruction-before")
    expect(providerBody.indexOf("root-instruction-after")).toBeLessThan(providerBody.indexOf("configured-instruction-after"))

    const lifecycleRequests = requests.filter((request) => [
      "/global/health",
      "/instance/dispose",
      "/path",
      "/session/status",
      "/permission",
      "/question",
    ].includes(request.pathname))
    expect(lifecycleRequests.length).toBeGreaterThan(0)
    expect(lifecycleRequests.every((request) => request.authenticated)).toBe(true)
    expect(lifecycleRequests.filter((request) => request.pathname === "/instance/dispose")).toHaveLength(1)
    expect(lifecycleRequests.every((request) => request.hostname === "127.0.0.1")).toBe(true)
    expect(new Set(lifecycleRequests.map((request) => request.pathname))).toEqual(new Set([
      "/global/health",
      "/instance/dispose",
      "/path",
      "/permission",
      "/question",
      "/session/status",
    ]))
    const disposalEvents = events.seen.filter((event) => event.payload.type === "server.instance.disposed")
    expect(disposalEvents).toHaveLength(1)
    expect(disposalEvents[0]?.payload.properties.directory).toBe(target)

    // Unsafe malformed/ambiguous cases use a local seam and run last because the
    // packed controller intentionally keeps post-dispatch uncertainty process-wide.
    await deterministicLifecycleSeams(installed.pluginModule, target, selected)
  } finally {
    lifecycle.abort()
    const cleanup = await Promise.allSettled([
      events?.stop() ?? Promise.resolve(),
      server ? stopServer(server.child) : Promise.resolve(),
      provider.stop(),
    ])
    await rm(root, { recursive: true, force: true })
    const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw failed.reason
  }
})
