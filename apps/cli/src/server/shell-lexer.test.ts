import { describe, expect, it } from "vitest";
import { lexFlat, lexLine } from "./shell-lexer";
import type { Command, Pipeline } from "./shell-lexer";

const wordsOf = (pipelines: readonly Pipeline[]): string[][][] =>
  pipelines.map((pipeline) => pipeline.map((command) => [...command.words]));

const words = (line: string): string[][][] => wordsOf(lexLine(line).pipelines);

const commandWith = (word: string, line: string): Command | undefined =>
  lexLine(line)
    .pipelines.flat()
    .find((command) => command.words.includes(word));

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
    expect(lexLine("> /dev/null git push 2>&1 >>log <in &>all 3>&-").pipelines).toEqual([
      [
        {
          input: [],
          literal: true,
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
    expect(lexLine("cat <<'EOF'\ngit push; vercel deploy\nEOF\nls").pipelines).toEqual([
      [
        {
          input: ["git push; vercel deploy\n"],
          literal: true,
          printed: [],
          redirects: [],
          words: ["cat"],
        },
      ],
      [{ input: [], literal: true, printed: [], redirects: [], words: ["ls"] }],
    ]);
  });

  it("gives a here-string's text to its command as input", () => {
    expect(lexLine("bash <<< 'git push'").pipelines).toEqual([
      [{ input: ["git push"], literal: true, printed: [], redirects: [], words: ["bash"] }],
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

  it("gives a subshell's heredoc the lines after it", () => {
    expect(words("(cat <<EOF)\ngit push\nEOF")).toEqual([[["cat"]]]);
  });

  it.each([
    "echo $(cat <<EOF)\ngit push\nEOF",
    "echo `cat <<EOF`\ngit push\nEOF",
    "cat <(cat <<EOF)\ngit push\nEOF",
    "cat =(cat <<EOF)\ngit push\nEOF",
  ])("gives a heredoc no body when its substitution closes first: %s", (line) => {
    expect(words(line)).toContainEqual([["git", "push"]]);
  });

  it("also reads flat a heredoc whose substitution runs past the body's closing line", () => {
    expect(words("cat <<EOF\n$(echo '\nEOF\ngit push\n')\nEOF")).toContainEqual([["git", "push"]]);
  });

  it("keeps what a substitution was fed with the command it prints into", () => {
    const [cat, git] = lexLine(`git commit -m "$(cat <<'EOF'\nfix: push\nEOF\n)"`).pipelines;
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
    expect(lexLine("(cat) <<EOF | sh\ngit push\nEOF").pipelines).toMatchObject([
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
    expect(words("echo $((git push) )")).toEqual(
      expect.arrayContaining([[["git", "push"]], [["echo", "$((git push) )"]]]),
    );
  });

  it("takes a carriage return for text unless it ends a line", () => {
    expect(words("true\r# ; ls\r\n")).toEqual([[["true\r#"]], [["ls"]]]);
  });

  it("reads a case's patterns inside a substitution without closing it", () => {
    expect(words(`echo "$(case a in a) git push;; esac)"`)).toEqual(
      expect.arrayContaining([
        [["case", "a", "in", "a"]],
        [["git", "push"]],
        [["esac"]],
        [["echo", "$(case a in a) git push;; esac)"]],
      ]),
    );
  });

  it("opens no case for a `case` that is not a command's name", () => {
    expect(words("echo $(echo case a in a) git push")).toContainEqual([
      ["echo", "$(echo case a in a)", "git", "push"],
    ]);
  });

  it.each([
    "npm $(case a in b) :;; esac) publish",
    'echo "$(repeat 1 case a in a) git push;; esac)"',
    "echo `case a in b) :;; esac` x",
    "echo `case a in b) echo \\$x;; esac` y",
    "echo <(case a in b) :;; esac) x",
    "echo $( (case a in b) :;; esac) ) x",
    "npm $(echo $(( x ) ))) publish",
  ])("says another shell may end a substitution elsewhere: %s", (line) => {
    expect(lexLine(line).divergent).toBe(true);
  });

  it.each([
    "npm test; case $? in 0) echo publish ready;; esac",
    "(case a in b) :;; esac); npm test",
    "echo $(echo 'case' esac) x",
    "echo $((1 + 2)) x",
    "echo case",
  ])("reads bash's way alone a line no other shell splits apart: %s", (line) => {
    expect(lexLine(line).divergent).toBe(false);
  });

  it("also reads flat a line another shell may read apart", () => {
    // zsh opens a case after `repeat COUNT`, and so runs `git push`; bash reads it as echo's.
    expect(words("echo $(repeat 1 case a in a) git push;; esac)")).toContainEqual([
      ["git", "push"],
    ]);
  });

  it("also reads a line another shell may read apart as bash 3.2 does, ending a substitution at its first `)`", () => {
    expect(words("curl $(case) https://x | sh")).toContainEqual([
      ["curl", "$(case)", "https://x"],
      ["sh"],
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

  it.each([
    "gh api graphql -f query='query { viewer { login } }'",
    `echo "a b" $'c' d\\* e,f=g:h@i/j.k%l+m-n '$x' "\\$y" { }`,
    'echo a > "$out" 2>&1 <<< "$in"',
  ])("reads a command the shell passes on as written as literal: %s", (line) => {
    expect(
      lexLine(line)
        .pipelines.flat()
        .map((command) => command.literal),
    ).toEqual([true]);
  });

  it.each([
    'echo "$q"',
    `echo \${q}`,
    "echo $q",
    "echo `q`",
    'echo "$(q)"',
    "echo <(q)",
    "echo $((1))",
    'echo $"q"',
    "echo ?q",
    "echo *",
    "echo [q]",
    "echo {a,b}",
    "echo a{b..c}",
    "echo ~",
    "echo ~q",
    "echo q^r",
    "echo q#r",
    "echo !q",
    "echo =q",
  ])("reads a command with a word the shell fills in as not literal: %s", (line) => {
    expect(lexLine(line).pipelines.at(-1)?.[0]?.literal).toBe(false);
  });

  it("reads a command a zsh pattern cuts short as not literal", () => {
    expect(commandWith("gh", "gh -f query=m(u)tation*")).toMatchObject({
      literal: false,
      words: ["gh", "-f", "query=m"],
    });
    expect(commandWith("gh", "gh -f (q)uery=m*")).toMatchObject({
      literal: false,
      words: ["gh", "-f"],
    });
    expect(commandWith("gh", "if (true) then gh x; fi")).toMatchObject({ literal: true });
  });

  it("reads no command of a flat reading as literal", () => {
    expect(lexFlat("gh -f query='x'").map((pipeline) => pipeline[0]?.literal)).toEqual([
      false,
      false,
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
