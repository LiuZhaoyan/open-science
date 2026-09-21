import { strToU8, zipSync, type Zippable } from 'fflate'

import type { ArtifactVersionInputEvidence } from '../../shared/artifact-provenance'
import { sha256 } from './provenance-canonical'
import {
  buildArtifactVersionRoCrateMetadata,
  NO_ADDITIONAL_RIGHTS,
  RO_CRATE_CONTEXT,
  RO_CRATE_SPECIFICATION,
  ZIP_MTIME,
  provenanceSidecars,
  serializeRoCrateMetadata,
  type ArtifactVersionRoCrateSource,
  type RoCrateEntity,
  type RoCrateMetadataDocument
} from './ro-crate-export-core'

const SESSION_LIGHTWEIGHT_PROFILE = 'urn:open-science:ro-crate-profile:session-lightweight'
const SESSION_COMPLETE_PROFILE = 'urn:open-science:ro-crate-profile:session-complete'
const PROJECT_LIGHTWEIGHT_PROFILE = 'urn:open-science:ro-crate-profile:project-lightweight'
const PROJECT_COMPLETE_PROFILE = 'urn:open-science:ro-crate-profile:project-complete'
const MAX_VERSION_SOURCES = 10_000
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_COMPLETE_CONTENT_BYTES = 256 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024 * 1024

type AggregateScopeFields = {
  projectId: string
  snapshotCapturedAt: string
  scopeCreatedAt?: string
  displayNameSnapshot?: string
  descriptionSnapshot?: string
  versions: readonly ArtifactVersionRoCrateSource[]
}

type AggregateRoCrateSource =
  | (AggregateScopeFields & { scope: 'session'; sessionId: string })
  | (AggregateScopeFields & { scope: 'project' })

type AggregateRoCrateContentReaders = {
  readVersionContent: (versionId: string) => Promise<Uint8Array | undefined>
  readInputContent: (input: ArtifactVersionInputEvidence) => Promise<Uint8Array | undefined>
}

const reference = (id: string): { '@id': string } => ({ '@id': id })
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
const pathSegment = (value: string): string => encodeURIComponent(value)
const versionDatasetId = (source: ArtifactVersionRoCrateSource): string =>
  `artifacts/${pathSegment(source.evidence.artifact_id)}/versions/${pathSegment(source.evidence.version_id)}/`
const contextualPrefix = (source: ArtifactVersionRoCrateSource): string =>
  `artifact-version/${pathSegment(source.evidence.version_id)}`

const sortedVersions = (
  versions: readonly ArtifactVersionRoCrateSource[]
): ArtifactVersionRoCrateSource[] =>
  [...versions].sort(
    (left, right) =>
      compareText(left.evidence.project_id, right.evidence.project_id) ||
      compareText(left.evidence.app_session_id, right.evidence.app_session_id) ||
      compareText(left.evidence.artifact_id, right.evidence.artifact_id) ||
      left.evidence.version_number - right.evidence.version_number ||
      compareText(left.evidence.version_id, right.evidence.version_id)
  )

const validateAggregateSource = (source: AggregateRoCrateSource): void => {
  if (source.versions.length > MAX_VERSION_SOURCES) {
    throw new Error('RO-Crate aggregate version budget exceeded')
  }
  const versionIds = new Set<string>()
  const fileVersions = new Map<string, { checksum: string; size: number }>()
  const recordFileVersion = (id: string, checksum: string, size: number): void => {
    const existing = fileVersions.get(id)
    if (existing && (existing.checksum !== checksum || existing.size !== size)) {
      throw new Error(`RO-Crate content identity conflict: ${id}`)
    }
    fileVersions.set(id, { checksum, size })
  }
  for (const version of source.versions) {
    const { descriptor, evidence } = version
    if (
      descriptor.projectId !== evidence.project_id ||
      descriptor.sessionId !== evidence.app_session_id ||
      descriptor.artifactId !== evidence.artifact_id ||
      descriptor.id !== evidence.version_id ||
      descriptor.versionId !== evidence.version_id ||
      descriptor.versionNumber !== evidence.version_number
    ) {
      throw new Error(`RO-Crate Artifact Version identity mismatch: ${evidence.version_id}`)
    }
    if (
      evidence.project_id !== source.projectId ||
      (source.scope === 'session' && evidence.app_session_id !== source.sessionId)
    ) {
      throw new Error(`RO-Crate Artifact Version is outside the ${source.scope} scope`)
    }
    if (descriptor.state !== 'finalized') {
      throw new Error(
        `RO-Crate aggregate requires finalized Artifact Versions: ${evidence.version_id}`
      )
    }
    if (versionIds.has(evidence.version_id)) {
      throw new Error(`RO-Crate aggregate contains duplicate version ID: ${evidence.version_id}`)
    }
    versionIds.add(evidence.version_id)
    recordFileVersion(evidence.version_id, evidence.checksum, evidence.size_bytes)
    for (const input of evidence.inputs) {
      recordFileVersion(input.input_file_version_id, input.checksum, input.size_bytes)
    }
  }
}

const aggregateProfile = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete'
): string =>
  source.scope === 'session'
    ? profile === 'complete'
      ? SESSION_COMPLETE_PROFILE
      : SESSION_LIGHTWEIGHT_PROFILE
    : profile === 'complete'
      ? PROJECT_COMPLETE_PROFILE
      : PROJECT_LIGHTWEIGHT_PROFILE

const aggregateName = (source: AggregateRoCrateSource): string =>
  source.displayNameSnapshot ??
  (source.scope === 'session'
    ? `Open Science Session ${source.sessionId} RO-Crate`
    : `Open Science Project ${source.projectId} RO-Crate`)

const aggregateDescription = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  partial = false
): string => {
  const provenanceDescription = `Open Science ${
    source.scope === 'session' ? 'Session' : 'Project'
  } Artifact Version provenance crate (${profile} profile).${
    partial
      ? ' Some data files could not be included and remain immutable checksum references, so this crate is not fully self-contained.'
      : ''
  }`
  return source.descriptionSnapshot
    ? `${source.descriptionSnapshot} ${provenanceDescription}`
    : provenanceDescription
}

const metadataDescriptor = (): RoCrateEntity => ({
  '@type': 'CreativeWork',
  '@id': 'ro-crate-metadata.json',
  about: reference('./'),
  conformsTo: reference(RO_CRATE_SPECIFICATION)
})

const aggregateRoot = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  versionIds: readonly string[],
  partial = false
): RoCrateEntity => ({
  '@type': 'Dataset',
  '@id': './',
  name: aggregateName(source),
  ...(source.scopeCreatedAt ? { dateCreated: source.scopeCreatedAt } : {}),
  datePublished: source.snapshotCapturedAt,
  license: NO_ADDITIONAL_RIGHTS,
  description: aggregateDescription(source, profile, partial),
  conformsTo: reference(aggregateProfile(source, profile)),
  ...(versionIds.length ? { hasPart: versionIds.map(reference) } : {})
})

type VersionPackaging = {
  sidecars?: ReadonlyMap<string, string>
  packagedDataPaths?: ReadonlyMap<string, string>
  omittedDataReasons?: ReadonlyMap<string, string>
}

const buildAggregateMetadata = (
  source: AggregateRoCrateSource,
  profile: 'lightweight' | 'complete',
  packaging: ReadonlyMap<string, VersionPackaging> = new Map()
): RoCrateMetadataDocument => {
  validateAggregateSource(source)
  const versions = sortedVersions(source.versions)
  const versionIds = versions.map(versionDatasetId)
  const partial = [...packaging.values()].some((item) => item.omittedDataReasons?.size)
  const graph: RoCrateEntity[] = [
    metadataDescriptor(),
    aggregateRoot(source, profile, versionIds, partial)
  ]
  const seen = new Set(graph.map((entity) => entity['@id']))

  for (const version of versions) {
    const packaged = packaging.get(version.evidence.version_id)
    const fragment = buildArtifactVersionRoCrateMetadata(version, packaged?.sidecars ?? new Map(), {
      profile,
      packagedDataPaths: packaged?.packagedDataPaths,
      omittedDataReasons: packaged?.omittedDataReasons,
      rootId: versionDatasetId(version),
      rootName: `${version.evidence.filename} (Artifact Version v${version.evidence.version_number})`,
      contextualIdPrefix: contextualPrefix(version),
      includeMetadataDescriptor: false
    })
    for (const candidate of fragment['@graph']) {
      if (seen.has(candidate['@id'])) continue
      seen.add(candidate['@id'])
      graph.push(candidate)
    }
  }

  return { '@context': RO_CRATE_CONTEXT, '@graph': graph }
}

const buildAggregateRoCrateMetadata = (source: AggregateRoCrateSource): RoCrateMetadataDocument =>
  buildAggregateMetadata(source, 'lightweight')

const versionSidecars = (source: ArtifactVersionRoCrateSource): Map<string, string> => {
  const prefix = versionDatasetId(source)
  return new Map(
    [...provenanceSidecars(source)].map(([path, content]) => [`${prefix}${path}`, content])
  )
}

const assertMetadataBudget = (metadata: string, sidecarBytes: number): void => {
  if (Buffer.byteLength(metadata, 'utf8') + sidecarBytes > MAX_METADATA_BYTES) {
    throw new Error('RO-Crate aggregate metadata budget exceeded')
  }
}

const assertPortableArchivePaths = (paths: readonly string[]): void => {
  const portablePaths = new Map<string, string>()
  for (const path of paths) {
    const portablePath = path.normalize('NFD').toLowerCase()
    const existing = portablePaths.get(portablePath)
    if (existing && existing !== path) {
      throw new Error(`RO-Crate archive path conflicts: ${existing} and ${path}`)
    }
    portablePaths.set(portablePath, path)
  }
}

const buildAggregateRoCrateArchive = (source: AggregateRoCrateSource): Uint8Array => {
  validateAggregateSource(source)
  const packaging = new Map<string, VersionPackaging>()
  const entries: Zippable = {}
  let sidecarBytes = 0
  for (const version of sortedVersions(source.versions)) {
    const sidecars = versionSidecars(version)
    packaging.set(version.evidence.version_id, { sidecars })
    for (const [path, content] of sidecars) {
      sidecarBytes += Buffer.byteLength(content, 'utf8')
      entries[path] = [strToU8(content), { mtime: ZIP_MTIME }]
    }
  }
  if (1 + Object.keys(entries).length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('RO-Crate aggregate archive entry budget exceeded')
  }
  const metadata = buildAggregateMetadata(source, 'lightweight', packaging)
  const serializedMetadata = serializeRoCrateMetadata(metadata)
  assertMetadataBudget(serializedMetadata, sidecarBytes)
  entries['ro-crate-metadata.json'] = [strToU8(serializedMetadata), { mtime: ZIP_MTIME }]
  assertPortableArchivePaths(Object.keys(entries))
  return zipSync(entries, { level: 6 })
}

type ContentClaim = {
  ownerVersionId: string
  fileVersionId: string
  filename: string
  contentType?: string
  size: number
  checksum: string
  unavailableReason?: string
  read: () => Promise<Uint8Array | undefined>
}

type ContentGroup = {
  checksum: string
  size: number
  claims: ContentClaim[]
  names: string[]
  contentTypes: string[]
  path?: string
  bytes?: Uint8Array
  omittedReason?: string
}

const contentClaims = (
  versions: readonly ArtifactVersionRoCrateSource[],
  readers: AggregateRoCrateContentReaders
): ContentClaim[] =>
  versions.flatMap((version) => {
    const payload: ContentClaim = {
      ownerVersionId: version.evidence.version_id,
      fileVersionId: version.evidence.version_id,
      filename: version.evidence.filename,
      contentType: version.evidence.content_type,
      size: version.evidence.size_bytes,
      checksum: version.evidence.checksum,
      ...(version.contentStatus.state === 'unavailable'
        ? {
            unavailableReason: `are currently unavailable (${version.contentStatus.reason}) from the source installation`
          }
        : {}),
      read: () => readers.readVersionContent(version.evidence.version_id)
    }
    const inputs = [...version.evidence.inputs]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((input): ContentClaim => ({
        ownerVersionId: version.evidence.version_id,
        fileVersionId: input.input_file_version_id,
        filename: input.filename,
        contentType: input.content_type,
        size: input.size_bytes,
        checksum: input.checksum,
        read: () => readers.readInputContent(input)
      }))
    return [payload, ...inputs]
  })

const groupContentClaims = (claims: readonly ContentClaim[]): ContentGroup[] => {
  const groups = new Map<string, ContentGroup>()
  const identities = new Map<string, { checksum: string; size: number }>()
  for (const claim of claims) {
    const identity = identities.get(claim.fileVersionId)
    if (identity && (identity.checksum !== claim.checksum || identity.size !== claim.size)) {
      throw new Error(`RO-Crate content identity conflict: ${claim.fileVersionId}`)
    }
    identities.set(claim.fileVersionId, { checksum: claim.checksum, size: claim.size })
    const existing = groups.get(claim.checksum)
    if (existing) {
      if (existing.size !== claim.size) {
        throw new Error(`RO-Crate checksum has conflicting declared sizes: ${claim.checksum}`)
      }
      existing.claims.push(claim)
      if (!existing.names.includes(claim.filename)) existing.names.push(claim.filename)
      if (claim.contentType && !existing.contentTypes.includes(claim.contentType)) {
        existing.contentTypes.push(claim.contentType)
      }
      continue
    }
    groups.set(claim.checksum, {
      checksum: claim.checksum,
      size: claim.size,
      claims: [claim],
      names: [claim.filename],
      contentTypes: claim.contentType ? [claim.contentType] : []
    })
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      claims: [...group.claims].sort(
        (left, right) =>
          compareText(left.ownerVersionId, right.ownerVersionId) ||
          compareText(left.fileVersionId, right.fileVersionId) ||
          compareText(left.filename, right.filename)
      ),
      names: [...group.names].sort(compareText),
      contentTypes: [...group.contentTypes].sort(compareText)
    }))
    .sort((left, right) => compareText(left.checksum, right.checksum))
}

const readContentGroup = async (group: ContentGroup): Promise<void> => {
  let omittedReason = 'could not be read from the source installation'
  for (const claim of group.claims) {
    if (claim.unavailableReason) {
      omittedReason = claim.unavailableReason
      continue
    }
    const bytes = await claim.read()
    if (!bytes) continue
    if (bytes.byteLength !== group.size) {
      omittedReason = 'failed size verification'
      continue
    }
    if (sha256(Buffer.from(bytes)) !== group.checksum) {
      omittedReason = 'failed checksum verification'
      continue
    }
    group.path = `data/sha256/${group.checksum}`
    group.bytes = bytes
    return
  }
  group.omittedReason = omittedReason
}

const sharedContentEntity = (group: ContentGroup): RoCrateEntity => ({
  '@type': 'File',
  '@id': group.path!,
  name: group.names[0]!,
  ...(group.names.length > 1 ? { alternateName: group.names.slice(1) } : {}),
  contentSize: String(group.size),
  sha256: group.checksum,
  ...(group.contentTypes.length
    ? {
        encodingFormat: group.contentTypes.length === 1 ? group.contentTypes[0] : group.contentTypes
      }
    : {}),
  description:
    'Immutable content included once in this RO-Crate and verified against its declared size and SHA-256 checksum.'
})

const buildAggregateCompleteRoCrateArchive = async (
  source: AggregateRoCrateSource,
  readers: AggregateRoCrateContentReaders
): Promise<Uint8Array> => {
  validateAggregateSource(source)
  const versions = sortedVersions(source.versions)
  const groups = groupContentClaims(contentClaims(versions, readers))
  const declaredContentBytes = groups.reduce((total, group) => total + group.size, 0)
  if (declaredContentBytes > MAX_COMPLETE_CONTENT_BYTES) {
    throw new Error('RO-Crate aggregate content budget exceeded')
  }
  const sidecarsByVersion = new Map<string, Map<string, string>>()
  let sidecarBytes = 0
  let sidecarCount = 0
  for (const version of versions) {
    const sidecars = versionSidecars(version)
    sidecarsByVersion.set(version.evidence.version_id, sidecars)
    sidecarCount += sidecars.size
    for (const content of sidecars.values()) {
      sidecarBytes += Buffer.byteLength(content, 'utf8')
    }
  }
  if (sidecarBytes > MAX_METADATA_BYTES) {
    throw new Error('RO-Crate aggregate metadata budget exceeded')
  }
  if (1 + sidecarCount + groups.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('RO-Crate aggregate archive entry budget exceeded')
  }
  for (const group of groups) await readContentGroup(group)

  const packaging = new Map<string, VersionPackaging>()
  const entries: Zippable = {}
  for (const version of versions) {
    const sidecars = sidecarsByVersion.get(version.evidence.version_id)!
    const packagedDataPaths = new Map<string, string>()
    const omittedDataReasons = new Map<string, string>()
    for (const group of groups) {
      for (const claim of group.claims) {
        if (claim.ownerVersionId !== version.evidence.version_id) continue
        if (group.path) packagedDataPaths.set(claim.fileVersionId, group.path)
        else omittedDataReasons.set(claim.fileVersionId, group.omittedReason!)
      }
    }
    packaging.set(version.evidence.version_id, {
      sidecars,
      packagedDataPaths,
      omittedDataReasons
    })
    for (const [path, content] of sidecars) {
      entries[path] = [strToU8(content), { mtime: ZIP_MTIME }]
    }
  }
  for (const group of groups) {
    if (group.path && group.bytes)
      entries[group.path] = [group.bytes, { mtime: ZIP_MTIME, level: 0 }]
  }

  const metadata = buildAggregateMetadata(source, 'complete', packaging)
  const sharedEntities = new Map(
    groups.filter((group) => group.path).map((group) => [group.path!, sharedContentEntity(group)])
  )
  metadata['@graph'] = metadata['@graph'].map(
    (candidate) => sharedEntities.get(candidate['@id']) ?? candidate
  )
  const serializedMetadata = serializeRoCrateMetadata(metadata)
  assertMetadataBudget(serializedMetadata, sidecarBytes)
  entries['ro-crate-metadata.json'] = [strToU8(serializedMetadata), { mtime: ZIP_MTIME }]
  assertPortableArchivePaths(Object.keys(entries))
  return zipSync(entries, { level: 6 })
}

export {
  buildAggregateCompleteRoCrateArchive,
  buildAggregateRoCrateArchive,
  buildAggregateRoCrateMetadata,
  PROJECT_COMPLETE_PROFILE,
  PROJECT_LIGHTWEIGHT_PROFILE,
  SESSION_COMPLETE_PROFILE,
  SESSION_LIGHTWEIGHT_PROFILE
}
export type { AggregateRoCrateContentReaders, AggregateRoCrateSource }
