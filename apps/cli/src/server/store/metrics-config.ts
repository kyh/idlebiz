import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "../lib/fs";
import { COMPANY_DIR } from "../paths";

// The Stripe account the company connected.

const MetricsConfigSchema = z.object({
  stripeAccount: z
    .object({ accountId: z.string(), connectedAt: z.number(), livemode: z.boolean() })
    .optional(),
});
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

const METRICS_FILE = path.join(COMPANY_DIR, "metrics.json");

export const readMetricsConfig = (): MetricsConfig | null =>
  readJsonFile(METRICS_FILE, MetricsConfigSchema);

/** Merge a patch into metrics.json; an `undefined` field drops that provider. The file is a MetricsConfig both ways. */
export const writeMetricsConfig = (patch: Partial<MetricsConfig>): void => {
  const existing = readJsonFileForUpdate(METRICS_FILE, MetricsConfigSchema) ?? {};
  const next = MetricsConfigSchema.parse({ ...existing, ...patch });
  atomicWrite(METRICS_FILE, JSON.stringify(next, null, 2));
};
