import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ModuleConfig } from '@open-mercato/core/modules/configs/data/entities'
import { LedgerAccount } from '@open-mercato/core/modules/ledger/data/entities'
import {
  SETTINGS_MODULE_ID,
  organizationConfigKey,
  readSettingsSnapshot,
  saveSettings,
  settingsLockKey,
} from '../moduleConfig'

type ConfigRow = {
  id: string
  moduleId: string
  name: string
  valueJson: unknown
  organizationId: string | null
  tenantId: string | null
  createdAt: Date
  updatedAt: Date
}

type AccountRow = { id: string; tenantId: string; organizationId: string; deletedAt: Date | null }

const store: { configs: ConfigRow[]; accounts: AccountRow[] } = { configs: [], accounts: [] }

const mockLock = jest.fn(async (em: unknown, _key: string, fn: (txEm: unknown) => Promise<unknown>) => fn(em))

jest.mock('@open-mercato/shared/lib/db/advisoryLock', () => ({
  withAdvisoryXactLock: (em: unknown, key: string, fn: (txEm: unknown) => Promise<unknown>) => mockLock(em, key, fn),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: async (_em: unknown, entity: unknown, where: Record<string, any>) => {
    if (entity === ModuleConfig) {
      return store.configs
        .filter((row) => row.moduleId === where.moduleId && row.tenantId === where.tenantId && where.name.$in.includes(row.name))
        .map((row) => ({ ...row, updatedAt: new Date(row.updatedAt.getTime()) }))
    }
    if (entity === LedgerAccount) {
      return store.accounts.filter(
        (account) =>
          where.id.$in.includes(account.id) &&
          account.tenantId === where.tenantId &&
          account.organizationId === where.organizationId &&
          account.deletedAt === null,
      )
    }
    return []
  },
}))

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RECEIVABLE = '11111111-1111-4111-8111-111111111111'
const VAT = '22222222-2222-4222-8222-222222222222'
const ROUNDING = '33333333-3333-4333-8333-333333333333'
const FOREIGN = '44444444-4444-4444-8444-444444444444'

const scopeA = { tenantId: TENANT, organizationId: ORG_A }
const scopeB = { tenantId: TENANT, organizationId: ORG_B }
const translate = (_key: string, fallback: string) => fallback

const em = {
  nativeUpdate: jest.fn(async (_entity: unknown, where: { id: string }, data: Partial<ConfigRow>) => {
    const row = store.configs.find((candidate) => candidate.id === where.id)
    if (row) Object.assign(row, data)
    return row ? 1 : 0
  }),
  insert: jest.fn(async (_entity: unknown, data: Omit<ConfigRow, 'id'>) => {
    store.configs.push({ id: randomUUID(), ...data })
  }),
} as unknown as EntityManager

const input = {
  receivableAccountId: RECEIVABLE,
  vatOutputAccountId: VAT,
  roundingAccountId: null,
  postingEnabled: true,
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  store.configs = []
  store.accounts = [
    { id: RECEIVABLE, tenantId: TENANT, organizationId: ORG_A, deletedAt: null },
    { id: VAT, tenantId: TENANT, organizationId: ORG_A, deletedAt: null },
    { id: ROUNDING, tenantId: TENANT, organizationId: ORG_A, deletedAt: null },
    { id: FOREIGN, tenantId: TENANT, organizationId: ORG_B, deletedAt: null },
  ]
})

describe('organizationConfigKey', () => {
  it('qualifies the setting name with the organization', () => {
    expect(organizationConfigKey('postingEnabled', ORG_A)).toBe(`postingEnabled:${ORG_A}`)
    expect(settingsLockKey(scopeA)).toBe(`sales_invoices_gl_posting:settings:${TENANT}:${ORG_A}`)
  })
})

describe('readSettingsSnapshot', () => {
  it('returns empty values and postingEnabled false before the first save', async () => {
    await expect(readSettingsSnapshot(em, scopeA)).resolves.toEqual({
      receivableAccountId: null,
      vatOutputAccountId: null,
      roundingAccountId: null,
      postingEnabled: false,
      updatedAt: null,
    })
  })
})

describe('saveSettings', () => {
  it('writes all four values with one timestamp, and a read after the save sees them', async () => {
    const invalidate = jest.fn(async () => undefined)
    const saved = await saveSettings(em, scopeA, input, null, { translate, invalidate })

    expect(mockLock).toHaveBeenCalledWith(em, settingsLockKey(scopeA), expect.any(Function))
    expect(store.configs).toHaveLength(4)
    expect(new Set(store.configs.map((row) => row.updatedAt.getTime())).size).toBe(1)
    expect(store.configs.every((row) => row.moduleId === SETTINGS_MODULE_ID && row.organizationId === ORG_A)).toBe(true)

    const snapshot = await readSettingsSnapshot(em, scopeA)
    expect(snapshot).toEqual({ ...input, updatedAt: saved.updatedAt })
    expect(invalidate.mock.calls.map((call) => call[1])).toEqual([
      `receivableAccountId:${ORG_A}`,
      `vatOutputAccountId:${ORG_A}`,
      `roundingAccountId:${ORG_A}`,
      `postingEnabled:${ORG_A}`,
    ])
  })

  it('keeps each organization apart', async () => {
    await saveSettings(em, scopeA, input, null, { translate })
    await expect(readSettingsSnapshot(em, scopeB)).resolves.toMatchObject({ receivableAccountId: null, postingEnabled: false })
  })

  it('assigns a version strictly greater than the previous one, even within the same millisecond', async () => {
    const fixed = new Date('2026-11-28T12:00:00.000Z').getTime()
    jest.spyOn(Date, 'now').mockReturnValue(fixed)
    const first = await saveSettings(em, scopeA, input, null, { translate })
    const second = await saveSettings(em, scopeA, { ...input, postingEnabled: false }, first.updatedAt!.toISOString(), { translate })
    expect(second.updatedAt!.getTime()).toBe(fixed + 1)
    await expect(readSettingsSnapshot(em, scopeA)).resolves.toMatchObject({ postingEnabled: false, updatedAt: second.updatedAt })
  })

  it('answers 409 for a stale version and writes nothing', async () => {
    const first = await saveSettings(em, scopeA, input, null, { translate })
    await saveSettings(em, scopeA, { ...input, postingEnabled: false }, first.updatedAt!.toISOString(), { translate })
    const before = JSON.stringify(store.configs)
    const invalidate = jest.fn(async () => undefined)

    await expect(
      saveSettings(em, scopeA, { ...input, roundingAccountId: ROUNDING }, first.updatedAt!.toISOString(), { translate, invalidate }),
    ).rejects.toMatchObject({ status: 409 })
    expect(JSON.stringify(store.configs)).toBe(before)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('answers 409 for a null version once settings exist', async () => {
    await saveSettings(em, scopeA, input, null, { translate })
    await expect(saveSettings(em, scopeA, input, null, { translate })).rejects.toMatchObject({ status: 409 })
  })

  it('answers 422 ACCOUNT_OUT_OF_SCOPE for an account of another organization or a deleted one', async () => {
    await expect(
      saveSettings(em, scopeA, { ...input, vatOutputAccountId: FOREIGN }, null, { translate }),
    ).rejects.toMatchObject({ status: 422, body: expect.objectContaining({ code: 'ACCOUNT_OUT_OF_SCOPE' }) })
    store.accounts = store.accounts.map((account) => (account.id === ROUNDING ? { ...account, deletedAt: new Date() } : account))
    await expect(
      saveSettings(em, scopeA, { ...input, roundingAccountId: ROUNDING }, null, { translate }),
    ).rejects.toMatchObject({ status: 422 })
    expect(store.configs).toHaveLength(0)
  })
})
