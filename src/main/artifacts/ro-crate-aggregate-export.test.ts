import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import type {
  ArtifactExecutionSnapshot,
  ArtifactVersionDescriptor,
  ArtifactVersionEvidence
} from '../../shared/artifact-provenance'
import type { ArtifactVersionReviewProjection } from '../../shared/reviewer'
import {
  buildAggregateCompleteRoCrateArchive,
  buildAggregateRoCrateArchive,
  buildAggregateRoCrateMetadata,
  PROJECT_COMPLETE_PROFILE,
  PROJECT_LIGHTWEIGHT_PROFILE,
  SESSION_COMPLETE_PROFILE,
  SESSION_LIGHTWEIGHT_PROFILE,
  type AggregateRoCrateSource
} from './ro-crate-aggregate-export'
import type {
  ArtifactVersionRoCrateSource,
  RoCrateEntity,
  RoCrateMetadataDocument
} from './ro-crate-export'
import { sha256 } from './provenance-canonical'

const artifactSource = (
  versionNumber = 1,
  overrides: Partial<ArtifactVersionEvidence> = {}
): ArtifactVersionRoCrateSource => {
  const versionId = `version-${versionNumber}`
  const descriptor: ArtifactVersionDescriptor = {
    projectId: 'project-1',
    sessionId: 'session-1',
    id: versionId,
    name: `report-${versionNumber}.csv`,
    size: 4,
    mtimeMs: 0,
    artifactId: 'artifact-1',
    versionId,
    versionNumber,
    checksum: String(versionNumber).repeat(64),
    createdAt: `2026-09-${String(10 + versionNumber).padStart(2, '0')}T00:00:00.000Z`,
    state: 'finalized',
    originKind: 'agent_generated'
  }
  const evidence: ArtifactVersionEvidence = {
    schema_version: 1,
    project_id: descriptor.projectId,
    app_session_id: descriptor.sessionId,
    artifact_id: descriptor.artifactId,
    version_id: descriptor.versionId,
    version_number: descriptor.versionNumber,
    filename: descriptor.name,
    content_type: 'text/csv',
    size_bytes: descriptor.size,
    checksum: descriptor.checksum,
    created_at: descriptor.createdAt,
    conversation: {
      root_frame_id: 'root-frame-1',
      agent_frame_id: 'agent-frame-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'segment-1',
      prompt_message_id: 'prompt-1'
    },
    is_user_upload: false,
    execution_status: { state: 'unavailable', reason: 'not-captured' },
    inputs: [],
    producer: { state: 'unavailable', reason: 'producer-not-supplied' },
    environment_status: { state: 'unavailable', reason: 'not-captured' },
    ...overrides
  }
  descriptor.name = evidence.filename
  descriptor.size = evidence.size_bytes
  descriptor.checksum = evidence.checksum
  descriptor.createdAt = evidence.created_at
  return { descriptor, contentStatus: { state: 'available' }, evidence }
}

const reviewFor = (versionId: string): ArtifactVersionReviewProjection => ({
  binding: 'version',
  selectedVersionId: versionId,
  selectedVersionAssessment: {
    id: 'review-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId: 'message-1',
    scope: { turnMessageId: 'message-1', blocks: [], artifactVersionIds: [versionId] },
    lifecycle: 'complete',
    outcome: 'pass',
    model: 'reviewer-model',
    reviewerLog: [],
    createdAt: 0,
    updatedAt: 0,
    checks: [],
    scopeSnapshot: { state: 'available', blocks: [] }
  },
  latestChainReview: {
    id: 'review-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId: 'message-1',
    scope: { turnMessageId: 'message-1', blocks: [], artifactVersionIds: [versionId] },
    lifecycle: 'complete',
    outcome: 'pass',
    model: 'reviewer-model',
    reviewerLog: [],
    createdAt: 0,
    updatedAt: 0,
    checks: [],
    scopeSnapshot: { state: 'available', blocks: [] }
  },
  selectedVersionChecks: [],
  turnLevelChecks: [],
  selectedVersionDispositions: [],
  history: []
})

const executionWithRunIds = (runIds: readonly string[]): ArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'root-frame-1',
  agentFrameId: 'agent-frame-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: runIds[0],
  producerRunIndex: 1,
  createdAt: '2026-09-11T00:00:00.000Z',
  inputFiles: [],
  runs: runIds.map((runId, index) => ({
    runId,
    runIndex: index + 1,
    agentFrameId: 'agent-frame-1',
    messageBranchId: 'branch-1',
    runtimeSegmentId: `segment-${index}`,
    promptMessageId: 'prompt-1',
    kernelKind: 'python',
    script: '',
    status: 'completed',
    startedAt: '2026-09-11T00:00:00.000Z',
    completedAt: '2026-09-11T00:00:01.000Z',
    outputs: [],
    inputFileVersionKeys: []
  }))
})

const sessionSource = (
  versions: readonly ArtifactVersionRoCrateSource[] = [artifactSource()]
): AggregateRoCrateSource => ({
  scope: 'session',
  projectId: 'project-1',
  sessionId: 'session-1',
  snapshotCapturedAt: '2026-09-21T08:30:00.000Z',
  scopeCreatedAt: '2026-09-01T10:00:00.000Z',
  versions
})

const entity = (document: RoCrateMetadataDocument, id: string): RoCrateEntity => {
  const value = document['@graph'].find((candidate) => candidate['@id'] === id)
  if (!value) throw new Error(`Missing entity ${id}`)
  return value
}

const archiveMetadata = (archive: Uint8Array): RoCrateMetadataDocument => {
  const files = unzipSync(archive)
  return JSON.parse(strFromU8(files['ro-crate-metadata.json']!)) as RoCrateMetadataDocument
}

describe('aggregate RO-Crate export', () => {
  it('builds a session root containing an immutable Artifact Version Dataset', () => {
    const document = buildAggregateRoCrateMetadata(sessionSource())
    const root = entity(document, './')
    expect(root).toMatchObject({
      '@type': 'Dataset',
      name: 'Open Science Session session-1 RO-Crate',
      dateCreated: '2026-09-01T10:00:00.000Z',
      datePublished: '2026-09-21T08:30:00.000Z',
      conformsTo: { '@id': SESSION_LIGHTWEIGHT_PROFILE },
      hasPart: [{ '@id': 'artifacts/artifact-1/versions/version-1/' }]
    })
    const version = entity(document, 'artifacts/artifact-1/versions/version-1/')
    expect(version).toMatchObject({
      '@type': 'Dataset',
      name: 'report-1.csv (Artifact Version v1)',
      version: 'v1',
      datePublished: '2026-09-11T00:00:00.000Z',
      mainEntity: { '@id': 'urn:open-science:version:version-1' }
    })
    expect(version.conformsTo).toEqual({
      '@id': 'urn:open-science:ro-crate-profile:artifact-version-lightweight'
    })
    expect(
      document['@graph'].filter((item) => item['@id'] === 'ro-crate-metadata.json')
    ).toHaveLength(1)
  })

  it('builds an empty project crate with the project profile', () => {
    const document = buildAggregateRoCrateMetadata({
      scope: 'project',
      projectId: 'project-1',
      snapshotCapturedAt: '2026-09-21T08:30:00.000Z',
      displayNameSnapshot: 'Proteomics project snapshot',
      versions: []
    })
    expect(entity(document, './')).toMatchObject({
      name: 'Proteomics project snapshot',
      conformsTo: { '@id': PROJECT_LIGHTWEIGHT_PROFILE }
    })
    expect(entity(document, './')).not.toHaveProperty('hasPart')
  })

  it.each([
    [
      'scope mismatch',
      () => {
        const value = artifactSource()
        value.evidence.project_id = 'project-2'
        return sessionSource([value])
      }
    ],
    [
      'pending version',
      () => {
        const value = artifactSource()
        value.descriptor.state = 'pending'
        return sessionSource([value])
      }
    ],
    [
      'duplicate version ID',
      () => {
        const value = artifactSource()
        return sessionSource([value, value])
      }
    ]
  ] as const)('rejects an invalid aggregate source: %s', (_label, makeSource) => {
    expect(() => buildAggregateRoCrateMetadata(makeSource())).toThrow('RO-Crate')
  })

  it('rejects reviewer evidence bound to another Artifact Version', () => {
    const value = artifactSource()
    value.review = reviewFor('another-version')
    expect(() => buildAggregateRoCrateMetadata(sessionSource([value]))).toThrow(
      'RO-Crate reviewer identity mismatch'
    )
  })

  it('rejects lossy contextual ID collisions instead of discarding provenance', () => {
    const value = artifactSource()
    value.execution = executionWithRunIds(['a/b', 'a b'])
    expect(() => buildAggregateRoCrateMetadata(sessionSource([value]))).toThrow(
      'RO-Crate entity ID conflict'
    )
  })

  it('rejects Artifact IDs that are unsafe on portable filesystems', () => {
    const value = artifactSource()
    value.descriptor.versionId = 'version-1.'
    value.descriptor.id = 'version-1.'
    value.evidence.version_id = 'version-1.'
    expect(() => buildAggregateRoCrateMetadata(sessionSource([value]))).toThrow(
      'RO-Crate archive path segment is not portable'
    )
  })

  it('builds a deterministic lightweight archive with isolated version provenance', () => {
    const firstVersion = artifactSource(1)
    const secondVersion = artifactSource(2)
    const first = buildAggregateRoCrateArchive(sessionSource([secondVersion, firstVersion]))
    const second = buildAggregateRoCrateArchive(sessionSource([firstVersion, secondVersion]))
    expect(first).toEqual(second)

    const files = unzipSync(first)
    expect(Object.keys(files).sort()).toEqual([
      'artifacts/artifact-1/versions/version-1/provenance/artifact-version-evidence.json',
      'artifacts/artifact-1/versions/version-2/provenance/artifact-version-evidence.json',
      'ro-crate-metadata.json'
    ])
    const metadata = archiveMetadata(first)
    expect(entity(metadata, '#artifact-version/version-1/create-action/publication')).toBeTruthy()
    expect(entity(metadata, '#artifact-version/version-2/create-action/publication')).toBeTruthy()
    expect(entity(metadata, 'artifacts/artifact-1/versions/version-1/').hasPart).toEqual([
      {
        '@id': 'artifacts/artifact-1/versions/version-1/provenance/artifact-version-evidence.json'
      }
    ])
  })

  it('rejects archive paths that collide on portable filesystems', () => {
    const firstVersion = artifactSource(1)
    const secondVersion = artifactSource(2)
    secondVersion.descriptor.versionId = 'VERSION-1'
    secondVersion.descriptor.id = 'VERSION-1'
    secondVersion.evidence.version_id = 'VERSION-1'

    expect(() =>
      buildAggregateRoCrateArchive(sessionSource([firstVersion, secondVersion]))
    ).toThrow('RO-Crate archive path conflicts:')
  })

  it('rejects complete exports over the in-memory content budget before reading bytes', async () => {
    const readVersionContent = vi.fn(async () => Buffer.alloc(0))
    const oversized = artifactSource(1, {
      size_bytes: 256 * 1024 * 1024 + 1,
      checksum: 'a'.repeat(64)
    })

    await expect(
      buildAggregateCompleteRoCrateArchive(sessionSource([oversized]), {
        readVersionContent,
        readInputContent: async () => undefined
      })
    ).rejects.toThrow('RO-Crate aggregate content budget exceeded')
    expect(readVersionContent).not.toHaveBeenCalled()
  })

  it('rejects conflicting sizes for one checksum before reading bytes', async () => {
    const checksum = 'c'.repeat(64)
    const first = artifactSource(1, { checksum, size_bytes: 4 })
    const second = artifactSource(2, { checksum, size_bytes: 5 })
    const readVersionContent = vi.fn(async () => Buffer.from('data'))
    await expect(
      buildAggregateCompleteRoCrateArchive(sessionSource([first, second]), {
        readVersionContent,
        readInputContent: async () => undefined
      })
    ).rejects.toThrow('RO-Crate checksum has conflicting declared sizes')
    expect(readVersionContent).not.toHaveBeenCalled()
  })

  it('uses the first valid deterministic candidate for shared content', async () => {
    const bytes = Buffer.from('shared')
    const checksum = sha256(bytes)
    const first = artifactSource(1, { checksum, size_bytes: bytes.byteLength })
    const second = artifactSource(2, { checksum, size_bytes: bytes.byteLength })
    const readVersionContent = vi.fn(async (versionId: string) =>
      versionId === 'version-1' ? undefined : bytes
    )
    const archive = await buildAggregateCompleteRoCrateArchive(
      {
        scope: 'project',
        projectId: 'project-1',
        snapshotCapturedAt: '2026-09-21T08:30:00.000Z',
        versions: [second, first]
      },
      { readVersionContent, readInputContent: async () => undefined }
    )
    expect(readVersionContent.mock.calls.map(([versionId]) => versionId)).toEqual([
      'version-1',
      'version-2'
    ])
    expect(entity(archiveMetadata(archive), './').conformsTo).toEqual({
      '@id': PROJECT_COMPLETE_PROFILE
    })
  })

  it('propagates content reader failures', async () => {
    await expect(
      buildAggregateCompleteRoCrateArchive(sessionSource(), {
        readVersionContent: async () => {
          throw new Error('storage offline')
        },
        readInputContent: async () => undefined
      })
    ).rejects.toThrow('storage offline')
  })

  it('keeps checksum references when no candidate content passes verification', async () => {
    const value = artifactSource()
    const archive = await buildAggregateCompleteRoCrateArchive(sessionSource([value]), {
      readVersionContent: async () => Buffer.from('wrong bytes'),
      readInputContent: async () => undefined
    })
    const metadata = archiveMetadata(archive)
    expect(entity(metadata, './')).toMatchObject({
      conformsTo: { '@id': SESSION_COMPLETE_PROFILE },
      description: expect.stringContaining('not fully self-contained')
    })
    const version = entity(metadata, 'artifacts/artifact-1/versions/version-1/')
    expect(version.mainEntity).toEqual({ '@id': 'urn:open-science:version:version-1' })
    expect(String(entity(metadata, 'urn:open-science:version:version-1').description)).toContain(
      'failed size verification'
    )
  })

  it('stores matching content once and keeps each immutable version identity', async () => {
    const bytes = Buffer.from('same content')
    const checksum = sha256(bytes)
    const firstVersion = artifactSource(1, {
      filename: 'zeta.csv',
      content_type: 'text/csv',
      size_bytes: bytes.byteLength,
      checksum
    })
    const secondVersion = artifactSource(2, {
      filename: 'alpha.txt',
      content_type: 'text/plain',
      size_bytes: bytes.byteLength,
      checksum
    })
    const readVersionContent = vi.fn(async () => bytes)
    const archive = await buildAggregateCompleteRoCrateArchive(
      sessionSource([secondVersion, firstVersion]),
      { readVersionContent, readInputContent: async () => undefined }
    )

    expect(readVersionContent).toHaveBeenCalledTimes(1)
    const files = unzipSync(archive)
    expect(Object.keys(files).filter((path) => path.startsWith('data/'))).toEqual([
      `data/sha256/${checksum}`
    ])
    const metadata = archiveMetadata(archive)
    expect(entity(metadata, './').conformsTo).toEqual({ '@id': SESSION_COMPLETE_PROFILE })
    for (const version of [firstVersion, secondVersion]) {
      expect(
        entity(metadata, `artifacts/artifact-1/versions/${version.evidence.version_id}/`)
      ).toMatchObject({
        mainEntity: { '@id': `data/sha256/${checksum}` },
        conformsTo: {
          '@id': 'urn:open-science:ro-crate-profile:artifact-version-complete'
        }
      })
    }
    expect(entity(metadata, `data/sha256/${checksum}`)).toMatchObject({
      '@type': 'File',
      name: 'alpha.txt',
      alternateName: ['zeta.csv'],
      encodingFormat: ['text/csv', 'text/plain'],
      contentSize: String(bytes.byteLength),
      sha256: checksum
    })
  })
})
