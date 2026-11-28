import { postSalesInvoiceToLedgerSchema, settingsUpdateSchema } from '../validators'

const INVOICE = '11111111-1111-4111-8111-111111111111'
const LINE_A = '22222222-2222-4222-8222-222222222222'
const LINE_B = '33333333-3333-4333-8333-333333333333'
const ACCOUNT = '44444444-4444-4444-8444-444444444444'
const CONTRACTOR = '55555555-5555-4555-8555-555555555555'

describe('postSalesInvoiceToLedgerSchema', () => {
  it('accepts an invoice with one account per line and no contractor', () => {
    const parsed = postSalesInvoiceToLedgerSchema.parse({
      salesInvoiceId: INVOICE,
      lineAccounts: [
        { salesInvoiceLineId: LINE_A, accountId: ACCOUNT },
        { salesInvoiceLineId: LINE_B, accountId: ACCOUNT },
      ],
    })
    expect(parsed.contractorId).toBeUndefined()
    expect(parsed.lineAccounts).toHaveLength(2)
  })

  it('accepts an explicit contractor id', () => {
    const parsed = postSalesInvoiceToLedgerSchema.parse({
      salesInvoiceId: INVOICE,
      lineAccounts: [{ salesInvoiceLineId: LINE_A, accountId: ACCOUNT }],
      contractorId: CONTRACTOR,
    })
    expect(parsed.contractorId).toBe(CONTRACTOR)
  })

  it.each([
    ['a non-uuid invoice id', { salesInvoiceId: 'invoice-1', lineAccounts: [] }],
    ['a non-uuid line id', { salesInvoiceId: INVOICE, lineAccounts: [{ salesInvoiceLineId: 'line', accountId: ACCOUNT }] }],
    ['a non-uuid account id', { salesInvoiceId: INVOICE, lineAccounts: [{ salesInvoiceLineId: LINE_A, accountId: '401-01' }] }],
    ['a non-uuid contractor id', { salesInvoiceId: INVOICE, lineAccounts: [], contractorId: 'nip-123' }],
    ['a missing assignment list', { salesInvoiceId: INVOICE }],
  ])('rejects %s', (_label, input) => {
    expect(postSalesInvoiceToLedgerSchema.safeParse(input).success).toBe(false)
  })

  it('leaves empty and duplicated assignments to the command, which answers them with 422', () => {
    expect(postSalesInvoiceToLedgerSchema.safeParse({ salesInvoiceId: INVOICE, lineAccounts: [] }).success).toBe(true)
    expect(
      postSalesInvoiceToLedgerSchema.safeParse({
        salesInvoiceId: INVOICE,
        lineAccounts: [
          { salesInvoiceLineId: LINE_A, accountId: ACCOUNT },
          { salesInvoiceLineId: LINE_A, accountId: ACCOUNT },
        ],
      }).success,
    ).toBe(true)
  })
})

describe('settingsUpdateSchema', () => {
  const valid = {
    receivableAccountId: ACCOUNT,
    vatOutputAccountId: LINE_A,
    roundingAccountId: null,
    postingEnabled: true,
    updatedAt: null,
  }

  it('accepts both required accounts, a null rounding account and a null first version', () => {
    expect(settingsUpdateSchema.parse(valid)).toEqual(valid)
  })

  it('rejects turning posting on without the required accounts', () => {
    const { receivableAccountId: _omitted, ...withoutReceivable } = valid
    expect(settingsUpdateSchema.safeParse(withoutReceivable).success).toBe(false)
  })

  it('requires an explicit boolean for postingEnabled and an explicit version field', () => {
    expect(settingsUpdateSchema.safeParse({ ...valid, postingEnabled: 'true' }).success).toBe(false)
    const { updatedAt: _version, ...withoutVersion } = valid
    expect(settingsUpdateSchema.safeParse(withoutVersion).success).toBe(false)
  })
})
