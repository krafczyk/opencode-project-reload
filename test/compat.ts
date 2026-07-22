import { isSupportedOpenCodeVersion } from "../src/version"

export function parseCompatibilityVersion(args: string[]) {
  if (args.length !== 1 || !isSupportedOpenCodeVersion(args[0])) {
    throw new Error("compatibility version must be exactly 1.18.3 or 1.18.4")
  }
  return args[0]!
}

async function run(command: string[], timeoutMs: number, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    env,
    stderr: "inherit",
    stdout: "inherit",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  const exitCode = await child.exited.finally(() => clearTimeout(timeout))
  if (timedOut) {
    console.error(`${command.join(" ")} timed out after ${timeoutMs}ms`)
    return 124
  }
  return exitCode
}

if (import.meta.main) {
  let version: string
  try {
    version = parseCompatibilityVersion(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }

  const buildExit = await run([
    process.execPath,
    "run",
    "test/build.ts",
  ], 45_000)
  if (buildExit !== 0) process.exit(buildExit)

  const testExit = await run([
    process.execPath,
    "test",
    "test/integration/opencode.test.ts",
    "--timeout",
    "120000",
  ], 130_000, { ...process.env, OPENCODE_COMPAT_VERSION: version })
  process.exit(testExit)
}
