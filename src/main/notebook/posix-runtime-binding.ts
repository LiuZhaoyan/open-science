import { posix } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRuntimeBinding } from '../../shared/notebook-runtime'
import { logicalEnvNameFromDirectory } from './runtime-paths'

export type PosixManagedRuntimeLocation = {
  environment: string
  interpreterKey: string
  runtimeRoot: string
}

export const posixManagedRuntimeLocation = ({
  language,
  platform,
  runtimeId
}: {
  language: NotebookLanguage
  platform: NodeJS.Platform
  runtimeId: string
}): PosixManagedRuntimeLocation | undefined => {
  if (platform !== 'darwin' && platform !== 'linux') return undefined

  const interpreterKey = posix.normalize(runtimeId)
  if (!posix.isAbsolute(interpreterKey)) return undefined

  const binDirectory = posix.dirname(interpreterKey)
  if (
    posix.basename(binDirectory) !== 'bin' ||
    posix.basename(interpreterKey) !== (language === 'r' ? 'R' : 'python')
  ) {
    return undefined
  }

  const environmentDirectory = posix.dirname(binDirectory)
  const envsDirectory = posix.dirname(environmentDirectory)
  const runtimeRoot = posix.dirname(envsDirectory)
  if (posix.basename(envsDirectory) !== 'envs' || posix.basename(runtimeRoot) !== 'runtime') {
    return undefined
  }

  return {
    environment: logicalEnvNameFromDirectory(posix.basename(environmentDirectory)),
    interpreterKey,
    runtimeRoot
  }
}

export const historicalPosixManagedEnvironment = ({
  language,
  platform,
  wire
}: {
  language: NotebookLanguage
  platform: NodeJS.Platform
  wire: NotebookRuntimeBinding
}): PosixManagedRuntimeLocation | undefined => {
  if (
    wire.language !== language ||
    wire.source !== 'managed' ||
    (wire.provenance !== 'app-managed' && wire.provenance !== 'agent-created')
  ) {
    return undefined
  }

  const interpreterKey = posix.normalize(wire.interpreterPath)
  if (posix.normalize(wire.runtimeId) !== interpreterKey) {
    return undefined
  }
  return posixManagedRuntimeLocation({ language, platform, runtimeId: interpreterKey })
}
