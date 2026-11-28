export const metadata = {
  requireAuth: true,
  requireFeatures: ['sales_invoices_gl_posting.settings.manage'],
  pageTitle: 'Sales invoice posting settings',
  pageTitleKey: 'sales_invoices_gl_posting.settings.page.title',
  pageGroup: 'General Ledger',
  pageGroupKey: 'ledger.nav.group',
  pageOrder: 90,
  icon: 'settings',
  breadcrumb: [{ label: 'Sales invoice posting settings', labelKey: 'sales_invoices_gl_posting.settings.page.title' }],
}
