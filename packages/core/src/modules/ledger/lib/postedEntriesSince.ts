import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { JournalEntry, JournalEntryLine, type JournalEntryType } from '../data/entities'
import type { PostedLine } from '../commands/postJournalEntry'

/**
 * Reconciliation read for `ledger.journal_entry.posted` consumers
 * (`.ai/specs/2026-08-18-general-ledger-core-engine.md`, Events → Delivery
 * contract, and Queries / API).
 *
 * Returns committed entries of one organization whose `sequenceNumber` is
 * greater than the caller's cursor, in ascending `sequenceNumber` order, with
 * their lines in the event payload shape and `REVERSAL` entries included. It
 * only reads: no event is emitted, nothing is queued and nothing is written.
 * Scope comes from the arguments, never from a caller's selected organization,
 * because consumers run it per organization outside a request.
 *
 * The cursor is safe within one organization: `sequenceNumber` is allocated by
 * the counter-row upsert in the posting transaction, which holds that row's
 * lock until commit, so a lower number cannot become visible after a higher one.
 */

export const POSTED_ENTRIES_SINCE_MAX_LIMIT = 100

export const listPostedEntriesSinceSchema = z.object({
  tenantId: z.uuid(),
  organizationId: z.uuid(),
  afterSequenceNumber: z.number().int().min(0),
  limit: z.number().int().min(1).max(POSTED_ENTRIES_SINCE_MAX_LIMIT).default(POSTED_ENTRIES_SINCE_MAX_LIMIT),
})

export type ListPostedEntriesSinceInput = z.input<typeof listPostedEntriesSinceSchema>

/** The second half of a consumer's idempotency key `(journalEntryId, kind)`. */
export type PostedEntryKind = 'post' | 'reversal'

export type PostedEntry = {
  journalEntryId: string
  sequenceNumber: number
  type: JournalEntryType
  kind: PostedEntryKind
  operationDate: string
  organizationId: string
  tenantId: string
  referenceType: string | null
  referenceId: string | null
  lines: PostedLine[]
}

export type PostedEntriesPage = {
  items: PostedEntry[]
  /** The cursor to pass next time: the last returned `sequenceNumber`, or the input cursor when nothing was returned. */
  nextAfterSequenceNumber: number
}

export function postedEntryKind(type: JournalEntryType): PostedEntryKind {
  return type === 'REVERSAL' ? 'reversal' : 'post'
}

function toDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function toPostedLineShape(line: JournalEntryLine): PostedLine {
  return {
    id: line.id,
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    currencyId: line.currencyId,
    exchangeRate: line.exchangeRate,
    amountCurrency: line.amountCurrency,
  }
}

export async function listPostedEntriesSince(
  em: EntityManager,
  input: ListPostedEntriesSinceInput,
): Promise<PostedEntriesPage> {
  const { tenantId, organizationId, afterSequenceNumber, limit } = listPostedEntriesSinceSchema.parse(input)
  const scope = { tenantId, organizationId }

  const entries = await findWithDecryption(
    em,
    JournalEntry,
    { ...scope, sequenceNumber: { $gt: afterSequenceNumber } },
    { orderBy: { sequenceNumber: 'ASC' }, limit },
    scope,
  )

  if (entries.length === 0) return { items: [], nextAfterSequenceNumber: afterSequenceNumber }

  const lines = await findWithDecryption(
    em,
    JournalEntryLine,
    { ...scope, journalEntryId: { $in: entries.map((entry) => entry.id) } },
    { orderBy: { id: 'ASC' } },
    scope,
  )
  const linesByEntry = new Map<string, PostedLine[]>()
  for (const line of lines) {
    const bucket = linesByEntry.get(line.journalEntryId) ?? []
    bucket.push(toPostedLineShape(line))
    linesByEntry.set(line.journalEntryId, bucket)
  }

  const items = entries.map((entry): PostedEntry => ({
    journalEntryId: entry.id,
    sequenceNumber: Number(entry.sequenceNumber),
    type: entry.type,
    kind: postedEntryKind(entry.type),
    operationDate: toDateString(entry.operationDate),
    organizationId: entry.organizationId,
    tenantId: entry.tenantId,
    referenceType: entry.referenceType ?? null,
    referenceId: entry.referenceId ?? null,
    lines: linesByEntry.get(entry.id) ?? [],
  }))

  return { items, nextAfterSequenceNumber: items[items.length - 1].sequenceNumber }
}
