/**
 * Providers API — composes the provider catalog (registry, models, routing)
 * and provider accounts (credential CRUD) route groups under one Elysia
 * instance so routes.ts keeps a single `.use(providersRoutes)` callsite.
 *
 * See provider-catalog.ts and provider-accounts.ts for the actual handlers.
 */

import { Elysia } from "elysia";
import { providerCatalogRoutes } from "./provider-catalog";
import { providerAccountsRoutes } from "./provider-accounts";

export const providersRoutes = new Elysia()
  .use(providerCatalogRoutes)
  .use(providerAccountsRoutes);
