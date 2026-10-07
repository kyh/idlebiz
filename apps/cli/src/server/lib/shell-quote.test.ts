import { describe, expect, it } from "vitest";
import { lexLine } from "../shell-lexer";
import { shellQuote } from "./shell-quote";

describe("shellQuote", () => {
  it.each([
    "plain",
    "two words",
    `{"question":"Can't we ship?"}`,
    "it's $HOME, `pwd` and \\n",
    "'",
    "",
  ])("hands a shell %j back as one word", (value) => {
    const [pipeline] = lexLine(`echo ${shellQuote(value)}`).pipelines;
    expect(pipeline?.[0]?.words).toEqual(["echo", value]);
  });
});
