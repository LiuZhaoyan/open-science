import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import { explicitLockArgv, normalizeExplicitLock } from './micromamba'
import { envPrefix } from './runtime-paths'

// One app-managed conda environment the main process resolved from its own trusted state
// (discovery or relocation). `prefix` is always derived from the runtime root — never accepted
// from the renderer.
export type ManagedEnvironment = {
  name: string
  prefix: string
}

// Resolves a discovered interpreter to the managed env it lives in, or undefined when the user
// owns it or its conda env name is missing — never guess a default env for an interpreter we
// cannot place. 'app-managed' and 'agent-created' envs both sit under the app runtime root and
// are exported through the bundled micromamba; user-own interpreters (including a foreign conda
// install) stay out of scope — their packages are managed manually.
export const managedEnvironmentRef = (
  interpreter: DiscoveredInterpreter,
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform
): ManagedEnvironment | undefined => {
  if (interpreter.provenance === 'user-own' || !interpreter.condaEnv) return undefined
  const name = interpreter.condaEnv
  return { name, prefix: envPrefix(runtimeRoot, name, platform) }
}

export type ExportEnvironmentLockDeps = {
  // Resolved micromamba binary.
  mm: string
  // Runs a micromamba argv and returns stdout (for `list --explicit --md5`).
  capture: (argv: string[]) => Promise<string>
}

// Exports one managed environment prefix as a validated @EXPLICIT lock: capture, normalize,
// then require at least one package URL to survive — an empty lock is a failure, never a
// success. The @EXPLICIT marker itself is normalizeExplicitLock's contract, not re-checked here.
export const exportEnvironmentLock = async (
  env: ManagedEnvironment,
  deps: ExportEnvironmentLockDeps
): Promise<string> => {
  const raw = await deps.capture(explicitLockArgv(deps.mm, env.prefix))
  const lock = normalizeExplicitLock(raw)
  if (!/^https?:\/\//m.test(lock)) {
    throw new Error(`Could not export ${env.name}: the exported lock contains no package URLs.`)
  }
  return lock
}
