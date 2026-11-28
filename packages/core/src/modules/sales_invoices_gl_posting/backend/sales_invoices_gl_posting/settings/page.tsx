'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { loadLedgerAccountOptions } from '@open-mercato/core/modules/ledger/backend/lib/optionLoaders'

const SETTINGS_API_PATH = 'sales_invoices_gl_posting/settings'

type SettingsData = {
  receivableAccountId: string | null
  vatOutputAccountId: string | null
  roundingAccountId: string | null
  postingEnabled: boolean
  updatedAt: string | null
}

function readOptionalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export default function SalesInvoiceGlPostingSettingsPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [settings, setSettings] = React.useState<SettingsData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      const loadError = t('sales_invoices_gl_posting.settings.errors.load', 'Failed to load the settings')
      try {
        const response = await apiCall<SettingsData>(`/api/${SETTINGS_API_PATH}`)
        if (cancelled) return
        if (response.ok && response.result) {
          setSettings(response.result)
        } else {
          setError(loadError)
        }
      } catch {
        if (!cancelled) setError(loadError)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [scopeVersion, t])

  const groups = React.useMemo<CrudFormGroup[]>(
    () => [
      {
        id: 'accounts',
        column: 1,
        title: t('sales_invoices_gl_posting.settings.form.group.accounts', 'Accounts'),
        fields: [
          {
            id: 'receivableAccountId',
            type: 'select',
            label: t('sales_invoices_gl_posting.settings.form.field.receivableAccount', 'Receivable account'),
            required: true,
            loadOptions: (query?: string) => loadLedgerAccountOptions(query),
          },
          {
            id: 'vatOutputAccountId',
            type: 'select',
            label: t('sales_invoices_gl_posting.settings.form.field.vatOutputAccount', 'Output VAT account'),
            required: true,
            loadOptions: (query?: string) => loadLedgerAccountOptions(query),
          },
          {
            id: 'roundingAccountId',
            type: 'select',
            label: t('sales_invoices_gl_posting.settings.form.field.roundingAccount', 'Rounding account'),
            helpText: t(
              'sales_invoices_gl_posting.settings.form.field.roundingAccountHelp',
              'Needed only for foreign-currency invoices that leave a rounding difference.',
            ),
            loadOptions: (query?: string) => loadLedgerAccountOptions(query),
          },
        ],
      },
      {
        id: 'posting',
        column: 1,
        title: t('sales_invoices_gl_posting.settings.form.group.posting', 'Posting'),
        fields: [
          {
            id: 'postingEnabled',
            type: 'checkbox',
            label: t(
              'sales_invoices_gl_posting.settings.form.field.postingEnabled',
              'Post sales invoices of this organization to the ledger',
            ),
            helpText: t(
              'sales_invoices_gl_posting.settings.form.field.postingEnabledHelp',
              'Leave this off for an organization whose invoices are issued and booked in another system and imported here.',
            ),
          },
        ],
      },
    ],
    [t],
  )

  if (loading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t('sales_invoices_gl_posting.settings.loading', 'Loading settings…')} />
        </PageBody>
      </Page>
    )
  }

  if (error || !settings) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('sales_invoices_gl_posting.settings.errors.load', 'Failed to load the settings')} />
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody>
        <CrudForm
          title={t('sales_invoices_gl_posting.settings.page.title', 'Sales invoice posting settings')}
          titleHeadingLevel={1}
          fields={[]}
          groups={groups}
          optimisticLockUpdatedAt={settings.updatedAt}
          initialValues={{
            receivableAccountId: settings.receivableAccountId ?? '',
            vatOutputAccountId: settings.vatOutputAccountId ?? '',
            roundingAccountId: settings.roundingAccountId ?? '',
            postingEnabled: settings.postingEnabled,
          }}
          submitLabel={t('sales_invoices_gl_posting.settings.form.action.save', 'Save settings')}
          onSubmit={async (values) => {
            const payload = {
              receivableAccountId: String(values.receivableAccountId || ''),
              vatOutputAccountId: String(values.vatOutputAccountId || ''),
              roundingAccountId: readOptionalId(values.roundingAccountId),
              postingEnabled: values.postingEnabled === true,
              updatedAt: settings.updatedAt,
            }
            const response = await updateCrud<SettingsData>(SETTINGS_API_PATH, payload)
            if (response.result) setSettings(response.result)
            flash(t('sales_invoices_gl_posting.settings.flash.saved', 'Settings saved'), 'success')
          }}
        />
      </PageBody>
    </Page>
  )
}
