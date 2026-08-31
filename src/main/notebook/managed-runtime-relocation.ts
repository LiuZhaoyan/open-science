import { posix, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import { posixManagedRuntimeLocation } from './posix-runtime-binding'
import { envDirectoryName, resolveEnvName } from './runtime-paths'
import { windowsManagedRuntimeLocation, windowsRuntimePathKey } from './windows-runtime-binding'

export const relocatedManagedRuntimeId = ({
  fromDataRoot,
  toDataRoot,
  language,
  platform,
  runtimeId
}: {
  fromDataRoot: string
  toDataRoot: string
  language: NotebookLanguage
  platform: NodeJS.Platform
  runtimeId: string
}): string | undefined => {
  const path =
    platform === 'win32' ? win32 : platform === 'darwin' || platform === 'linux' ? posix : undefined
  if (!path) return undefined

  const location =
    platform === 'win32'
      ? windowsManagedRuntimeLocation({ language, platform, runtimeId })
      : posixManagedRuntimeLocation({ language, platform, runtimeId })
  if (!location) return undefined

  const expectedRuntimeRoot = path.join(fromDataRoot, 'runtime')
  const sameRuntimeRoot =
    platform === 'win32'
      ? windowsRuntimePathKey(location.runtimeRoot) === windowsRuntimePathKey(expectedRuntimeRoot)
      : path.normalize(location.runtimeRoot) === path.normalize(expectedRuntimeRoot)
  if (!sameRuntimeRoot) return undefined

  // Reject hidden/traversal/reserved aliases that the managed-environment API could never create.
  // The two Windows short directories have already been expanded to their logical default names.
  try {
    if (resolveEnvName(language, location.environment) !== location.environment) return undefined
  } catch {
    return undefined
  }

  const prefix = path.join(
    toDataRoot,
    'runtime',
    'envs',
    envDirectoryName(location.environment, platform)
  )
  return platform === 'win32'
    ? language === 'python'
      ? path.join(prefix, 'python.exe')
      : path.join(prefix, 'Lib', 'R', 'bin', 'R.exe')
    : path.join(prefix, 'bin', language === 'python' ? 'python' : 'R')
}
