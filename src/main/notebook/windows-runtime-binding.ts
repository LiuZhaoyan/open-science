import { join, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRuntimeBinding } from '../../shared/notebook-runtime'
import { getRuntimeRoot } from './repository'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, legacyDefaultEnvPrefix } from './runtime-paths'

type LegacyWindowsManagedDefault = {
  environment: typeof DEFAULT_PY_ENV | typeof DEFAULT_R_ENV
  interpreterKey: string
}

export const windowsRuntimePathKey = (path: string): string => win32.normalize(path).toLowerCase()

export const legacyWindowsManagedDefault = ({
  dataRoot,
  language,
  platform,
  wire
}: {
  dataRoot: string
  language: NotebookLanguage
  platform: NodeJS.Platform
  wire: NotebookRuntimeBinding
}): LegacyWindowsManagedDefault | undefined => {
  if (platform !== 'win32') return undefined
  if (
    wire.language !== language ||
    wire.source !== 'managed' ||
    wire.provenance !== 'app-managed'
  ) {
    return undefined
  }

  const environment = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  const legacyPrefix = legacyDefaultEnvPrefix(getRuntimeRoot(dataRoot), environment)
  const legacyInterpreter =
    language === 'python'
      ? join(legacyPrefix, 'python.exe')
      : join(legacyPrefix, 'Lib', 'R', 'bin', 'R.exe')
  const interpreterKey = windowsRuntimePathKey(legacyInterpreter)
  if (
    windowsRuntimePathKey(wire.runtimeId) !== interpreterKey ||
    windowsRuntimePathKey(wire.interpreterPath) !== interpreterKey
  ) {
    return undefined
  }

  return { environment, interpreterKey }
}
