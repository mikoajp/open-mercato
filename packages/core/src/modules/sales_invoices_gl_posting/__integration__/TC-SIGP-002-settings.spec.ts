import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';
import { deleteGeneralEntityIfExists, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures';
import { createAccountFixture, createAccountTypeFixture } from '@open-mercato/core/helpers/integration/ledgerFixtures';

/**
 * TC-SIGP-002: `GET`/`PUT /api/sales_invoices_gl_posting/settings` keep the
 * posting settings per organization, return the saved values on the next
 * read, reject a stale version with 409 and reject an account of another
 * organization with 422 ACCOUNT_OUT_OF_SCOPE.
 */

const SETTINGS_PATH = '/api/sales_invoices_gl_posting/settings';

type SettingsBody = {
  receivableAccountId: string | null;
  vatOutputAccountId: string | null;
  roundingAccountId: string | null;
  postingEnabled: boolean;
  updatedAt: string | null;
};

const randomSlug = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function createTenant(request: APIRequestContext, token: string, name: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/directory/tenants', { token, data: { name } });
  const body = await readJsonSafe<{ id?: string }>(response);
  expect(response.status(), 'POST /api/directory/tenants should return 201').toBe(201);
  const id = body?.id;
  expect(typeof id === 'string' && id.length > 0).toBeTruthy();
  return id as string;
}

function scopedHeaders(scope: { tenantId: string; organizationId: string }): Record<string, string> {
  return {
    Cookie: [
      `om_selected_tenant=${encodeURIComponent(scope.tenantId)}`,
      `om_selected_org=${encodeURIComponent(scope.organizationId)}`,
    ].join('; '),
  };
}

test.describe('TC-SIGP-002: sales invoice GL posting settings per organization', () => {
  test('saves, reads back, isolates organizations and rejects stale versions and foreign accounts', async ({ request }) => {
    const superadminToken = await getAuthToken(request, 'superadmin');
    const stamp = randomUUID();

    let tenantId: string | null = null;
    let orgAId: string | null = null;
    let orgBId: string | null = null;
    let accountTypeAId: string | null = null;
    let accountTypeBId: string | null = null;
    const accountAIds: string[] = [];
    let accountBId: string | null = null;
    let headersA: Record<string, string> | undefined;
    let headersB: Record<string, string> | undefined;

    try {
      tenantId = await createTenant(request, superadminToken, `QA TC-SIGP-002 Tenant ${stamp}`);
      orgAId = await createOrganizationFixture(request, superadminToken, {
        name: `QA TC-SIGP-002 Organization A ${stamp}`,
        tenantId,
      });
      orgBId = await createOrganizationFixture(request, superadminToken, {
        name: `QA TC-SIGP-002 Organization B ${stamp}`,
        tenantId,
      });
      headersA = scopedHeaders({ tenantId, organizationId: orgAId });
      headersB = scopedHeaders({ tenantId, organizationId: orgBId });

      accountTypeAId = await createAccountTypeFixture(
        request,
        superadminToken,
        { organizationId: orgAId, tenantId, number: randomSlug('qa-sigp-002-type-a'), name: 'QA Type A', normalBalance: 'DEBIT' },
        { headers: headersA },
      );
      accountTypeBId = await createAccountTypeFixture(
        request,
        superadminToken,
        { organizationId: orgBId, tenantId, number: randomSlug('qa-sigp-002-type-b'), name: 'QA Type B', normalBalance: 'DEBIT' },
        { headers: headersB },
      );
      for (const label of ['receivable', 'vat', 'rounding']) {
        accountAIds.push(
          await createAccountFixture(
            request,
            superadminToken,
            { organizationId: orgAId, tenantId, number: randomSlug(`qa-sigp-002-${label}`), accountTypeId: accountTypeAId },
            { headers: headersA },
          ),
        );
      }
      accountBId = await createAccountFixture(
        request,
        superadminToken,
        { organizationId: orgBId, tenantId, number: randomSlug('qa-sigp-002-account-b'), accountTypeId: accountTypeBId },
        { headers: headersB },
      );
      const [receivableId, vatId, roundingId] = accountAIds;

      const emptyRes = await apiRequest(request, 'GET', SETTINGS_PATH, { token: superadminToken, headers: headersA });
      expect(emptyRes.status(), 'GET settings before the first save should return 200').toBe(200);
      const empty = await readJsonSafe<SettingsBody>(emptyRes);
      expect(empty).toEqual({
        receivableAccountId: null,
        vatOutputAccountId: null,
        roundingAccountId: null,
        postingEnabled: false,
        updatedAt: null,
      });

      const firstPut = await apiRequest(request, 'PUT', SETTINGS_PATH, {
        token: superadminToken,
        headers: headersA,
        data: { receivableAccountId: receivableId, vatOutputAccountId: vatId, roundingAccountId: null, postingEnabled: true, updatedAt: null },
      });
      const firstSaved = await readJsonSafe<SettingsBody>(firstPut);
      expect(firstPut.status(), `First PUT should return 200: ${JSON.stringify(firstSaved)}`).toBe(200);
      expect(typeof firstSaved?.updatedAt === 'string').toBeTruthy();

      const readBack = await readJsonSafe<SettingsBody>(
        await apiRequest(request, 'GET', SETTINGS_PATH, { token: superadminToken, headers: headersA }),
      );
      expect(readBack).toEqual({
        receivableAccountId: receivableId,
        vatOutputAccountId: vatId,
        roundingAccountId: null,
        postingEnabled: true,
        updatedAt: firstSaved?.updatedAt,
      });

      const otherOrgRes = await apiRequest(request, 'GET', SETTINGS_PATH, { token: superadminToken, headers: headersB });
      expect(otherOrgRes.status()).toBe(200);
      expect(await readJsonSafe<SettingsBody>(otherOrgRes), 'organization B must not see organization A settings').toMatchObject({
        receivableAccountId: null,
        vatOutputAccountId: null,
        postingEnabled: false,
        updatedAt: null,
      });

      const secondPut = await apiRequest(request, 'PUT', SETTINGS_PATH, {
        token: superadminToken,
        headers: headersA,
        data: {
          receivableAccountId: receivableId,
          vatOutputAccountId: vatId,
          roundingAccountId: roundingId,
          postingEnabled: false,
          updatedAt: firstSaved?.updatedAt,
        },
      });
      const secondSaved = await readJsonSafe<SettingsBody>(secondPut);
      expect(secondPut.status(), `Second PUT with the current version should return 200: ${JSON.stringify(secondSaved)}`).toBe(200);
      expect(Date.parse(secondSaved?.updatedAt ?? '')).toBeGreaterThan(Date.parse(firstSaved?.updatedAt ?? ''));

      const stalePut = await apiRequest(request, 'PUT', SETTINGS_PATH, {
        token: superadminToken,
        headers: headersA,
        data: { receivableAccountId: receivableId, vatOutputAccountId: vatId, roundingAccountId: null, postingEnabled: true, updatedAt: firstSaved?.updatedAt },
      });
      expect(stalePut.status(), 'PUT with a stale version should return 409').toBe(409);

      const foreignPut = await apiRequest(request, 'PUT', SETTINGS_PATH, {
        token: superadminToken,
        headers: headersA,
        data: { receivableAccountId: receivableId, vatOutputAccountId: accountBId, roundingAccountId: null, postingEnabled: true, updatedAt: secondSaved?.updatedAt },
      });
      expect(foreignPut.status(), 'PUT with an account of organization B should return 422').toBe(422);
      expect(await readJsonSafe<{ code?: string }>(foreignPut)).toMatchObject({ code: 'ACCOUNT_OUT_OF_SCOPE' });

      const finalRead = await readJsonSafe<SettingsBody>(
        await apiRequest(request, 'GET', SETTINGS_PATH, { token: superadminToken, headers: headersA }),
      );
      expect(finalRead, 'rejected writes must leave the saved settings unchanged').toEqual(secondSaved);
    } finally {
      if (tenantId) {
        await withClient((client) =>
          client.query('delete from module_configs where module_id = $1 and tenant_id = $2', ['sales_invoices_gl_posting', tenantId]),
        );
      }
      for (const accountId of accountAIds) {
        await deleteGeneralEntityIfExists(request, superadminToken, '/api/ledger/accounts', accountId, { headers: headersA });
      }
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/ledger/accounts', accountBId, { headers: headersB });
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/ledger/account-types', accountTypeAId, { headers: headersA });
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/ledger/account-types', accountTypeBId, { headers: headersB });
      await deleteOrganizationIfExists(request, superadminToken, orgAId);
      await deleteOrganizationIfExists(request, superadminToken, orgBId);
      await deleteGeneralEntityIfExists(request, superadminToken, '/api/directory/tenants', tenantId);
    }
  });
});
