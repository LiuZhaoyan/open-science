import { describe, expect, it, vi } from 'vitest'

import { composeApplicationRuntime } from '../application-runtime'
import { createConnectorApplicationModule, type ConnectorApplicationDeps } from './application'

describe('Connector application composition', () => {
  it('reuses fakes and closes the MCP manager through runtime disposal', async () => {
    const settings = {
      getConnectors: vi.fn().mockResolvedValue({ customMcpServers: [] }),
      saveCustomServerOAuthState: vi.fn().mockResolvedValue(undefined),
      setCustomServerRuntimeProjectionProvider: vi.fn(),
      setCustomServerAuthenticator: vi.fn(),
      previewSkillArchive: vi.fn(),
      importSkillArchiveBatch: vi.fn(),
      scanRepoSkills: vi.fn().mockResolvedValue({ skills: [] }),
      importSkill: vi.fn()
    } as unknown as ConnectorApplicationDeps['settings']
    const mcpClientManager = {
      listTools: vi.fn().mockResolvedValue([]),
      call: vi.fn(),
      authenticate: vi.fn().mockResolvedValue(undefined),
      cancelAuthentication: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      closeAll: vi.fn().mockResolvedValue(undefined)
    } as unknown as NonNullable<ConnectorApplicationDeps['mcpClientManager']>
    const connectorApprovals = {
      request: vi.fn().mockResolvedValue('once'),
      respond: vi.fn(),
      getPending: vi.fn().mockReturnValue(null),
      pauseSession: vi.fn(),
      resumeSession: vi.fn()
    } as unknown as NonNullable<ConnectorApplicationDeps['connectorApprovals']>
    const skillImportApprovals = {
      createCancellationGuard: vi.fn().mockReturnValue({ isCancelled: () => false }),
      createSessionCancellationGuard: vi.fn().mockReturnValue({ isCancelled: () => false }),
      request: vi.fn(),
      respond: vi.fn(),
      replayPending: vi.fn(),
      beginSessionTurn: vi.fn(),
      endSessionTurn: vi.fn(),
      allowSessionTurnAttachment: vi.fn(),
      cancelSession: vi.fn(),
      cancelAll: vi.fn()
    } as unknown as NonNullable<ConnectorApplicationDeps['skillImportApprovals']>
    const deps: ConnectorApplicationDeps = {
      settings,
      skillsDir: '/tmp/skills',
      openExternal: vi.fn(),
      notifyStatusChanged: vi.fn(),
      broadcastConnectorApproval: vi.fn(),
      replayConnectorApproval: vi.fn(),
      onConnectorApprovalSettled: vi.fn(),
      broadcastSkillImportApproval: vi.fn(),
      onSkillImportSettled: vi.fn(),
      onSkillImportLifecycleSettled: vi.fn(),
      uploads: {} as ConnectorApplicationDeps['uploads'],
      fetchImpl: vi.fn() as unknown as typeof fetch,
      resolveApiKey: vi.fn(),
      resolveSpecialistProfile: vi.fn().mockResolvedValue(undefined),
      mcpClientManager,
      connectorApprovals,
      skillImportApprovals
    }
    const runtime = await composeApplicationRuntime(async (modules) => ({
      application: await modules.add(deps, createConnectorApplicationModule)
    }))
    const application = runtime.interfaces.application

    expect(application.mcpClientManager).toBe(mcpClientManager)
    expect(application.connectorApprovals).toBe(connectorApprovals)
    expect(application.skillImportApprovals).toBe(skillImportApprovals)
    expect(application.connectorService).toBeDefined()
    expect(application.runtimeSettings).toBeDefined()
    expect(application.skillImporter).toBeDefined()
    expect(settings.setCustomServerRuntimeProjectionProvider).toHaveBeenCalledOnce()
    expect(settings.setCustomServerAuthenticator).toHaveBeenCalledOnce()

    await runtime.dispose()
    expect(mcpClientManager.closeAll).toHaveBeenCalledOnce()
  })
})
