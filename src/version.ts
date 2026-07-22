export const SUPPORTED_OPENCODE_VERSIONS = ["1.18.3", "1.18.4"] as const

export function isSupportedOpenCodeVersion(value: unknown): value is (typeof SUPPORTED_OPENCODE_VERSIONS)[number] {
  return typeof value === "string" && SUPPORTED_OPENCODE_VERSIONS.some((version) => version === value)
}
