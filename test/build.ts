import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const workspace = resolve(import.meta.dir, "..")

async function tempRoot() {
  const preferred = "/tmp/opencode-mkchad/opencode-project-reload-u4"
  await mkdir(preferred, { recursive: true })
  return preferred
}

const root = await mkdtemp(join(await tempRoot(), "build-"))
try {
  const output = join(root, "tui.js")
  const build = Bun.spawn([
    process.execPath,
    "build",
    "src/tui.ts",
    "--target=bun",
    "--format=esm",
    `--outfile=${output}`,
  ], {
    cwd: workspace,
    stderr: "inherit",
    stdout: "inherit",
  })
  const timeout = setTimeout(() => build.kill("SIGKILL"), 30_000)
  const exitCode = await build.exited.finally(() => clearTimeout(timeout))
  if (exitCode !== 0) throw new Error(`build failed with exit code ${exitCode}`)

  const [expected, actual] = await Promise.all([
    readFile(join(workspace, "dist", "tui.js")),
    readFile(output),
  ])
  if (!expected.equals(actual)) {
    throw new Error("dist/tui.js is not reproducible; run bun run build")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
