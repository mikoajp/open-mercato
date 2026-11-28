import type { EntityManager } from '@mikro-orm/postgresql'
import { ModuleConfig } from '@open-mercato/core/modules/configs/data/entities'
import { LedgerAccount } from '@open-mercato/core/modules/ledger/data/entities'
import { withAdvisoryXactLock } from '@open-mercato/shared/lib/db/advisoryLock'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { buildOptimisticLockConflictBody } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

export const SETTINGS_MODULE_ID = 'sales_invoices_gl_posting'
export const SETTINGS_RESOURCE_KIND = 'sales_invoices_gl_posting.settings'

export const SETTINGS_KEY_NAMES = [
  'receivableAccountId',
  'vatOutputAccountId',
  'roundingAccountId',
  'postingEnabled',
] as const

export type SettingsKeyName = (typeof SETTINGS_KEY_NAMES)[number]

export type SettingsScope = {
  tenantId: string
  organizationId: string
}

export type SalesInvoiceGlPostingSettings = {
  receivableAccountId: string | null
  vatOutputAccountId: string | null
  roundingAccountId: string | null
  postingEnabled: boolean
  updatedAt: Date | null
}

export type SalesInvoiceGlPostingSettingsInput = {
  receivableAccountId: string
  vatOutputAccountId: string
  roundingAccountId: string | null
  postingEnabled: boolean
}

export type ModuleConfigInvalidator = (moduleId: string, name: string, scope: SettingsScope) => Promise<void>

export type SaveSettingsOptions = {
  translate: (key: string, fallback: string) => string
  invalidate?: ModuleConfigInvalidator
}

/**
 * Builds the organization-qualified `ModuleConfig.name` for one setting.
 * `ModuleConfigService` keys rows by module, name and tenant only, so the
 * organization is part of the name to keep each organization's values apart.
 */
export function organizationConfigKey(name: SettingsKeyName, organizationId: string): string {
  return `${name}:${organizationId}`
}

export function settingsLockKey(scope: SettingsScope): string {
  return `${SETTINGS_MODULE_ID}:settings:${scope.tenantId}:${scope.organizationId}`
}

function qualifiedNames(organizationId: string): string[] {
  return SETTINGS_KEY_NAMES.map((name) => organizationConfigKey(name, organizationId))
}

async function loadSettingsRows(em: EntityManager, scope: SettingsScope): Promise<ModuleConfig[]> {
  return findWithDecryption(
    em,
    ModuleConfig,
    {
      moduleId: SETTINGS_MODULE_ID,
      tenantId: scope.tenantId,
      name: { $in: qualifiedNames(scope.organizationId) },
    },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toSettings(rows: ModuleConfig[], organizationId: string): SalesInvoiceGlPostingSettings {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const value = (name: SettingsKeyName) => byName.get(organizationConfigKey(name, organizationId))?.valueJson
  const newest = rows.reduce<Date | null>((latest, row) => {
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : null
    if (!updatedAt) return latest
    return !latest || updatedAt.getTime() > latest.getTime() ? updatedAt : latest
  }, null)
  return {
    receivableAccountId: readString(value('receivableAccountId')),
    vatOutputAccountId: readString(value('vatOutputAccountId')),
    roundingAccountId: readString(value('roundingAccountId')),
    postingEnabled: value('postingEnabled') === true,
    updatedAt: newest,
  }
}

/**
 * Reads the organization's four settings in one scoped query, so a caller
 * (the settings route or a posting) sees one committed snapshot.
 */
export async function readSettingsSnapshot(
  em: EntityManager,
  scope: SettingsScope,
): Promise<SalesInvoiceGlPostingSettings> {
  return toSettings(await loadSettingsRows(em, scope), scope.organizationId)
}

async function assertAccountsInScope(
  em: EntityManager,
  scope: SettingsScope,
  input: SalesInvoiceGlPostingSettingsInput,
  translate: SaveSettingsOptions['translate'],
): Promise<void> {
  const requested = [input.receivableAccountId, input.vatOutputAccountId, input.roundingAccountId]
    .filter((id): id is string => typeof id === 'string')
  const unique = Array.from(new Set(requested))
  const found = await findWithDecryption(
    em,
    LedgerAccount,
    { id: { $in: unique }, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    { fields: ['id'] },
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  const foundIds = new Set(found.map((account) => account.id))
  if (unique.some((id) => !foundIds.has(id))) {
    throw new CrudHttpError(422, {
      error: translate(
        'sales_invoices_gl_posting.errors.accountOutOfScope',
        'Each account must be an active ledger account of the selected organization.',
      ),
      code: 'ACCOUNT_OUT_OF_SCOPE',
    })
  }
}

function assertExpectedVersion(current: SalesInvoiceGlPostingSettings, rowCount: number, expected: string | null): void {
  if (expected === null) {
    if (rowCount === 0) return
    const currentIso = current.updatedAt ? current.updatedAt.toISOString() : ''
    throw new CrudHttpError(409, buildOptimisticLockConflictBody(currentIso, ''))
  }
  const expectedTime = Date.parse(expected)
  const currentTime = current.updatedAt ? current.updatedAt.getTime() : Number.NaN
  if (Number.isFinite(expectedTime) && expectedTime === currentTime) return
  throw new CrudHttpError(
    409,
    buildOptimisticLockConflictBody(current.updatedAt ? current.updatedAt.toISOString() : '', expected),
  )
}

function nextVersion(previous: Date | null): Date {
  const now = Date.now()
  const floor = previous ? previous.getTime() + 1 : 0
  return new Date(Math.max(now, floor))
}

function valueFor(name: SettingsKeyName, input: SalesInvoiceGlPostingSettingsInput): unknown {
  return input[name]
}

/**
 * Saves the four settings of one organization atomically. Inside a
 * transaction-scoped advisory lock (module, tenant, organization) it reads the
 * rows, compares their newest `updatedAt` with `expectedUpdatedAt` (`null`
 * requires that no row exists yet), validates the accounts and writes all four
 * values with one common timestamp strictly greater than the previous version.
 * Rows are written with native inserts and updates so the entity's `onUpdate`
 * hook cannot replace that timestamp. The four qualified keys are invalidated in
 * `ModuleConfigService` only after the lock transaction has committed.
 */
export async function saveSettings(
  em: EntityManager,
  scope: SettingsScope,
  input: SalesInvoiceGlPostingSettingsInput,
  expectedUpdatedAt: string | null,
  options: SaveSettingsOptions,
): Promise<SalesInvoiceGlPostingSettings> {
  const saved = await withAdvisoryXactLock(em, settingsLockKey(scope), async (txEm) => {
    const rows = await loadSettingsRows(txEm, scope)
    const current = toSettings(rows, scope.organizationId)
    assertExpectedVersion(current, rows.length, expectedUpdatedAt)
    await assertAccountsInScope(txEm, scope, input, options.translate)
    const version = nextVersion(current.updatedAt)
    const existing = new Map(rows.map((row) => [row.name, row]))
    for (const name of SETTINGS_KEY_NAMES) {
      const qualified = organizationConfigKey(name, scope.organizationId)
      const row = existing.get(qualified)
      if (row) {
        await txEm.nativeUpdate(ModuleConfig, { id: row.id }, { valueJson: valueFor(name, input), updatedAt: version })
      } else {
        await txEm.insert(ModuleConfig, {
          moduleId: SETTINGS_MODULE_ID,
          name: qualified,
          valueJson: valueFor(name, input),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          createdAt: version,
          updatedAt: version,
        })
      }
    }
    return { ...input, updatedAt: version }
  })
  if (options.invalidate) {
    for (const name of SETTINGS_KEY_NAMES) {
      await options.invalidate(SETTINGS_MODULE_ID, organizationConfigKey(name, scope.organizationId), scope)
    }
  }
  return saved
}
