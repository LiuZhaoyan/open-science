import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import { exportEnvironmentLock, managedEnvironmentRef } from './environment-lock'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  writeReadyMarker
} from './runtime-paths'

const roots: string[] = []
const makeRuntimeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'envlock-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const interpreter = (overrides: Partial<DiscoveredInterpreter>): DiscoveredInterpreter => ({
  language: 'python',
  provenance: 'app-managed',
  envId: '/runtime/envs/default-python/bin/python',
  interpreterPath: '/runtime/envs/default-python/bin/python',
  label: 'Default Python',
  runnable: true,
  ...overrides
})

// Realistic `micromamba list --explicit --md5` stdout: comment/header lines, padded URL lines,
// and a non-URL title line that must all be stripped.
const EXPLICIT_STDOUT = [
  '# platform: linux-64',
  '@EXPLICIT',
  '  https://conda.anaconda.org/conda-forge/noarch/python-3.12.conda#abc123  ',
  'https://conda.anaconda.org/conda-forge/linux-64/numpy-2.1.conda#def456',
  'a non-URL title line'
].join('\n')

const EXPLICIT_LOCK =
  [
    '@EXPLICIT',
    'https://conda.anaconda.org/conda-forge/noarch/python-3.12.conda#abc123',
    'https://conda.anaconda.org/conda-forge/linux-64/numpy-2.1.conda#def456'
  ].join('\n') + '\n'

describe('exportEnvironmentLock', () => {
  it('normalizes valid explicit output into a validated @EXPLICIT lock', async () => {
    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    const lock = await exportEnvironmentLock(
      { name: 'default-python', prefix: '/runtime/envs/default-python' },
      { mm: '/mm', capture }
    )
    expect(lock).toBe(EXPLICIT_LOCK)
    expect(capture).toHaveBeenCalledWith([
      '/mm',
      '--no-rc',
      'list',
      '--prefix',
      '/runtime/envs/default-python',
      '--explicit',
      '--md5'
    ])
  })

  it('rejects an env whose exported lock has no package URLs', async () => {
    const capture = vi.fn().mockResolvedValue('# nothing installed\n@EXPLICIT\n')
    await expect(
      exportEnvironmentLock(
        { name: 'default-r', prefix: '/runtime/envs/default-r' },
        { mm: '/mm', capture }
      )
    ).rejects.toThrow('Could not export default-r: the exported lock contains no package URLs.')
  })

  it('propagates micromamba capture failures unchanged', async () => {
    const failure = new Error('micromamba failed (/mm list --prefix): no such environment')
    const capture = vi.fn().mockRejectedValue(failure)
    await expect(
      exportEnvironmentLock(
        { name: 'half-made', prefix: '/runtime/envs/half-made' },
        { mm: '/mm', capture }
      )
    ).rejects.toBe(failure)
  })
})

describe('managedEnvironmentRef', () => {
  it('resolves and exports a managed Python env from a discovered interpreter', async () => {
    const runtime = await makeRuntimeRoot()
    const prefix = envPrefix(runtime, DEFAULT_PY_ENV)
    const ref = managedEnvironmentRef(interpreter({ condaEnv: DEFAULT_PY_ENV }), runtime)
    expect(ref).toEqual({ name: DEFAULT_PY_ENV, prefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: '/mm', capture })).resolves.toBe(EXPLICIT_LOCK)
    expect(capture.mock.calls[0]?.[0]).toContain(prefix)
  })

  it('resolves and exports a managed R env from a discovered interpreter', async () => {
    const runtime = await makeRuntimeRoot()
    const prefix = envPrefix(runtime, DEFAULT_R_ENV)
    const ref = managedEnvironmentRef(
      interpreter({
        language: 'r',
        provenance: 'app-managed',
        condaEnv: DEFAULT_R_ENV,
        interpreterPath: '/runtime/envs/default-r/bin/R'
      }),
      runtime
    )
    expect(ref).toEqual({ name: DEFAULT_R_ENV, prefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: '/mm', capture })).resolves.toBe(EXPLICIT_LOCK)
    expect(capture.mock.calls[0]?.[0]).toContain(prefix)
  })

  it('returns undefined rather than guessing when a managed interpreter has no conda env name', () => {
    expect(managedEnvironmentRef(interpreter({ condaEnv: undefined }), '/runtime')).toBeUndefined()
  })

  it('treats agent-created envs as managed', () => {
    const runtime = '/runtime'
    const ref = managedEnvironmentRef(
      interpreter({ provenance: 'agent-created', condaEnv: 'my-analysis' }),
      runtime
    )
    expect(ref).toEqual({ name: 'my-analysis', prefix: envPrefix(runtime, 'my-analysis') })
  })

  it('returns undefined for user-own interpreters, even inside a foreign conda env', () => {
    const ref = managedEnvironmentRef(
      interpreter({
        provenance: 'user-own',
        condaEnv: 'my-conda-env',
        interpreterPath: '/home/u/miniconda3/envs/my-conda-env/bin/python'
      }),
      '/runtime'
    )
    expect(ref).toBeUndefined()
  })

  it('resolves the Windows short default prefix when the ready marker commits it', async () => {
    const runtime = await makeRuntimeRoot()
    const shortPrefix = join(runtime, 'envs', '.p')
    await mkdir(shortPrefix, { recursive: true })
    writeReadyMarker(runtime, DEFAULT_ENV_VERSION, 'ready', '.p')

    const ref = managedEnvironmentRef(
      interpreter({
        condaEnv: DEFAULT_PY_ENV,
        interpreterPath: join(shortPrefix, 'python.exe')
      }),
      runtime,
      'win32'
    )
    expect(ref).toEqual({ name: DEFAULT_PY_ENV, prefix: shortPrefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: 'C:\\mm.exe', capture })).resolves.toBe(
      EXPLICIT_LOCK
    )
    expect(capture.mock.calls[0]?.[0]).toContain(shortPrefix)
  })
})
