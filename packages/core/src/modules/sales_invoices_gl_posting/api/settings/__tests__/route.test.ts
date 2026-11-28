import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

const mockAuth = jest.fn()
const mockScope = jest.fn()
const mockGuard = jest.fn()
const mockAfterSuccess = jest.fn()
const mockRead = jest.fn()
const mockSave = jest.fn()
const mockInvalidate = jest.fn()
const em = { name: 'em' }

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: () => mockAuth(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'moduleConfigService') return { invalidate: mockInvalidate }
      throw new Error(`[internal] unexpected ${name}`)
    },
  }),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: () => mockScope(),
}))

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => mockGuard(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback: string) => fallback }),
}))

jest.mock('../../../lib/moduleConfig', () => ({
  SETTINGS_RESOURCE_KIND: 'sales_invoices_gl_posting.settings',
  readSettingsSnapshot: (...args: unknown[]) => mockRead(...args),
  saveSettings: (...args: unknown[]) => mockSave(...args),
}))

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RECEIVABLE = '11111111-1111-4111-8111-111111111111'
const VAT = '22222222-2222-4222-8222-222222222222'
const VERSION = new Date('2026-11-28T12:00:00.000Z')

const body = {
  receivableAccountId: RECEIVABLE,
  vatOutputAccountId: VAT,
  roundingAccountId: null,
  postingEnabled: true,
  updatedAt: null,
}

function put(payload: unknown) {
  return new Request('http://localhost/api/sales_invoices_gl_posting/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function get() {
  return new Request('http://localhost/api/sales_invoices_gl_posting/settings')
}

beforeEach(() => {
  jest.resetAllMocks()
  mockAuth.mockResolvedValue({ sub: 'user-1', tenantId: TENANT, orgId: ORG })
  mockScope.mockResolvedValue({ selectedId: ORG, filterIds: [ORG], allowedIds: [ORG], tenantId: TENANT })
  mockGuard.mockResolvedValue({ ok: true, runAfterSuccess: mockAfterSuccess })
  mockRead.mockResolvedValue({
    receivableAccountId: RECEIVABLE,
    vatOutputAccountId: VAT,
    roundingAccountId: null,
    postingEnabled: false,
    updatedAt: VERSION,
  })
  mockSave.mockImplementation(async (_em, _scope, input) => ({ ...input, updatedAt: VERSION }))
})

describe('GET /api/sales_invoices_gl_posting/settings', () => {
  it('returns the selected organization settings with the version as an ISO string', async () => {
    const { GET } = await import('../route')
    const response = await GET(get())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      receivableAccountId: RECEIVABLE,
      vatOutputAccountId: VAT,
      roundingAccountId: null,
      postingEnabled: false,
      updatedAt: VERSION.toISOString(),
    })
    expect(mockRead).toHaveBeenCalledWith(em, { tenantId: TENANT, organizationId: ORG })
  })

  it('answers 401 without an authenticated tenant', async () => {
    mockAuth.mockResolvedValue(null)
    const { GET } = await import('../route')
    expect((await GET(get())).status).toBe(401)
  })

  it('answers 422 ORGANIZATION_REQUIRED without a selected organization', async () => {
    mockAuth.mockResolvedValue({ sub: 'user-1', tenantId: TENANT, orgId: null })
    mockScope.mockResolvedValue({ selectedId: null, filterIds: null, allowedIds: null, tenantId: TENANT })
    const { GET } = await import('../route')
    const response = await GET(get())
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'ORGANIZATION_REQUIRED' })
    expect(mockRead).not.toHaveBeenCalled()
  })

  it('answers 403 for an organization outside the authorized filter', async () => {
    mockScope.mockResolvedValue({ selectedId: OTHER_ORG, filterIds: [ORG], allowedIds: [ORG], tenantId: TENANT })
    const { GET } = await import('../route')
    expect((await GET(get())).status).toBe(403)
    expect(mockRead).not.toHaveBeenCalled()
  })
})

describe('PUT /api/sales_invoices_gl_posting/settings', () => {
  it('saves through the module config library, invalidates through the config service and runs the guard callbacks', async () => {
    const { PUT } = await import('../route')
    const response = await PUT(put(body))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ postingEnabled: true, updatedAt: VERSION.toISOString() })

    const [, scope, input, expected, options] = mockSave.mock.calls[0]
    expect(scope).toEqual({ tenantId: TENANT, organizationId: ORG })
    expect(input).toEqual({ receivableAccountId: RECEIVABLE, vatOutputAccountId: VAT, roundingAccountId: null, postingEnabled: true })
    expect(expected).toBeNull()
    await options.invalidate('sales_invoices_gl_posting', `postingEnabled:${ORG}`, scope)
    expect(mockInvalidate).toHaveBeenCalledWith('sales_invoices_gl_posting', `postingEnabled:${ORG}`, scope)

    expect(mockGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ userId: 'user-1', tenantId: TENANT, organizationId: ORG }),
        input: expect.objectContaining({ resourceKind: 'sales_invoices_gl_posting.settings', resourceId: ORG, operation: 'update' }),
      }),
    )
    expect(mockAfterSuccess).toHaveBeenCalledTimes(1)
  })

  it('answers 400 for an invalid body and does not save', async () => {
    const { PUT } = await import('../route')
    const response = await PUT(put({ ...body, receivableAccountId: 'not-a-uuid' }))
    expect(response.status).toBe(400)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('returns the guard rejection and does not save', async () => {
    mockGuard.mockResolvedValue({
      ok: false,
      errorStatus: 423,
      errorBody: { error: 'Locked' },
      response: new Response(JSON.stringify({ error: 'Locked' }), { status: 423 }),
    })
    const { PUT } = await import('../route')
    const response = await PUT(put(body))
    expect(response.status).toBe(423)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('saves the payload a guard modified, re-validated against the schema', async () => {
    mockGuard.mockResolvedValue({ ok: true, runAfterSuccess: mockAfterSuccess, modifiedPayload: { postingEnabled: false } })
    const { PUT } = await import('../route')
    expect((await PUT(put(body))).status).toBe(200)
    expect(mockSave.mock.calls[0][2]).toMatchObject({ postingEnabled: false })
  })

  it('passes through a version conflict and an account outside the organization', async () => {
    const { PUT } = await import('../route')
    mockSave.mockRejectedValueOnce(new CrudHttpError(409, { error: 'conflict', code: 'optimistic_lock_conflict' }))
    expect((await PUT(put({ ...body, updatedAt: VERSION.toISOString() }))).status).toBe(409)
    mockSave.mockRejectedValueOnce(new CrudHttpError(422, { error: 'out of scope', code: 'ACCOUNT_OUT_OF_SCOPE' }))
    const response = await PUT(put(body))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_OUT_OF_SCOPE' })
    expect(mockAfterSuccess).not.toHaveBeenCalled()
  })
})
