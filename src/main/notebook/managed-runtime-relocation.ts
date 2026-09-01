import type { NotebookLanguage } from '../../shared/notebook'
import { relocatedPosixManagedRuntimeId } from './posix-runtime-binding'
import { relocatedWindowsManagedRuntimeId } from './windows-runtime-binding'

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
  const input = { fromDataRoot, toDataRoot, language, platform, runtimeId }
  return relocatedWindowsManagedRuntimeId(input) ?? relocatedPosixManagedRuntimeId(input)
}
