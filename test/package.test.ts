import { describe, expect, test } from "bun:test"
import { SUPPORTED_OPENCODE_VERSIONS } from "../src/version"
import { parseCompatibilityVersion } from "./compat"

const root = new URL("..", import.meta.url)

describe("release package", () => {
  test("packs only the current runtime artifact, metadata, README, and license", async () => {
    const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
      cwd: root.pathname,
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const report = JSON.parse(result.stdout.toString()) as Array<{ files: Array<{ path: string }> }>
    expect(report).toHaveLength(1)
    expect(report[0]!.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist/tui.js",
      "package.json",
    ])

    const artifact = await Bun.file(new URL("../dist/tui.js", import.meta.url)).arrayBuffer()
    const digest = new Bun.CryptoHasher("sha256").update(artifact).digest("hex")
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
    expect(readme).toContain(`${digest}  dist/tui.js`)
  })

  test("declares exact tooling and rejects compatibility versions outside the matrix", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(manifest.engines.opencode).toBe(">=1.18.3 <=1.18.4")
    expect(SUPPORTED_OPENCODE_VERSIONS).toEqual(["1.18.3", "1.18.4"])
    expect(Object.values(manifest.devDependencies).every((value) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value)))).toBe(true)
    expect(parseCompatibilityVersion(["1.18.3"])).toBe("1.18.3")
    expect(parseCompatibilityVersion(["1.18.4"])).toBe("1.18.4")
    expect(() => parseCompatibilityVersion(["1.18.2"])).toThrow()
    expect(() => parseCompatibilityVersion(["1.18.5"])).toThrow()
    expect(() => parseCompatibilityVersion([])).toThrow()
    expect(() => parseCompatibilityVersion(["1.18.3", "1.18.4"])).toThrow()
  })
})
