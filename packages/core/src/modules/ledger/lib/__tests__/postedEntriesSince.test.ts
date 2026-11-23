export {}

import { JournalEntry, JournalEntryLine } from '../../data/entities'
import {
  listPostedEntriesSince,
  postedEntryKind,
  type PostedEntry,
} from '../postedEntriesSince'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(
    (em: { find: (...args: unknown[]) => unknown }, entity: unknown, where: unknown, options: unknown) =>
      em.find(entity, where, options),
  ),
}))

const TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_DEBIT = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_CREDIT = '55555555-5555-4555-8555-555555555555'
const PLN = '66666666-6666-4666-8666-666666666666'

type Row = Record<string, unknown>

function entryId(org: string, sequence: number, tenant = TENANT): string {
  const orgDigit = org === ORG_A ? 'a' : 'b'
  const tenantDigit = tenant === TENANT ? '1' : '2'
  return `${orgDigit}${tenantDigit}000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function buildEntry(org: string, sequence: number, overrides: Row = {}): Row {
  const tenant = (overrides.tenantId as string | undefined) ?? TENANT
  return {
    id: entryId(org, sequence, tenant),
    organizationId: org,
    tenantId: tenant,
    sequenceNumber: sequence,
    operationDate: new Date('2026-11-20T00:00:00.000Z'),
    type: 'NORMAL',
    referenceType: null,
    referenceId: null,
    ...overrides,
  }
}

function buildLines(entry: Row): Row[] {
  return [
    {
      id: `${String(entry.id).slice(0, 35)}2`,
      organizationId: entry.organizationId,
      tenantId: entry.tenantId,
      journalEntryId: entry.id,
      accountId: ACCOUNT_CREDIT,
      debit: '0.0000',
      credit: '100.0000',
      currencyId: PLN,
      exchangeRate: '1.00000000',
      amountCurrency: '100.0000',
    },
    {
      id: `${String(entry.id).slice(0, 35)}1`,
      organizationId: entry.organizationId,
      tenantId: entry.tenantId,
      journalEntryId: entry.id,
      accountId: ACCOUNT_DEBIT,
      debit: '100.0000',
      credit: '0.0000',
      currencyId: PLN,
      exchangeRate: '1.00000000',
      amountCurrency: '100.0000',
    },
  ]
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key]
    if (condition && typeof condition === 'object') {
      const operators = condition as Row
      if ('$in' in operators) return (operators.$in as unknown[]).includes(value)
      if ('$gt' in operators) return Number(value) > Number(operators.$gt)
      return false
    }
    return value === condition
  })
}

function buildEm(entries: Row[]) {
  const lines = entries.flatMap(buildLines)
  const tables = new Map<unknown, Row[]>([
    [JournalEntry, entries],
    [JournalEntryLine, lines],
  ])
  const find = jest.fn(async (entity: unknown, where: Row, options?: { orderBy?: Record<string, 'ASC' | 'DESC'>; limit?: number }) => {
    const rows = (tables.get(entity) ?? []).filter((row) => matches(row, where))
    const [orderKey, direction] = Object.entries(options?.orderBy ?? {})[0] ?? []
    if (orderKey) {
      rows.sort((left, right) => {
        const leftValue = left[orderKey] as string | number
        const rightValue = right[orderKey] as string | number
        const compared = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
        return direction === 'DESC' ? -compared : compared
      })
    }
    return options?.limit ? rows.slice(0, options.limit) : rows
  })
  const writes = {
    persist: jest.fn(),
    flush: jest.fn(),
    create: jest.fn(),
    execute: jest.fn(),
    getConnection: jest.fn(),
    transactional: jest.fn(),
  }
  return { em: { find, ...writes } as never, find, writes }
}

function idempotencyKey(item: PostedEntry): string {
  return `${item.journalEntryId}:${item.kind}`
}

describe('postedEntryKind', () => {
  it('maps REVERSAL to reversal and every other type to post', () => {
    expect(postedEntryKind('REVERSAL')).toBe('reversal')
    expect(postedEntryKind('NORMAL')).toBe('post')
    expect(postedEntryKind('OPENING')).toBe('post')
    expect(postedEntryKind('CLOSING')).toBe('post')
  })
})

describe('listPostedEntriesSince', () => {
  it('returns entries in ascending sequenceNumber order, with lines in the posted event payload shape', async () => {
    const { em } = buildEm([
      buildEntry(ORG_A, 3, { referenceType: 'sales_invoice', referenceId: 'inv-3' }),
      buildEntry(ORG_A, 1),
      buildEntry(ORG_A, 2, { type: 'OPENING' }),
    ])

    const page = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0 })

    expect(page.items.map((item) => item.sequenceNumber)).toEqual([1, 2, 3])
    expect(page.nextAfterSequenceNumber).toBe(3)
    expect(page.items[2]).toEqual({
      journalEntryId: entryId(ORG_A, 3),
      sequenceNumber: 3,
      type: 'NORMAL',
      kind: 'post',
      operationDate: '2026-11-20',
      organizationId: ORG_A,
      tenantId: TENANT,
      referenceType: 'sales_invoice',
      referenceId: 'inv-3',
      lines: [
        {
          id: `${entryId(ORG_A, 3).slice(0, 35)}1`,
          accountId: ACCOUNT_DEBIT,
          debit: '100.0000',
          credit: '0.0000',
          currencyId: PLN,
          exchangeRate: '1.00000000',
          amountCurrency: '100.0000',
        },
        {
          id: `${entryId(ORG_A, 3).slice(0, 35)}2`,
          accountId: ACCOUNT_CREDIT,
          debit: '0.0000',
          credit: '100.0000',
          currencyId: PLN,
          exchangeRate: '1.00000000',
          amountCurrency: '100.0000',
        },
      ],
    })
    expect(page.items[1].kind).toBe('post')
  })

  it('pages by limit and resumes from the returned cursor', async () => {
    const { em } = buildEm([1, 2, 3, 4, 5].map((sequence) => buildEntry(ORG_A, sequence)))

    const first = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0, limit: 2 })
    const second = await listPostedEntriesSince(em, {
      tenantId: TENANT,
      organizationId: ORG_A,
      afterSequenceNumber: first.nextAfterSequenceNumber,
      limit: 2,
    })

    expect(first.items.map((item) => item.sequenceNumber)).toEqual([1, 2])
    expect(second.items.map((item) => item.sequenceNumber)).toEqual([3, 4])
  })

  it('keeps the cursor per organization and tenant: another scope with the same sequence numbers never leaks in', async () => {
    const { em, find } = buildEm([
      buildEntry(ORG_A, 1),
      buildEntry(ORG_B, 1),
      buildEntry(ORG_A, 2),
      buildEntry(ORG_B, 2),
      buildEntry(ORG_B, 3),
      buildEntry(ORG_A, 3),
      buildEntry(ORG_A, 4, { tenantId: OTHER_TENANT }),
    ])

    const orgA = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 1 })
    const orgB = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_B, afterSequenceNumber: 2 })

    expect(orgA.items.map((item) => [item.organizationId, item.sequenceNumber])).toEqual([
      [ORG_A, 2],
      [ORG_A, 3],
    ])
    expect(orgB.items.map((item) => [item.organizationId, item.sequenceNumber])).toEqual([[ORG_B, 3]])
    expect([...orgA.items, ...orgB.items].every((item) => item.tenantId === TENANT)).toBe(true)
    for (const [, where] of find.mock.calls) {
      expect(where).toEqual(expect.objectContaining({ tenantId: TENANT }))
      expect([ORG_A, ORG_B]).toContain((where as Row).organizationId)
    }
  })

  it('lets a consumer stay idempotent by (journalEntryId, kind) when it re-reads from an older cursor', async () => {
    const { em } = buildEm([
      buildEntry(ORG_A, 1),
      buildEntry(ORG_A, 2),
      buildEntry(ORG_A, 3, { type: 'REVERSAL' }),
    ])
    const handled = new Set<string>()
    const applied: string[] = []
    const consume = (items: PostedEntry[]) => {
      for (const item of items) {
        const key = idempotencyKey(item)
        if (handled.has(key)) continue
        handled.add(key)
        applied.push(key)
      }
    }

    const firstRun = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0 })
    consume(firstRun.items)
    const replay = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 1 })
    consume(replay.items)

    expect(replay.items).toEqual(firstRun.items.slice(1))
    expect(applied).toEqual([
      `${entryId(ORG_A, 1)}:post`,
      `${entryId(ORG_A, 2)}:post`,
      `${entryId(ORG_A, 3)}:reversal`,
    ])
  })

  it('returns a reversed entry once as post and its REVERSAL once as reversal, without repeating the original', async () => {
    const original = buildEntry(ORG_A, 1)
    const reversal = buildEntry(ORG_A, 2, {
      type: 'REVERSAL',
      referenceType: 'ledger.journal_entry',
      referenceId: original.id,
    })
    const { em } = buildEm([original, reversal])

    const page = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0 })
    const keys = page.items.map(idempotencyKey)

    expect(keys).toEqual([`${original.id}:post`, `${reversal.id}:reversal`])
    expect(new Set(keys).size).toBe(keys.length)
    expect(page.items.filter((item) => item.type === 'REVERSAL')).toHaveLength(1)
    expect(page.items[1]).toEqual(
      expect.objectContaining({ referenceType: 'ledger.journal_entry', referenceId: original.id, kind: 'reversal' }),
    )

    const afterOriginal = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 1 })
    expect(afterOriginal.items.map(idempotencyKey)).toEqual([`${reversal.id}:reversal`])
  })

  it('returns an empty page and keeps the cursor after the last entry, without loading lines', async () => {
    const { em, find } = buildEm([buildEntry(ORG_A, 1), buildEntry(ORG_A, 2)])

    const page = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 2 })

    expect(page).toEqual({ items: [], nextAfterSequenceNumber: 2 })
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0][0]).toBe(JournalEntry)
  })

  it('only reads: no write, raw SQL or transaction is touched', async () => {
    const { em, writes } = buildEm([buildEntry(ORG_A, 1)])

    await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0 })

    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled()
  })

  it('passes ascending order and the limit to the query', async () => {
    const { em, find } = buildEm([buildEntry(ORG_A, 1)])

    await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0, limit: 7 })

    expect(find.mock.calls[0][1]).toEqual({ tenantId: TENANT, organizationId: ORG_A, sequenceNumber: { $gt: 0 } })
    expect(find.mock.calls[0][2]).toEqual({ orderBy: { sequenceNumber: 'ASC' }, limit: 7 })
    expect(find.mock.calls[1][1]).toEqual(
      expect.objectContaining({ tenantId: TENANT, organizationId: ORG_A, journalEntryId: { $in: [entryId(ORG_A, 1)] } }),
    )
  })

  it.each([
    ['a non-uuid organization', { tenantId: TENANT, organizationId: 'org-a', afterSequenceNumber: 0 }],
    ['a non-uuid tenant', { tenantId: 'tenant', organizationId: ORG_A, afterSequenceNumber: 0 }],
    ['a negative cursor', { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: -1 }],
    ['a fractional cursor', { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 1.5 }],
    ['a limit above 100', { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0, limit: 101 }],
    ['a zero limit', { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0, limit: 0 }],
  ])('rejects %s before querying', async (_label, input) => {
    const { em, find } = buildEm([buildEntry(ORG_A, 1)])

    await expect(listPostedEntriesSince(em, input)).rejects.toThrow()
    expect(find).not.toHaveBeenCalled()
  })

  it('defaults the limit to 100', async () => {
    const { em, find } = buildEm(Array.from({ length: 120 }, (_, index) => buildEntry(ORG_A, index + 1)))

    const page = await listPostedEntriesSince(em, { tenantId: TENANT, organizationId: ORG_A, afterSequenceNumber: 0 })

    expect(find.mock.calls[0][2]).toEqual({ orderBy: { sequenceNumber: 'ASC' }, limit: 100 })
    expect(page.items).toHaveLength(100)
    expect(page.nextAfterSequenceNumber).toBe(100)
  })
})
