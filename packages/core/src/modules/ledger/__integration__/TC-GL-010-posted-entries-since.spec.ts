import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { asValue, createContainer } from 'awilix'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver, type EntityManager } from '@mikro-orm/postgresql'
import { Currency } from '@open-mercato/core/modules/currencies/data/entities'
import { commandRegistry, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import {
  resolveIntegrationDatabaseUrl,
  withClient,
  type IntegrationDbClient,
} from '@open-mercato/core/helpers/integration/dbFixtures'
import '@open-mercato/core/modules/ledger/commands/postJournalEntry'
import '@open-mercato/core/modules/ledger/commands/reverseJournalEntry'
import type { PostJournalEntryResult } from '@open-mercato/core/modules/ledger/commands/postJournalEntry'
import {
  FiscalPeriod, JournalEntry, JournalEntryLine, JournalEntrySequence, LedgerAccount,
} from '@open-mercato/core/modules/ledger/data/entities'
import {
  listPostedEntriesSince,
  type PostedEntry,
} from '@open-mercato/core/modules/ledger/lib/postedEntriesSince'
import { Migration20260922093649 } from '@open-mercato/core/modules/ledger/migrations/Migration20260922093649'
import { Migration20261012120000 } from '@open-mercato/core/modules/ledger/migrations/Migration20261012120000'
import { Migration20261013090000 } from '@open-mercato/core/modules/ledger/migrations/Migration20261013090000'
import { Migration20261023110000 } from '@open-mercato/core/modules/ledger/migrations/Migration20261023110000'
import { Migration20261029120000 } from '@open-mercato/core/modules/ledger/migrations/Migration20261029120000'

/**
 * TC-GL-010: `listPostedEntriesSince`, the reconciliation read behind the
 * at-least-once contract of `ledger.journal_entry.posted`
 * (`.ai/specs/2026-08-18-general-ledger-core-engine.md`, Events → Delivery
 * contract), against real Postgres and the real posting and reversal
 * commands, in a disposable schema like TC-GL-007.
 *
 * The second test checks the cursor-safety claim the contract rests on: a
 * posting holds the `journal_entry_sequences` counter row from its upsert
 * until commit, so the next posting in the same organization waits, and a
 * reader never sees sequence N+1 committed while N is still in flight.
 */

const WAIT_MS = 1500

const migrations = [
  Migration20260922093649,
  Migration20261012120000,
  Migration20261013090000,
  Migration20261023110000,
  Migration20261029120000,
]

async function migrateUp(client: IntegrationDbClient) {
  for (const MigrationClass of migrations) {
    const statements: string[] = []
    const migration = Object.create(MigrationClass.prototype) as { up(): Promise<void> }
    Object.defineProperty(migration, 'addSql', { value: (statement: string) => statements.push(statement) })
    await migration.up()
    for (const statement of statements) await client.query(statement)
  }
}

async function executeLedgerCommand(
  commandId: 'ledger.postJournalEntry' | 'ledger.reverseJournalEntry',
  input: unknown,
  ctx: CommandRuntimeContext,
): Promise<PostJournalEntryResult> {
  const command = commandRegistry.get<unknown, PostJournalEntryResult>(commandId)
  if (!command) throw new Error(`[internal] Ledger command ${commandId} is missing`)
  return command.execute(input, ctx)
}

type Scope = { tenantId: string; organizationId: string }
type OrgFixture = { scope: Scope; ctx: CommandRuntimeContext; postInput: (amount: string, day: string) => Record<string, unknown> }

async function seedOrganization(em: EntityManager, tenantId: string): Promise<OrgFixture> {
  const scope = { tenantId, organizationId: randomUUID() }
  const timestamps = { createdAt: new Date(), updatedAt: new Date() }
  const currency = em.create(Currency, {
    ...scope, ...timestamps, code: 'PLN', name: 'Polish złoty', isBase: true, isActive: true, decimalPlaces: 2,
  })
  em.create(FiscalPeriod, {
    ...scope, ...timestamps, startDate: new Date('2034-01-01'), endDate: new Date('2034-01-31'), isLocked: false,
  })
  const accountTypeId = randomUUID()
  const debit = em.create(LedgerAccount, { ...scope, ...timestamps, accountTypeId, number: '100' })
  const credit = em.create(LedgerAccount, { ...scope, ...timestamps, accountTypeId, number: '200' })
  await em.flush()
  const ctx: CommandRuntimeContext = {
    container: createContainer().register({ em: asValue(em) }),
    auth: { sub: randomUUID(), tenantId: scope.tenantId, orgId: scope.organizationId },
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
  const postInput = (amount: string, day: string) => ({
    ...scope,
    operationDate: `2034-01-${day}`,
    currencyId: currency.id,
    description: `QA posting ${amount}`,
    referenceType: 'qa_document',
    referenceId: randomUUID(),
    lines: [
      { accountId: debit.id, debit: amount },
      { accountId: credit.id, credit: amount },
    ],
  })
  return { scope, ctx, postInput }
}

async function withDisposableLedgerSchema(run: (orm: MikroORM<PostgreSqlDriver>) => Promise<void>) {
  const schema = `ledger_test_${randomUUID().replaceAll('-', '')}`
  let orm: MikroORM<PostgreSqlDriver> | undefined
  let schemaCreated = false
  try {
    await withClient(async (client) => {
      await client.query('begin')
      await client.query(`create schema "${schema}"`)
      await client.query(`set local search_path to "${schema}", pg_catalog`)
      await migrateUp(client)
      await client.query('create table currencies (like public.currencies including all)')
      await client.query('commit')
      schemaCreated = true
    })
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: resolveIntegrationDatabaseUrl(),
      driverOptions: { options: `-c search_path=${schema},pg_catalog` },
      schema,
      entities: [Currency, FiscalPeriod, JournalEntry, JournalEntryLine, JournalEntrySequence, LedgerAccount],
    })
    const searchPath = await orm.em.fork().execute<Array<{ schema_name: string }>>('select current_schema as schema_name')
    expect(searchPath[0]?.schema_name).toBe(schema)
    await run(orm)
  } finally {
    await orm?.close(true)
    if (schemaCreated) await withClient((client) => client.query(`drop schema if exists "${schema}" cascade`))
  }
}

function keys(items: PostedEntry[]): string[] {
  return items.map((item) => `${item.journalEntryId}:${item.kind}`)
}

test('reads posted and reversed entries per organization, ascending, from a cursor', async () => {
  await withDisposableLedgerSchema(async (orm) => {
    const tenantId = randomUUID()
    const orgA = await seedOrganization(orm.em.fork(), tenantId)
    const orgB = await seedOrganization(orm.em.fork(), tenantId)

    const a1 = await executeLedgerCommand('ledger.postJournalEntry', orgA.postInput('10', '10'), orgA.ctx)
    const b1 = await executeLedgerCommand('ledger.postJournalEntry', orgB.postInput('11', '10'), orgB.ctx)
    const a2 = await executeLedgerCommand('ledger.postJournalEntry', orgA.postInput('12', '11'), orgA.ctx)
    const a3 = await executeLedgerCommand(
      'ledger.reverseJournalEntry',
      { ...orgA.scope, operationDate: '2034-01-12', journalEntryId: a1.journalEntryId },
      orgA.ctx,
    )
    const b2 = await executeLedgerCommand('ledger.postJournalEntry', orgB.postInput('13', '12'), orgB.ctx)
    expect([a1, a2, a3].map((result) => result.sequenceNumber)).toEqual([1, 2, 3])
    expect([b1, b2].map((result) => result.sequenceNumber)).toEqual([1, 2])

    const reader = orm.em.fork()
    const pageA = await listPostedEntriesSince(reader, { ...orgA.scope, afterSequenceNumber: 0 })
    expect(pageA.items.map((item) => item.sequenceNumber)).toEqual([1, 2, 3])
    expect(pageA.nextAfterSequenceNumber).toBe(3)
    expect(pageA.items.every((item) => item.organizationId === orgA.scope.organizationId && item.tenantId === tenantId)).toBe(true)
    expect(keys(pageA.items)).toEqual([
      `${a1.journalEntryId}:post`,
      `${a2.journalEntryId}:post`,
      `${a3.journalEntryId}:reversal`,
    ])
    expect(pageA.items.filter((item) => item.type === 'REVERSAL')).toHaveLength(1)
    expect(pageA.items[2]).toEqual(expect.objectContaining({
      type: 'REVERSAL',
      referenceType: 'journal_entry',
      referenceId: a1.journalEntryId,
      operationDate: '2034-01-12',
    }))
    expect(pageA.items[0].lines).toHaveLength(2)
    expect(pageA.items[0].lines.map((line) => line.id).sort()).toEqual(a1.lines.map((line) => line.id).sort())
    for (const line of pageA.items[0].lines) {
      const posted = a1.lines.find((candidate) => candidate.id === line.id)!
      expect(Object.keys(line).sort()).toEqual(Object.keys(posted).sort())
      expect({ accountId: line.accountId, currencyId: line.currencyId }).toEqual({
        accountId: posted.accountId,
        currencyId: posted.currencyId,
      })
      for (const field of ['debit', 'credit', 'exchangeRate', 'amountCurrency'] as const) {
        expect(Number(line[field]), field).toBe(Number(posted[field]))
      }
    }
    expect(pageA.items[0].lines.find((line) => Number(line.debit) > 0)).toEqual(
      expect.objectContaining({ debit: '10.0000', credit: '0.0000', exchangeRate: '1.00000000', amountCurrency: '10.0000' }),
    )
    expect(pageA.items[2].lines.map((line) => [line.debit, line.credit]).sort()).toEqual(
      a3.lines.map((line) => [line.debit, line.credit]).sort(),
    )

    const pageB = await listPostedEntriesSince(reader, { ...orgB.scope, afterSequenceNumber: 1 })
    expect(keys(pageB.items)).toEqual([`${b2.journalEntryId}:post`])

    const paged = await listPostedEntriesSince(reader, { ...orgA.scope, afterSequenceNumber: 1, limit: 1 })
    expect(keys(paged.items)).toEqual([`${a2.journalEntryId}:post`])
    expect(paged.nextAfterSequenceNumber).toBe(2)

    const replay = await listPostedEntriesSince(reader, { ...orgA.scope, afterSequenceNumber: 1 })
    expect(replay.items).toEqual(pageA.items.slice(1))

    const drained = await listPostedEntriesSince(reader, { ...orgA.scope, afterSequenceNumber: pageA.nextAfterSequenceNumber })
    expect(drained).toEqual({ items: [], nextAfterSequenceNumber: 3 })

    const otherTenant = await listPostedEntriesSince(reader, {
      tenantId: randomUUID(),
      organizationId: orgA.scope.organizationId,
      afterSequenceNumber: 0,
    })
    expect(otherTenant.items).toEqual([])

    const counts = await withClient((client) => client.query<{ entries: string; sequences: string }>(
      `select (select count(*) from "${orm.config.get('schema')}".journal_entries) as entries,
              (select count(*) from "${orm.config.get('schema')}".journal_entry_sequences) as sequences`,
    ))
    expect(counts.rows[0]).toEqual({ entries: '5', sequences: '2' })
  })
})

test('a posting in flight holds the sequence counter until commit, so the cursor never skips it', async () => {
  test.setTimeout(30_000)
  await withDisposableLedgerSchema(async (orm) => {
    const org = await seedOrganization(orm.em.fork(), randomUUID())
    const first = await executeLedgerCommand('ledger.postJournalEntry', org.postInput('10', '10'), org.ctx)
    expect(first.sequenceNumber).toBe(1)

    let secondSettled = false
    let second: Promise<PostJournalEntryResult> | undefined
    let inFlightSequence = 0
    await orm.em.fork().transactional(async (trx) => {
      const inFlight = await executeLedgerCommand(
        'ledger.postJournalEntry',
        org.postInput('20', '11'),
        { ...org.ctx, transactionalEm: trx },
      )
      inFlightSequence = inFlight.sequenceNumber
      expect(inFlightSequence).toBe(2)

      second = executeLedgerCommand('ledger.postJournalEntry', org.postInput('30', '12'), org.ctx)
      second.then(() => { secondSettled = true }, () => { secondSettled = true })
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
      expect(secondSettled, 'the next posting must wait on the counter row lock').toBe(false)
      const waiting = await withClient((client) => client.query<{ waiting: string }>(
        `select count(*) as waiting from pg_stat_activity
         where wait_event_type = 'Lock' and query ilike '%insert into journal_entry_sequences%'`,
      ))
      expect(Number(waiting.rows[0]?.waiting)).toBe(1)

      const whileOpen = await listPostedEntriesSince(orm.em.fork(), { ...org.scope, afterSequenceNumber: 0 })
      expect(whileOpen.items.map((item) => item.sequenceNumber)).toEqual([1])
      expect(whileOpen.nextAfterSequenceNumber).toBe(1)
    })

    const secondResult = await second!
    expect(secondResult.sequenceNumber).toBe(3)

    const afterCommit = await listPostedEntriesSince(orm.em.fork(), { ...org.scope, afterSequenceNumber: 1 })
    expect(afterCommit.items.map((item) => item.sequenceNumber)).toEqual([2, 3])
  })
})
