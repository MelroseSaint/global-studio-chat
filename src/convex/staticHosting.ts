import { exposeDeploymentQuery } from "@convex-dev/static-hosting";

import { components } from "./_generated/api";

/**
 * Exposes the current deployment version as a public query so the client can
 * detect when a new deployment ships and prompt a live reload.
 *
 * This module is intentionally named `staticHosting` so the default query path
 * used by `<UpdateBanner />` (`api.staticHosting.getCurrentDeployment`)
 * resolves without passing an explicit reference.
 */
export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
