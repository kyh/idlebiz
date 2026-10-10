import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "../lib/fs";
import { companyDir } from "../paths";

// The Stripe account a company connected.

const MetricsConfigSchema = z.object({
  stripeAccount: z
    .object({ accountId: z.string(), connectedAt: z.number(), livemode: z.boolean() })
    .optional(),
});
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

const metricsPath = (companyId: string): string => path.join(companyDir(companyId), "metrics.json");

export const readMetricsConfig = (companyId: string): MetricsConfig | null =>
  readJsonFile(metricsPath(companyId), MetricsConfigSchema);

/** Merge a patch into metrics.json; an `undefined` field drops that provider. The file is a MetricsConfig both ways. */
export const writeMetricsConfig = (companyId: string, patch: Partial<MetricsConfig>): void => {
  const existing = readJsonFileForUpdate(metricsPath(companyId), MetricsConfigSchema) ?? {};
  const next = MetricsConfigSchema.parse({ ...existing, ...patch });
  atomicWrite(metricsPath(companyId), JSON.stringify(next, null, 2));
};
