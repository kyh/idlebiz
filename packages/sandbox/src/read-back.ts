/** A sandboxed command read back: its profile, the paths it hands over, and what it runs. */
export const readBack = (argv: readonly string[]) => {
  const [bin, flag, profile = "", ...rest] = argv;
  const params = new Map<string, string>();
  let at = 0;

  for (; rest[at] === "-D"; at += 2) {
    const define = rest[at + 1] ?? "";
    params.set(define.slice(0, define.indexOf("=")), define.slice(define.indexOf("=") + 1));
  }

  const lines = profile.split("\n");

  const named = (action: "allow" | "deny", operations: string) =>
    lines
      .filter((line) => line.startsWith(`(${action} ${operations} (`))
      .flatMap((rule) => [...rule.matchAll(/\(param "(?<name>P\d+)"\)/gu)])
      .map(({ groups }) => params.get(groups?.name ?? "") ?? "");

  const lineOf = (action: "allow" | "deny", operations: string, target: string) =>
    lines.findIndex(
      (line) =>
        line.startsWith(`(${action} ${operations} (`) &&
        [...line.matchAll(/\(param "(?<name>P\d+)"\)/gu)].some(
          ({ groups }) => params.get(groups?.name ?? "") === target,
        ),
    );

  return {
    allowed: (operations: string) => named("allow", operations),
    bin,
    denied: (operations: string) => named("deny", operations),
    flag,
    lineOf,
    lines,
    params: [...params.values()],
    profile,
    runs: rest.slice(at),
  };
};
