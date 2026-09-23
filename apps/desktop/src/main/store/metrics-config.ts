import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "@/main/lib/fs";
import { companyDir } from "@/main/paths";

// Which providers a company reads its real numbers from. A leaf: the store
// adopts a legacy binding out of it at boot, and must not pull in the network
// layer that reads the numbers to do so.

// oxlint-disable-next-line sort-keys -- order is written to metrics.json
const MetricsConfigSchema = z.object({
  stripe: z.boolean().optional(),
  stripeAccount: z
    .object({ accountId: z.string(), connectedAt: z.number(), livemode: z.boolean() })
    .optional(),
  // a Vercel binding belongs to a product; saves from before products kept it
  // here, and boot moves it to the first product
  vercel: z
    .object({
      projectId: z.string(),
      projectName: z.string().optional(),
      teamId: z.string().optional(),
    })
    .optional(),
  plausible: z.object({ domain: z.string() }).optional(),
  custom: z.object({ url: z.string() }).optional(),
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
