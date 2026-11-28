import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { AdvisoryLockUnavailableError } from '@open-mercato/shared/lib/db/advisoryLock'
import type { ModuleConfigService } from '@open-mercato/core/modules/configs/lib/module-config-service'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { settingsUpdateSchema } from '../../data/validators'
import {
  SETTINGS_RESOURCE_KIND,
  readSettingsSnapshot,
  saveSettings,
  type SalesInvoiceGlPostingSettings,
  type SettingsScope,
} from '../../lib/moduleConfig'

const logger = createLogger('sales_invoices_gl_posting')

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sales_invoices_gl_posting.settings.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['sales_invoices_gl_posting.settings.manage'] },
}

const settingsResponseSchema = z.object({
  receivableAccountId: z.uuid().nullable(),
  vatOutputAccountId: z.uuid().nullable(),
  roundingAccountId: z.uuid().nullable(),
  postingEnabled: z.boolean(),
  updatedAt: z.string().nullable(),
})

type Translate = (key: string, fallback: string) => string

type SettingsContext = {
  container: Awaited<ReturnType<typeof createRequestContainer>>
  scope: SettingsScope
  organizationScope: OrganizationScope | null
  actorId: string
  translate: Translate
}

function tryResolveConfigService(container: SettingsContext['container']): ModuleConfigService | null {
  try {
    return container.resolve('moduleConfigService') as ModuleConfigService
  } catch {
    return null
  }
}

async function resolveSettingsContext(req: Request): Promise<SettingsContext> {
  const { translate } = await resolveTranslations()
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) {
    throw new CrudHttpError(401, { error: translate('sales_invoices_gl_posting.errors.unauthorized', 'Unauthorized') })
  }
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) {
    throw new CrudHttpError(422, {
      error: translate(
        'sales_invoices_gl_posting.errors.organizationRequired',
        'Select an organization to manage its sales invoice posting settings.',
      ),
      code: 'ORGANIZATION_REQUIRED',
    })
  }
  const allowed = organizationScope?.filterIds
  if (Array.isArray(allowed) && !allowed.includes(organizationId)) {
    throw new CrudHttpError(403, { error: translate('sales_invoices_gl_posting.errors.forbidden', 'Forbidden') })
  }
  const actorId =
    (typeof auth.sub === 'string' && auth.sub.trim().length > 0 && auth.sub) ||
    (typeof auth.keyId === 'string' && auth.keyId.trim().length > 0 && auth.keyId) ||
    'system'
  return {
    container,
    scope: { tenantId: auth.tenantId, organizationId },
    organizationScope: organizationScope ?? null,
    actorId,
    translate,
  }
}

function serialize(settings: SalesInvoiceGlPostingSettings) {
  return {
    receivableAccountId: settings.receivableAccountId,
    vatOutputAccountId: settings.vatOutputAccountId,
    roundingAccountId: settings.roundingAccountId,
    postingEnabled: settings.postingEnabled,
    updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
  }
}

async function errorResponse(err: unknown, method: string) {
  if (isCrudHttpError(err)) {
    return NextResponse.json(err.body, { status: err.status })
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: 'Invalid request', details: err.issues }, { status: 400 })
  }
  const { translate } = await resolveTranslations()
  if (err instanceof AdvisoryLockUnavailableError) {
    return NextResponse.json(
      {
        error: translate(
          'sales_invoices_gl_posting.errors.settingsBusy',
          'The settings are being saved by someone else. Try again.',
        ),
      },
      { status: 503 },
    )
  }
  logger.error(`sales_invoices_gl_posting.settings.${method} Unexpected error`, { err })
  return NextResponse.json(
    { error: translate('sales_invoices_gl_posting.errors.unexpected', 'Internal server error') },
    { status: 500 },
  )
}

async function GET(req: Request) {
  try {
    const context = await resolveSettingsContext(req)
    const em = context.container.resolve('em') as EntityManager
    const settings = await readSettingsSnapshot(em, context.scope)
    return NextResponse.json(serialize(settings))
  } catch (err) {
    return errorResponse(err, 'GET')
  }
}

async function PUT(req: Request) {
  try {
    const context = await resolveSettingsContext(req)
    const body = settingsUpdateSchema.parse(await req.json())
    const { updatedAt, ...requested } = body
    const guarded = await runRouteMutationGuards({
      container: context.container,
      req,
      auth: {
        userId: context.actorId,
        tenantId: context.scope.tenantId,
        organizationId: context.scope.organizationId,
        organizationScope: context.organizationScope,
      },
      input: {
        resourceKind: SETTINGS_RESOURCE_KIND,
        resourceId: context.scope.organizationId,
        operation: 'update',
        mutationPayload: requested,
      },
    })
    if (!guarded.ok) return guarded.response
    const { updatedAt: _ignored, ...input } = settingsUpdateSchema.parse({
      ...requested,
      ...(guarded.modifiedPayload ?? {}),
      updatedAt,
    })

    const em = context.container.resolve('em') as EntityManager
    const configService = tryResolveConfigService(context.container)
    const saved = await saveSettings(em, context.scope, input, updatedAt, {
      translate: context.translate,
      invalidate: configService
        ? (moduleId, name, scope) => configService.invalidate(moduleId, name, scope)
        : undefined,
    })

    await guarded.runAfterSuccess()

    return NextResponse.json(serialize(saved))
  } catch (err) {
    return errorResponse(err, 'PUT')
  }
}

const getDoc: OpenApiMethodDoc = {
  summary: 'Read the sales invoice GL posting settings of the selected organization',
  tags: ['Sales Invoice GL Posting'],
  responses: [{ status: 200, description: 'Settings of the selected organization', schema: settingsResponseSchema }],
  errors: [
    { status: 403, description: 'Organization outside the caller scope' },
    { status: 422, description: 'No organization selected (ORGANIZATION_REQUIRED)' },
  ],
}

const putDoc: OpenApiMethodDoc = {
  summary: 'Save the sales invoice GL posting settings of the selected organization',
  tags: ['Sales Invoice GL Posting'],
  requestBody: { schema: settingsUpdateSchema },
  responses: [{ status: 200, description: 'Saved settings', schema: settingsResponseSchema }],
  errors: [
    { status: 400, description: 'Invalid request body' },
    { status: 403, description: 'Organization outside the caller scope' },
    { status: 409, description: 'The settings changed since they were read (optimistic lock conflict)' },
    { status: 422, description: 'No organization selected (ORGANIZATION_REQUIRED) or an account outside the organization (ACCOUNT_OUT_OF_SCOPE)' },
    { status: 503, description: 'The settings lock could not be acquired in time' },
  ],
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sales Invoice GL Posting',
  summary: 'Sales invoice GL posting settings',
  methods: {
    GET: getDoc,
    PUT: putDoc,
  },
}

export { GET, PUT }
