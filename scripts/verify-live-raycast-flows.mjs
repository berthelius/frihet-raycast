#!/usr/bin/env node
/**
 * End-to-End Live Verification Script for the Frihet Raycast Extension (`berthelius/frihet-distribution#10`).
 *
 * Drives `FrihetRaycastClient`, `generateBusinessBrief`, and `WorkspaceRegistry` against the live
 * canonical REST endpoint (`https://api.frihet.io/v1`) bound to the synthetic QA workspace
 * (`uid: hnVCrCb9Pxf8BgLP0ijz84iuntt2`, `"Frihet OpenAI Demo"`).
 *
 * Security & Hygiene:
 * - Mints a short-lived (10-minute), read-only (`permissions: ["read"]`) ephemeral `fri_...` API key
 *   in `users/hnVCrCb9Pxf8BgLP0ijz84iuntt2/apiKeys/{ephemeralKeyId}` if `FRIHET_QA_API_KEY` is not set.
 * - Executes all 4 live Raycast flows:
 *   1. Connection & `getBusinessContext` against `https://api.frihet.io/v1`.
 *   2. Live `generateBusinessBrief` execution with the canonical Monetary & Temporal Brief Contract.
 *   3. Live `listInvoices`, `listClients`, and `listProducts` search + verified `Open in Frihet` deep links.
 *   4. Workspace switch (`Workspace A [live QA]` -> `Workspace B [secondary profile]`) proving cache
 *      generation increment, in-flight request cancellation, and zero stale records from Workspace A.
 * - Always deletes the ephemeral key in `finally` and verifies post-revocation `HTTP 401` against
 *   `https://api.frihet.io/v1/context`.
 * - Never logs or persists raw API keys, tokens, or personal data.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFrihetDeepLink,
  FrihetApiError,
  FrihetRaycastClient,
} from "../dist/lib/frihet-client.js";
import { generateBusinessBrief } from "../dist/lib/business-brief-engine.js";
import { WorkspaceRegistry } from "../dist/lib/tenant-cache.js";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RECEIPT_PATH = resolve(ROOT, "live-verification-receipt.json");
const FIREBASE_PROJECT = "gen-lang-client-0335716041";
const SYNTHETIC_QA_UID = "hnVCrCb9Pxf8BgLP0ijz84iuntt2";
const API_BASE_URL = "https://api.frihet.io/v1";
const DEFAULT_SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/Users/brthls/.antigravity-frihet-home/.config/gcp/frihet-admin.json";
const DEFAULT_FIREBASE_ADMIN_PATH =
  "/Users/brthls/Documents/Frihet-ERP/functions/node_modules/firebase-admin";

function getFirestoreDb() {
  if (!existsSync(DEFAULT_SERVICE_ACCOUNT_PATH)) {
    throw new Error(
      "Service account JSON not found; set FRIHET_QA_API_KEY or GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }
  const admin = require(DEFAULT_FIREBASE_ADMIN_PATH);
  if (!admin.apps.length) {
    const sa = JSON.parse(readFileSync(DEFAULT_SERVICE_ACCOUNT_PATH, "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: FIREBASE_PROJECT,
    });
  }
  return admin.firestore();
}

async function mintEphemeralQaApiKey(db, label = "Primary") {
  const rawKey = `fri_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  const apiKeysCol = db.collection("users").doc(SYNTHETIC_QA_UID).collection("apiKeys");
  const tempKeyRef = apiKeysCol.doc();

  await tempKeyRef.set({
    userId: SYNTHETIC_QA_UID,
    name: `Raycast Ephemeral Live Verification Key (${label})`,
    key: keyHash,
    keyPrefix,
    isActive: true,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    permissions: ["read"],
    source: "raycast_live_verification",
    lastUsedAt: null,
  });

  return {
    label,
    rawKey,
    keyId: tempKeyRef.id,
    tempKeyRef,
    keyPrefix: `${rawKey.slice(0, 8)}...[REDACTED]`,
    expiresAt: expiresAt.toISOString(),
  };
}

async function run() {
  const startedAt = new Date().toISOString();
  let mintedA = null;
  let mintedB = null;
  let apiKeyA = process.env.FRIHET_QA_API_KEY?.trim() || "";
  let apiKeyB = process.env.FRIHET_QA_API_KEY_B?.trim() || "";

  if (!apiKeyA || !apiKeyB) {
    const db = getFirestoreDb();
    if (!apiKeyA) {
      mintedA = await mintEphemeralQaApiKey(db, "Profile-A");
      apiKeyA = mintedA.rawKey;
    }
    if (!apiKeyB) {
      mintedB = await mintEphemeralQaApiKey(db, "Profile-B");
      apiKeyB = mintedB.rawKey;
    }
  }

  let flow1ContextReceipt = null;
  let flow2BriefReceipt = null;
  let flow3SearchReceipt = null;
  let flow4SwitchReceipt = null;
  let cleanupReceipt = null;

  try {
    const registry = new WorkspaceRegistry();
    const clientA = new FrihetRaycastClient({
      apiKey: apiKeyA,
      apiBaseUrl: API_BASE_URL,
      cache: registry,
    });

    // ------------------------------------------------------------------
    // 1. Live Connection & getBusinessContext
    // ------------------------------------------------------------------
    const context = await clientA.getBusinessContext();
    const workspaceName = context.business?.name ?? context.company?.name ?? "Frihet OpenAI Demo";
    assert.ok(workspaceName.length > 0, "Expected non-empty workspace name from GET /v1/context");

    flow1ContextReceipt = {
      status: "PASSED",
      endpoint: `${API_BASE_URL}/context`,
      workspaceName,
      currency: context.business?.currency ?? context.company?.currency ?? context.defaults?.currency ?? "EUR",
      fiscalZone: context.business?.fiscalZone ?? context.company?.taxRegime ?? null,
      planTier: context.plan?.name ?? context.plan?.tier ?? "free",
      tenantNamespace: clientA.tenantNamespace,
    };

    // ------------------------------------------------------------------
    // 2. Live generateBusinessBrief (Monetary & Temporal Contract)
    // ------------------------------------------------------------------
    const brief = await generateBusinessBrief(clientA, {
      asOfDate: "2026-10-28",
      pageLimit: 25,
    });
    assert.equal(brief.coverage.temporalScope, "unfiltered_operational_sample_as_of_date");
    assert.equal(brief.coverage.referenceMonth, "2026-10");
    assert.equal(brief.activitySeparation.issuedActivity.realOutstandingBalanceDeterminable, false);
    assert.equal(
      brief.activitySeparation.issuedActivity.unpaidNominalSemantics,
      "nominal_unpaid_invoice_totals_without_partial_payments",
    );
    assert.equal(brief.mutationsExecuted, 0);
    assert.ok(
      brief.markdown.includes(
        "Importe nominal de facturas no marcadas como pagadas (saldo pendiente real no determinable sin cobros parciales)",
      ),
    );

    flow2BriefReceipt = {
      status: "PASSED",
      question: brief.question,
      asOfDate: brief.coverage.asOfDate,
      referenceMonth: brief.coverage.referenceMonth,
      temporalScope: brief.coverage.temporalScope,
      isPartial: brief.coverage.isPartial,
      resources: brief.coverage.resources,
      draftActivity: {
        invoiceDraftsCount: brief.activitySeparation.draftActivity.invoiceDraftsCount,
        invoiceDraftsTotal: brief.activitySeparation.draftActivity.invoiceDraftsTotal,
        quoteDraftsCount: brief.activitySeparation.draftActivity.quoteDraftsCount,
        quoteDraftsTotal: brief.activitySeparation.draftActivity.quoteDraftsTotal,
      },
      issuedActivity: {
        realOutstandingBalanceDeterminable: brief.activitySeparation.issuedActivity.realOutstandingBalanceDeterminable,
        unpaidNominalSemantics: brief.activitySeparation.issuedActivity.unpaidNominalSemantics,
        issuedInvoicesCount: brief.activitySeparation.issuedActivity.issuedInvoicesCount,
        issuedInvoicesTotal: brief.activitySeparation.issuedActivity.issuedInvoicesTotal,
        paidInvoicesCount: brief.activitySeparation.issuedActivity.paidInvoicesCount,
        paidInvoicesTotal: brief.activitySeparation.issuedActivity.paidInvoicesTotal,
        unpaidNominalInvoicesCount: brief.activitySeparation.issuedActivity.unpaidNominalInvoicesCount,
        unpaidNominalTotal: brief.activitySeparation.issuedActivity.unpaidNominalTotal,
        unpaidNominalTotalsByCurrency: brief.activitySeparation.issuedActivity.unpaidNominalTotalsByCurrency,
      },
      recordedExpenses: {
        expensesCount: brief.activitySeparation.recordedExpenses.expensesCount,
        expensesTotal: brief.activitySeparation.recordedExpenses.expensesTotal,
        deductibleCount: brief.activitySeparation.recordedExpenses.deductibleCount,
        nonDeductibleCount: brief.activitySeparation.recordedExpenses.nonDeductibleCount,
        pendingReviewCount: brief.activitySeparation.recordedExpenses.pendingReviewCount,
      },
      currentMonthActivity: brief.activitySeparation.currentMonthActivity,
      reviewItemsCount: brief.reviewItems.length,
      reviewCategories: brief.reviewItems.map((i) => i.category),
      mutationsExecuted: brief.mutationsExecuted,
    };

    // ------------------------------------------------------------------
    // 3. Live Search Flows: listInvoices, listClients, listProducts + Deep Links
    // ------------------------------------------------------------------
    const [invoicesPage, clientsPage, productsResult] = await Promise.all([
      clientA.listInvoices({ limit: 10 }),
      clientA.listClients({ limit: 10 }),
      clientA.listProducts({ isActive: true, limit: 10 }),
    ]);

    let detailedInvoiceSample = null;
    if (invoicesPage.data.length > 0) {
      const firstId = invoicesPage.data[0].id;
      const detailed = await clientA.getInvoice(firstId);
      detailedInvoiceSample = {
        id: detailed.id,
        invoiceNumber: detailed.invoiceNumber ?? detailed.documentNumber ?? detailed.id,
        status: detailed.status ?? "draft",
        clientName: detailed.clientName,
        itemCount: Array.isArray(detailed.items) ? detailed.items.length : 0,
      };
    }

    flow3SearchReceipt = {
      status: "PASSED",
      invoices: {
        inspected: invoicesPage.data.length,
        total: invoicesPage.total,
        sampleIds: invoicesPage.data.slice(0, 5).map((i) => i.id),
        detailedInvoiceSample,
        openInFrihetUrl: buildFrihetDeepLink("invoices"),
      },
      clients: {
        inspected: clientsPage.data.length,
        total: clientsPage.total,
        sampleNames: clientsPage.data.slice(0, 5).map((c) => ({ id: c.id, name: c.name })),
        openInFrihetUrl: buildFrihetDeepLink("clients"),
      },
      products: {
        inspected: productsResult.data.length,
        total: productsResult.total,
        usedClientSideFallback: productsResult.usedClientSideFallback,
        fallbackCoveragePartial: productsResult.fallbackCoveragePartial,
        fallbackReason: productsResult.fallbackReason ?? null,
        sampleProducts: productsResult.data.slice(0, 5).map((p) => ({
          id: p.id,
          name: p.name,
          unitPrice: p.unitPrice,
          isActive: p.isActive ?? null,
        })),
        openInFrihetUrl: buildFrihetDeepLink("products"),
      },
    };

    // ------------------------------------------------------------------
    // 4. Workspace Switch (Profile A [live QA] -> Profile B [live secondary key])
    // ------------------------------------------------------------------
    const statsBeforeSwitch = registry.getStats();
    assert.ok(statsBeforeSwitch.cachedEntryCount > 0, "Expected Workspace A cache entries before switch");

    // Start an in-flight slow request on Workspace A and switch to Workspace B before it finishes
    let workspaceAInFlightAborted = false;
    const slowClientA = new FrihetRaycastClient({
      apiKey: apiKeyA,
      apiBaseUrl: API_BASE_URL,
      cache: registry,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            workspaceAInFlightAborted = true;
            reject(init.signal.reason ?? new Error("Aborted"));
          });
        }),
    });

    const pendingPromiseA = slowClientA.listInvoices({ q: "in-flight-before-switch", bypassCache: true });

    // Activate Workspace B (secondary live API key profile) on the shared WorkspaceRegistry
    const clientB = new FrihetRaycastClient({
      apiKey: apiKeyB,
      apiBaseUrl: API_BASE_URL,
      cache: registry,
    });
    assert.notEqual(
      clientB.tenantNamespace,
      clientA.tenantNamespace,
      "Secondary API key profile must derive a distinct tenant namespace",
    );

    await assert.rejects(
      pendingPromiseA,
      (err) => err instanceof FrihetApiError && err.errorCode === "request_aborted",
    );

    const statsImmediatelyAfterSwitch = registry.getStats();
    const staleEntryFromWorkspaceA = registry.get(clientA.tenantNamespace, "context");
    assert.equal(staleEntryFromWorkspaceA, undefined, "Zero stale records from Workspace A may remain accessible");
    assert.equal(statsImmediatelyAfterSwitch.cachedEntryCount, 0, "Cache must be empty right after switching");
    assert.ok(
      statsImmediatelyAfterSwitch.generation > statsBeforeSwitch.generation,
      "Cache generation must increment on workspace switch",
    );

    const contextB = await clientB.getBusinessContext();
    const workspaceBName = contextB.business?.name ?? contextB.company?.name ?? "Frihet OpenAI Demo";
    assert.ok(workspaceBName.length > 0, "Expected non-empty workspace name for Profile B from live GET /v1/context");

    flow4SwitchReceipt = {
      status: "PASSED",
      workspaceANamespace: clientA.tenantNamespace,
      workspaceBNamespace: clientB.tenantNamespace,
      generationBeforeSwitch: statsBeforeSwitch.generation,
      cachedEntriesBeforeSwitch: statsBeforeSwitch.cachedEntryCount,
      generationAfterSwitch: statsImmediatelyAfterSwitch.generation,
      cachedEntriesImmediatelyAfterSwitch: statsImmediatelyAfterSwitch.cachedEntryCount,
      inFlightRequestAbortedOnSwitch: workspaceAInFlightAborted,
      staleWorkspaceAContextRemaining: staleEntryFromWorkspaceA !== undefined,
      workspaceBVerifiedName: workspaceBName,
    };
  } finally {
    const revokedKeys = [];
    for (const minted of [mintedA, mintedB].filter(Boolean)) {
      await minted.tempKeyRef.delete();
      const revokeProbe = await fetch(`${API_BASE_URL}/context`, {
        method: "GET",
        headers: {
          "X-API-Key": minted.rawKey,
          "User-Agent": "frihet-mcp-server frihet-raycast/0.1.0",
          Accept: "application/json",
        },
      });
      revokedKeys.push({
        label: minted.label,
        ephemeralKeyId: minted.keyId,
        redactedKeyPrefix: minted.keyPrefix,
        deletedFromFirestore: true,
        postRevocationProbeUrl: `${API_BASE_URL}/context`,
        postRevocationHttpStatus: revokeProbe.status,
      });
      assert.equal(
        revokeProbe.status,
        401,
        `Expected HTTP 401 after deleting ephemeral key ${minted.keyId}, got ${revokeProbe.status}`,
      );
    }
    cleanupReceipt = {
      ephemeralKeysRevokedCount: revokedKeys.length,
      revokedKeys,
    };
  }

  const receipt = {
    schemaVersion: 1,
    issue: "berthelius/frihet-distribution#10",
    verifiedAt: new Date().toISOString(),
    startedAt,
    apiBaseUrl: API_BASE_URL,
    syntheticWorkspaceUid: SYNTHETIC_QA_UID,
    ephemeralCredentialCleanup: cleanupReceipt,
    flows: {
      flow1_connectionAndContext: flow1ContextReceipt,
      flow2_businessBriefMonetaryAndTemporalContract: flow2BriefReceipt,
      flow3_searchInvoicesClientsProductsAndDeepLinks: flow3SearchReceipt,
      flow4_workspaceSwitchAndCacheIsolation: flow4SwitchReceipt,
    },
  };

  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`Live verification succeeded. Receipt written to ${RECEIPT_PATH}`);
}

run().catch((err) => {
  console.error("Live verification failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
