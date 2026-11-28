/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'

type CapturedProps = {
  optimisticLockUpdatedAt?: string | null
  initialValues: Record<string, unknown>
  groups: Array<{ fields: Array<{ id: string; type: string; required?: boolean }> }>
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}

const captured: { props: CapturedProps | null } = { props: null }
const mockApiCall = jest.fn()
const mockUpdateCrud = jest.fn()
const mockFlash = jest.fn()

const mockTranslate = (_key: string, fallback: string) => fallback

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 1,
}))

jest.mock('@open-mercato/ui/backend/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <div>{label}</div>,
  ErrorMessage: ({ label }: { label: string }) => <div role="alert">{label}</div>,
}))

jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: (props: CapturedProps) => {
    captured.props = props
    return <div data-testid="crud-form" />
  },
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
}))

jest.mock('@open-mercato/ui/backend/utils/crud', () => ({
  updateCrud: (...args: unknown[]) => mockUpdateCrud(...args),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: (...args: unknown[]) => mockFlash(...args),
}))

jest.mock('@open-mercato/core/modules/ledger/backend/lib/optionLoaders', () => ({
  loadLedgerAccountOptions: async () => [],
}))

import SalesInvoiceGlPostingSettingsPage from '../page'

const RECEIVABLE = '11111111-1111-4111-8111-111111111111'
const VAT = '22222222-2222-4222-8222-222222222222'
const VERSION = '2026-11-28T12:00:00.000Z'
const NEXT_VERSION = '2026-11-28T12:05:00.000Z'

beforeEach(() => {
  jest.resetAllMocks()
  captured.props = null
})

it('loads the settings into the form with the version and saves the four fields with it', async () => {
  mockApiCall.mockResolvedValue({
    ok: true,
    result: { receivableAccountId: RECEIVABLE, vatOutputAccountId: VAT, roundingAccountId: null, postingEnabled: false, updatedAt: VERSION },
  })
  mockUpdateCrud.mockResolvedValue({
    ok: true,
    result: { receivableAccountId: RECEIVABLE, vatOutputAccountId: VAT, roundingAccountId: null, postingEnabled: true, updatedAt: NEXT_VERSION },
  })

  render(<SalesInvoiceGlPostingSettingsPage />)
  await waitFor(() => expect(screen.getByTestId('crud-form')).toBeTruthy())

  const props = captured.props!
  expect(mockApiCall).toHaveBeenCalledWith('/api/sales_invoices_gl_posting/settings')
  expect(props.optimisticLockUpdatedAt).toBe(VERSION)
  expect(props.initialValues).toEqual({
    receivableAccountId: RECEIVABLE,
    vatOutputAccountId: VAT,
    roundingAccountId: '',
    postingEnabled: false,
  })
  const fields = props.groups.flatMap((group) => group.fields)
  expect(fields.map((field) => [field.id, field.type, field.required === true])).toEqual([
    ['receivableAccountId', 'select', true],
    ['vatOutputAccountId', 'select', true],
    ['roundingAccountId', 'select', false],
    ['postingEnabled', 'checkbox', false],
  ])

  await act(async () => {
    await props.onSubmit({ receivableAccountId: RECEIVABLE, vatOutputAccountId: VAT, roundingAccountId: '', postingEnabled: true })
  })
  expect(mockUpdateCrud).toHaveBeenCalledWith('sales_invoices_gl_posting/settings', {
    receivableAccountId: RECEIVABLE,
    vatOutputAccountId: VAT,
    roundingAccountId: null,
    postingEnabled: true,
    updatedAt: VERSION,
  })
  await waitFor(() => expect(captured.props!.optimisticLockUpdatedAt).toBe(NEXT_VERSION))
  expect(mockFlash).toHaveBeenCalledWith('Settings saved', 'success')
})

it('shows an error instead of the form when the settings cannot be loaded', async () => {
  mockApiCall.mockResolvedValue({ ok: false, result: null })
  render(<SalesInvoiceGlPostingSettingsPage />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Failed to load the settings'))
  expect(captured.props).toBeNull()
})
