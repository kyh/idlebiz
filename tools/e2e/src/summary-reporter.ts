import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

// What a run leaves for whoever reads it after, an agent with no window among them:
// test-results/SUMMARY.md, read before results.json and the traces. Each failure names its test
// where it stands in the repository, its error, its artifacts where they sit in test-results/ (the
// JSON reporter's paths are the runner's) and the end of main's log. With IDLEBIZ_E2E_NO_SKIPS=1,
// as CI's e2e-macos sets it, a skipped test fails the run: on a Mac nothing should skip, and a skip
// there would pass unseen.

/** How much of an error a failure shows. */
const ERROR_LINES = 20;
/** How much of main's log a failure shows, from its end. */
const MAIN_LOG_LINES = 60;

const firstLines = (text: string, count: number): string =>
  text.split("\n").slice(0, count).join("\n");

const lastLines = (text: string, count: number): string =>
  text.split("\n").slice(-count).join("\n");

const fenced = (text: string): string => `\`\`\`\n${text.replaceAll("```", "'''")}\n\`\`\``;

export default class SummaryReporter implements Reporter {
  private outputDir = "";
  private repository = "";
  private readonly tests: TestCase[] = [];

  onBegin(config: FullConfig): void {
    const configDir =
      config.configFile === undefined ? process.cwd() : path.dirname(config.configFile);
    this.outputDir = config.projects[0]?.outputDir ?? path.join(configDir, "test-results");
    // the config is tools/e2e's, two folders down
    this.repository = path.resolve(configDir, "..", "..");
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.retry === 0) {
      this.tests.push(test);
    }
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    const outcome = (kind: ReturnType<TestCase["outcome"]>) =>
      this.tests.filter((test) => test.outcome() === kind);
    const failed = outcome("unexpected");
    const flaky = outcome("flaky");
    const skipped = outcome("skipped");
    const skipsFail = process.env.IDLEBIZ_E2E_NO_SKIPS === "1" && skipped.length > 0;
    const status = skipsFail ? "failed" : result.status;
    const counts = [
      `${outcome("expected").length} passed`,
      `${failed.length} failed`,
      `${flaky.length} flaky`,
      `${skipped.length} skipped`,
    ].join(", ");
    const sections = [
      `# e2e: ${status}\n\n${counts}, in ${Math.round(result.duration / 1000)}s.`,
      ...(skipsFail
        ? ["IDLEBIZ_E2E_NO_SKIPS=1, so the skips below fail the run: on a Mac no test should skip."]
        : []),
      ...failed.map((test) => this.failure("Failed", test)),
      ...flaky.map((test) => this.failure("Flaky", test)),
      ...(skipped.length === 0
        ? []
        : [`## Skipped\n\n${skipped.map((test) => `- ${this.skip(test)}`).join("\n")}`]),
    ];
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(path.join(this.outputDir, "SUMMARY.md"), `${sections.join("\n\n")}\n`);
    return skipsFail ? { status: "failed" } : undefined;
  }

  /** `test` where it stands in the repository, and its title under its file's. */
  private where(test: TestCase): string {
    const { file, line } = test.location;
    const title = test.titlePath().filter(Boolean).slice(1).join(" › ");
    return `${title} (${path.relative(this.repository, file)}:${line})`;
  }

  private skip(test: TestCase): string {
    const reasons = test.annotations
      .filter(({ type }) => type === "skip")
      .map(({ description }) => (description ?? "no reason given").replaceAll(/\s+/gu, " ").trim());
    return `${this.where(test)}: ${reasons.join("; ") || "no reason given"}`;
  }

  private failure(heading: string, test: TestCase): string {
    const results = test.results.filter(({ status }) => status !== "passed");
    const said = results.flatMap(({ errors }) =>
      errors.map(({ message, value }) =>
        firstLines(stripVTControlCharacters(message ?? value ?? "no message"), ERROR_LINES),
      ),
    );
    const artifacts = test.results.flatMap(({ attachments }) =>
      attachments.flatMap(({ name, path: at }) =>
        at === undefined ? [] : [`- ${name}: \`${path.relative(this.outputDir, at)}\``],
      ),
    );
    const main = results
      .flatMap(({ attachments }) => attachments)
      .findLast(({ body, name }) => name === "main" && body !== undefined);
    return [
      `## ${heading}: ${this.where(test)}`,
      ...said.map(fenced),
      ...(artifacts.length === 0
        ? []
        : [`Artifacts, in test-results/:\n\n${artifacts.join("\n")}`]),
      ...(main?.body === undefined
        ? []
        : [
            `main's log, its last ${MAIN_LOG_LINES} lines:`,
            fenced(lastLines(main.body.toString("utf-8"), MAIN_LOG_LINES)),
          ]),
    ].join("\n\n");
  }
}
