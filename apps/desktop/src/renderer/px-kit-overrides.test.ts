import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compile } from "tailwindcss";
import { expect, it } from "vitest";

// The kit's classes are unlayered, so they beat any Tailwind utility on the same element:
// a utility that sets a property its kit class also sets does nothing.

const require = createRequire(import.meta.url);
const tailwindRoot = path.dirname(require.resolve("tailwindcss/package.json"));
const kitPath = require.resolve("@repo/px-kit/px-kit.css");
const renderer = import.meta.dirname;

// A shorthand the kit sets covers the longhands a utility sets, but not these.
const notCoveredBy = new Map([["border", ["border-radius"]]]);

const declaredProps = (body: string): string[] =>
  body
    .split(";")
    .map((decl) => decl.split(":")[0]?.trim() ?? "")
    .filter((prop) => prop !== "" && !prop.startsWith("--"));

const kitProps = (): Map<string, string[]> => {
  const css = readFileSync(kitPath, "utf-8").replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const props = new Map<string, string[]>();
  for (const rule of css.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/gu)) {
    for (const selector of (rule.groups?.selectors ?? "").split(",")) {
      const kitClass = /^\.(?<name>px-[\w-]+)$/u.exec(selector.trim())?.groups?.name;
      if (kitClass !== undefined) {
        props.set(kitClass, [
          ...(props.get(kitClass) ?? []),
          ...declaredProps(rule.groups?.body ?? ""),
        ]);
      }
    }
  }
  return props;
};

const utilityProps = async (candidates: readonly string[]): Promise<Map<string, string[]>> => {
  const stylesheets = new Map([
    ["@repo/px-kit/px-kit.css", kitPath],
    ["tailwindcss", path.join(tailwindRoot, "index.css")],
  ]);
  const compiler = await compile(readFileSync(path.join(renderer, "styles.css"), "utf-8"), {
    base: renderer,
    loadStylesheet: (id, base) => {
      const file = stylesheets.get(id) ?? path.join(base, id);
      return Promise.resolve({
        base: path.dirname(file),
        content: readFileSync(file, "utf-8"),
        path: file,
      });
    },
  });
  const css = compiler.build([...candidates]);
  const start = css.indexOf("@layer utilities {");
  const layer = css.slice(start, css.indexOf("\n}", start));
  const props = new Map<string, string[]>();
  for (const rule of layer.matchAll(/\.(?<selector>(?:\\.|[\w-])+)\s*\{(?<body>[^{}]*)\}/gu)) {
    props.set(
      (rule.groups?.selector ?? "").replaceAll("\\", ""),
      declaredProps(rule.groups?.body ?? ""),
    );
  }
  return props;
};

const overrides = (kit: string, utility: string): boolean =>
  utility === kit ||
  (utility.startsWith(`${kit}-`) && !(notCoveredBy.get(kit) ?? []).includes(utility));

it("puts no Tailwind utility beside a kit class that sets the same property", async () => {
  const kit = kitProps();
  const uses: { file: string; kitClasses: string[]; utilities: string[] }[] = [];
  for (const file of readdirSync(renderer, { encoding: "utf-8", recursive: true })) {
    if (!file.endsWith(".tsx")) {
      continue;
    }
    const source = readFileSync(path.join(renderer, file), "utf-8");
    for (const literal of source.matchAll(/["'`](?<text>[^"'`\n]*)["'`]/gu)) {
      const tokens = (literal.groups?.text ?? "").split(/\s+/u).filter((token) => token !== "");
      const kitClasses = tokens.filter((token) => kit.has(token));
      if (kitClasses.length > 0) {
        uses.push({
          file,
          kitClasses,
          // A variant applies the same property, so it loses the same way; an important one wins.
          utilities: tokens
            .filter((token) => !kit.has(token) && !token.startsWith("!") && !token.endsWith("!"))
            .map((token) => token.split(":").at(-1) ?? token),
        });
      }
    }
  }
  const utilities = await utilityProps(uses.flatMap((use) => use.utilities));
  const beaten = uses.flatMap(({ file, kitClasses, utilities: used }) =>
    kitClasses.flatMap((kitClass) =>
      used.flatMap((utility) =>
        (utilities.get(utility) ?? [])
          .filter((prop) => (kit.get(kitClass) ?? []).some((kitProp) => overrides(kitProp, prop)))
          .map((prop) => `${file}: .${kitClass} beats ${utility} on ${prop}`),
      ),
    ),
  );
  expect(beaten).toEqual([]);
});
