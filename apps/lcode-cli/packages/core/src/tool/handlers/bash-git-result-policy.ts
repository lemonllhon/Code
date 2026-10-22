import { analyzeBashCommand } from "./bash-command-parser.js";
import { gitSemanticSubcommandName } from "./bash-semantics.js";

/** 仅阻止静态可识别的吞错写法；不解析/改写任意脚本或更改全局 Shell 语义。 */
export function assertGitNetworkResultVisible(command: string) {
  const analysis = analyzeBashCommand(command);
  const network = analysis.commands.findIndex((c) => {
    const git = /(?:^|[/\\])git(?:\.exe)?$/i;
    const index = git.test(c.name)
      ? 0
      : ["timeout", "env", "command"].includes(c.name)
        ? c.argv.findIndex((a) => git.test(a))
        : -1;
    return (
      index >= 0 &&
      ["fetch", "push", "ls-remote"].includes(gitSemanticSubcommandName(c.argv.slice(index)) ?? "")
    );
  });
  if (network < 0) return;
  const after = analysis.commands.slice(network + 1);
  const risky =
    analysis.commands[network]!.hasRedirects ||
    after.some((c) => c.operatorBefore !== "&&") ||
    analysis.hasDynamicWords ||
    analysis.hasParseErrors;
  if (risky)
    throw new Error(
      "Git network errors and exit codes must remain visible. Use separate Git tool fetch/push/ls-remote calls; do not pipe, discard errors, or append commands that mask failure. No part of this command was executed.",
    );
}
