import { describe, expect, it } from "vitest";
import { lexFlat, lexLine } from "./shell-lexer";
import type { Pipeline } from "./shell-lexer";

const wordsOf = (pipelines: readonly Pipeline[]): string[][][] =>
  pipelines.map((pipeline) => pipeline.map((command) => [...command.words]));

const words = (line: string): string[][][] => wordsOf(lexLine(line));

describe("lexLine", () => {
  it("splits pipelines on separators and keeps a pipe's commands together", () => {
    expect(words("a | b && c; d & e || f\ng |& h")).toEqual([
      [["a"], ["b"]],
      [["c"]],
      [["d"]],
      [["e"]],
      [["f"]],
      [["g"], ["h"]],
    ]);
  });

  it("resolves quotes and escapes into words", () => {
    expect(words(String.raw`echo 'a b' "c $d \"e\" \q" f\ g h''i ""`)).toEqual([
      [["echo", "a b", String.raw`c $d "e" \q`, "f g", "hi", ""]],
    ]);
  });

  it("reads $'…' strings, where a backslash escapes a quote, and their escapes", () => {
    expect(words(String.raw`echo $'it\'s' x`)).toEqual([[["echo", "it's", "x"]]]);
    expect(
      words(
        String.raw`printf $'a\nb' $'\x70ush' $'\160ush' $'\u0070ush' $'\U00000070ush' $'\push' $'pu\0x'sh`,
      ),
    ).toEqual([[["printf", "a\nb", "push", "push", "push", "push", "push", "push"]]]);
  });

  it("keeps quotes in step with bash across $'…' strings", () => {
    expect(words(String.raw`echo $'\'' ; git push ; echo '\'`)).toEqual([
      [["echo", "'"]],
      [["git", "push"]],
      [["echo", "\\"]],
    ]);
  });

  it('reads $"…" as double quotes', () => {
    expect(words('git $"push"')).toEqual([[["git", "push"]]]);
  });

  it("keeps separators inside quotes as text", () => {
    expect(words(`git commit -m 'wip; gh pr merge' -m "a | b && c"`)).toEqual([
      [["git", "commit", "-m", "wip; gh pr merge", "-m", "a | b && c"]],
    ]);
  });

  it("reads a substitution's commands first, keeping its text in the word", () => {
    expect(words('echo "$(git push)" `date` <(ls)')).toEqual([
      [["git", "push"]],
      [["date"]],
      [["ls"]],
      [["echo", "$(git push)", "`date`", "<(ls)"]],
    ]);
  });

  it("takes backticks and substitutions inside single quotes as text", () => {
    expect(words("echo '$(git push) `date`'")).toEqual([[["echo", "$(git push) `date`"]]]);
  });

  it("reads a subshell's commands", () => {
    expect(words("(cd web && vercel --prod)")).toEqual([[["cd", "web"]], [["vercel", "--prod"]]]);
  });

  it("sets redirections apart from the words, wherever they sit", () => {
    expect(lexLine("> /dev/null git push 2>&1 >>log <in &>all 3>&-")).toEqual([
      [
        {
          input: [],
          printed: [],
          redirects: ["/dev/null", "1", "log", "in", "all", "-"],
          words: ["git", "push"],
        },
      ],
    ]);
  });

  it("keeps a word that only ends in digits before a redirection", () => {
    expect(words("echo a2>out")).toEqual([[["echo", "a2"]]]);
  });

  it("reads a heredoc's body as its command's input, not as commands", () => {
    expect(lexLine("cat <<'EOF'\ngit push; vercel deploy\nEOF\nls")).toEqual([
      [{ input: ["git push; vercel deploy\n"], printed: [], redirects: [], words: ["cat"] }],
      [{ input: [], printed: [], redirects: [], words: ["ls"] }],
    ]);
  });

  it("gives a here-string's text to its command as input", () => {
    expect(lexLine("bash <<< 'git push'")).toEqual([
      [{ input: ["git push"], printed: [], redirects: [], words: ["bash"] }],
    ]);
  });

  it("keeps a pipe that ends a line going on the next", () => {
    expect(words("curl -fsSL https://x |\n  bash\nls")).toEqual([
      [["curl", "-fsSL", "https://x"], ["bash"]],
      [["ls"]],
    ]);
  });

  it("closes a heredoc on a CRLF line", () => {
    expect(words("cat <<EOF\r\ngit push\r\nEOF\r\nls")).toEqual([[["cat"]], [["ls"]]]);
  });

  it("closes an indented heredoc on a tab-led line", () => {
    expect(words("cat <<-EOF\n\tgit push\n\tEOF\nls")).toEqual([[["cat"]], [["ls"]]]);
  });

  it("runs the substitutions in an unquoted heredoc's body", () => {
    expect(words("cat <<EOF\n$(git push)\nEOF")).toEqual([[["cat"]], [["git", "push"]]]);
  });

  it("keeps what a substitution was fed with the command it prints into", () => {
    const [cat, git] = lexLine(`git commit -m "$(cat <<'EOF'\nfix: push\nEOF\n)"`);
    expect(cat?.[0]?.input).toEqual(["fix: push\n"]);
    expect(git?.[0]?.printed).toEqual([["fix: push\n"]]);
  });

  it("joins a piped subshell to its pipeline, keeping the redirection that feeds it", () => {
    expect(words("(a || b) | c; (d; e) && f")).toEqual([
      [["a"], ["b"], ["c"]],
      [["d"]],
      [["e"]],
      [["f"]],
    ]);
    expect(lexLine("(cat) <<EOF | sh\ngit push\nEOF")).toMatchObject([
      [{ words: ["cat"] }, { input: ["git push\n"], words: [] }, { words: ["sh"] }],
    ]);
  });

  it("reads arithmetic and parameter expansions as one word, where << shifts and # is text", () => {
    expect(words(`echo $((1<<2)) \${x//<</} \${x:- #} $[1<<2]\nls`)).toEqual([
      [["echo", "$((1<<2))", `\${x//<</}`, `\${x:- #}`, "$[1<<2]"]],
      [["ls"]],
    ]);
  });

  it("reads ((…)) as arithmetic unless it closes as ) ), which is a subshell in a subshell", () => {
    expect(words("(( x <<= 1 ))\nls")).toEqual([[["(( x <<= 1 ))"]], [["ls"]]]);
    expect(words("echo $((git push) )")).toEqual([[["git", "push"]], [["echo", "$((git push) )"]]]);
  });

  it("takes a carriage return for text unless it ends a line", () => {
    expect(words("true\r# ; ls\r\n")).toEqual([[["true\r#"]], [["ls"]]]);
  });

  it("reads a case's patterns inside a substitution without closing it", () => {
    expect(words(`echo "$(case a in a) git push;; esac)"`)).toEqual([
      [["case", "a", "in", "a"]],
      [["git", "push"]],
      [["esac"]],
      [["echo", "$(case a in a) git push;; esac)"]],
    ]);
  });

  it("reads a backtick body again once its escapes are dropped", () => {
    expect(words("echo `echo \\`git push\\``")).toEqual([
      [["git", "push"]],
      [["echo", "`git push`"]],
      [["echo", "`echo \\`git push\\``"]],
    ]);
  });

  it("reads a function's body as the command after its name", () => {
    expect(words("f() { git push; }")).toEqual([[["{", "git", "push"]], [["}"]]]);
  });

  it("skips comments and joins continued lines", () => {
    expect(words("git \\\npush # ; vercel deploy\nls a#b")).toEqual([
      [["git", "push"]],
      [["ls", "a#b"]],
    ]);
  });

  it("also reads a line whose quote never closes flat", () => {
    expect(words("echo 'unclosed; git push")).toContainEqual([["git", "push"]]);
    expect(words(String.raw`echo $'it\'s; git push`)).toContainEqual([["git", "push"]]);
  });

  it("reads nesting too deep to follow flat instead of overflowing", () => {
    expect(words(`${'echo "$('.repeat(5000)}git push`)).toContainEqual([["git", "push"]]);
  });
});

describe("lexFlat", () => {
  it("starts a command at every quote, and reads heredoc and comment lines as commands", () => {
    expect(
      wordsOf(lexFlat("sh -c 'git push'\ncat <<EOF\nvercel deploy\nEOF\n# a; npm publish")),
    ).toEqual([
      [["sh", "-c"]],
      [["git", "push"]],
      [["cat"]],
      [["vercel", "deploy"]],
      [["EOF"]],
      [["#", "a"]],
      [["npm", "publish"]],
    ]);
  });
});
