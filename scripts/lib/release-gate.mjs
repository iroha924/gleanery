// tag から npm へ stage してよいかの判定。release.yml の prepare と stage が同じ判定を通る。
// 入力は git と GitHub API から集めたもので、ここでは判定だけをする（test で全部の分岐を通す）。

const REQUIRED_WORKFLOWS = ["check", "pr-body"];

/** 判定の失敗の一覧と、tag の commit を head に持つ PR の番号。problems が空なら stage してよい。 */
export function gateProblems({ tag, commit, repo, versions, mainIsAncestor, pulls, runs }) {
  const problems = [];
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match) problems.push(`tag ${tag} は v<version> の形ではない`);
  else
    for (const [key, version] of Object.entries(versions))
      if (version !== match[1]) problems.push(`tag ${tag} と ${key} の version ${version} が一致しない`);

  // main が tag の commit の祖先なら、PR の CI が検査した仮の merge commit の tree は tag の commit の tree と同じになる
  if (!mainIsAncestor)
    problems.push("tag の commit が今の main を取り込んでいない。PR の branch に main を merge し直す");

  const heads = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.base?.ref === "main" &&
      pull.head?.sha === commit &&
      pull.head?.repo?.full_name === repo,
  );
  if (heads.length !== 1)
    problems.push(
      `tag の commit を head に持つ、main へ向かう open な同じリポジトリの PR が 1 本ではない（${heads.length} 本）`,
    );

  for (const name of REQUIRED_WORKFLOWS) {
    const latest = runs
      .filter((run) => run.name === name && run.event === "pull_request" && run.head_sha === commit)
      .sort((a, b) => b.id - a.id)[0];
    if (!latest) problems.push(`${name} がこの commit の PR で走っていない`);
    else if (latest.status !== "completed" || latest.conclusion !== "success")
      problems.push(`${name} の最後の実行が成功していない（${latest.status} / ${latest.conclusion}）`);
  }
  return { problems, pull: heads.length === 1 ? heads[0].number : null };
}
