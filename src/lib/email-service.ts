import { createVlyIntegrations } from "@vly-ai/integrations";

/**
 * PureWire's email service client.
 *
 * Sends verification and password-reset emails through the platform's email
 * integration using a single deployment token. Used only inside Convex
 * actions ("use node" files).
 */
export const integrations = createVlyIntegrations({
  deploymentToken: process.env.VLY_INTEGRATION_KEY,
});
