import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const TARGET = "aarch64-apple-darwin";
const LICENCE_FILE = /^(?:(?:un)?licen[cs]e|copying|notice|copyright)/iu;

const crateSchema = z.object({
  id: z.string(),
  license: z.string().nullable(),
  license_file: z.string().nullable(),
  manifest_path: z.string(),
  name: z.string(),
  repository: z.string().nullable(),
  targets: z.array(z.object({ kind: z.array(z.string()) })),
  version: z.string(),
});

type Crate = z.infer<typeof crateSchema>;

const metadataSchema = z.object({
  packages: z.array(crateSchema),
  resolve: z.object({
    nodes: z.array(
      z.object({
        deps: z.array(
          z.object({
            dep_kinds: z.array(z.object({ kind: z.string().nullable() })),
            pkg: z.string(),
          }),
        ),
        id: z.string(),
      }),
    ),
    root: z.string(),
  }),
});

type Metadata = z.infer<typeof metadataSchema>;

const cargoMetadata = (manifestDir: string) => {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET],
    { cwd: manifestDir, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    throw new Error(`cargo metadata exited ${result.status ?? result.signal}: ${result.stderr}`);
  }

  return metadataSchema.parse(JSON.parse(result.stdout));
};

const byNameThenVersion = (a: Crate, b: Crate) => {
  const byName = a.name.localeCompare(b.name);

  return byName === 0 ? a.version.localeCompare(b.version) : byName;
};

const isProcMacro = (crate: Crate | undefined) =>
  crate?.targets.some((target) => target.kind.includes("proc-macro")) ?? false;

const linkedCrates = (metadata: Metadata) => {
  const crates = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const { root } = metadata.resolve;
  const linked = new Set<string>();
  const pending = [root];

  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!linked.has(id)) {
      linked.add(id);

      for (const dep of nodes.get(id)?.deps ?? []) {
        if (dep.dep_kinds.some((kind) => kind.kind === null) && !isProcMacro(crates.get(dep.pkg))) {
          pending.push(dep.pkg);
        }
      }
    }
  }

  linked.delete(root);

  return [...linked]
    .flatMap((id) => {
      const crate = crates.get(id);

      return crate === undefined ? [] : [crate];
    })
    .toSorted(byNameThenVersion);
};

const licenceFiles = (crate: Crate) => {
  const dir = path.dirname(crate.manifest_path);

  const named = readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile() && LICENCE_FILE.test(item.name))
    .map((item) => item.name);

  const declared = crate.license_file === null ? [] : [crate.license_file];

  return [...new Set([...named, ...declared])]
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({ name, text: readFileSync(path.resolve(dir, name), "utf-8").trim() }));
};

export const writeRustNotices = async (manifestDir: string, outFile: string) => {
  const crates = linkedCrates(cargoMetadata(manifestDir));
  const texts = new Map<string, { covers: string[]; text: string }>();
  const lines: string[] = [];

  for (const crate of crates) {
    const source = crate.repository ?? `https://crates.io/crates/${crate.name}`;
    lines.push(
      `${crate.name} ${crate.version} — ${crate.license ?? "no licence stated"} — ${source}`,
    );

    for (const file of licenceFiles(crate)) {
      const digest = createHash("sha256").update(file.text).digest("hex");
      const shared = texts.get(digest) ?? { covers: [], text: file.text };
      shared.covers.push(`${crate.name} ${crate.version} (${file.name})`);
      texts.set(digest, shared);
    }
  }

  const sections = [...texts.values()].map(
    ({ covers, text }) => `---- ${covers.join(", ")}\n\n${text}\n`,
  );

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    [
      "The IdleBiz app's shell is built from the Rust crates below, each listed with its version, its licence and its source. The licence texts the crates ship follow, each once, after the crates it covers.",
      "",
      ...lines,
      "",
      ...sections,
    ].join("\n"),
  );

  return crates.length;
};
