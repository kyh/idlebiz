import { describe, expect, it } from "vitest";
import { shellWords } from "../test-support/shell-words";
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
    expect(shellWords(`echo ${shellQuote(value)}`)).toEqual(["echo", value]);
  });
});
