import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const developmentSkills = ["knowledge-schema", "tui", "plugin-agent-authoring", "plugin-release"];

function fail(message) {
  failures.push(message);
}

function read(relative) {
  const file = path.join(root, relative);
  try {
    return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch (error) {
    fail(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function frontmatter(relative, source) {
  if (!source.startsWith("---\n")) {
    fail(`${relative}: YAML frontmatterが無い`);
    return {};
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    fail(`${relative}: YAML frontmatterが閉じていない`);
    return {};
  }
  const fields = {};
  let listKey = null;
  for (const line of source.slice(4, end).split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // ブロックシーケンス（`skills:` の次行以降の `- 値`）を配列として拾う。
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(item[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!match) {
      fail(`${relative}: frontmatterの行を解釈できない: ${line}`);
      continue;
    }
    if (match[2] === "") {
      listKey = match[1];
      fields[listKey] = [];
      continue;
    }
    listKey = null;
    fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

function checkLocalLinks(relative, source) {
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(root, path.dirname(relative), target);
    if (!fs.existsSync(resolved)) fail(`${relative}: 参照先が無い: ${target}`);
  }
}

const agents = read("AGENTS.md");
const lines = agents.trimEnd().split("\n").length;
const bytes = Buffer.byteLength(agents);
if (lines >= 200) fail(`AGENTS.md: ${lines}行。200行未満にする`);
if (!agents.includes("`plugin/skills/review/SKILL.md`を読む")) {
  fail("AGENTS.md: Codexがreview Skillのcheckoutを正本として読む規約が無い");
}
if (!agents.includes("`Skill roots`にある`rN`の値と残りをそのまま結合する")) {
  fail("AGENTS.md: Codexの短縮Skill pathを逐語的に解決する規約が無い");
}

// **Codexはglobal → repo root → CWDまでのAGENTS.mdを連結し、32 KiBで打ち切る。**
// rootだけを見ると、nestedを足したぶんが黙って切り捨てられる。ここではリポジトリ側の合計を見る
// （持ち主の ~/.codex/AGENTS.md はマシンごとに違うので、その分の余白を引いて判定する）。
const CODEX_LIMIT = 32 * 1024;
// 持ち主の ~/.codex/AGENTS.md に見込む分。実測 18,638 bytes（2026-09-20）へ 1 KiB の伸びを足した。
// **これを増やすとリポジトリ側の余白が減る。**足りなくなったら、長い手順を Skill へ移す。
// 入れ子の AGENTS.md は無い（Web の画面と一緒に dashboard/AGENTS.md を消した）。足すなら、その分もここで足す。
const USER_RESERVE = 19 * 1024;
if (bytes > CODEX_LIMIT - USER_RESERVE) {
  fail(
    `AGENTS.mdが${bytes} bytes。Codexの32 KiBからglobal分${USER_RESERVE}を引いた${CODEX_LIMIT - USER_RESERVE}以内にする。` +
      "長い手順は.agents/skills/へ移す",
  );
}
// **CLAUDE.md は Claude Code 専用、AGENTS.md は Codex 専用。**Claude Code は CLAUDE.md があると AGENTS.md を読まず、
// Codex は CLAUDE.md を読まない（どちらも 2026-09-23 に実験で確かめた）。互いを import すると、両方が両方を読む。
const claudeMd = read("CLAUDE.md");
if (/^@\S*AGENTS\.md\s*$/m.test(claudeMd)) fail("CLAUDE.md: AGENTS.mdをimportしている。両者は別々に読ませる");
const claudeLines = claudeMd.trimEnd().split("\n").length;
// 公式の目安は 200 行未満。常時ロードは paths の無い rule と合わせて効くので、CLAUDE.md 単体はその半分に抑える。
if (claudeLines >= 100)
  fail(`CLAUDE.md: ${claudeLines}行。100行未満にし、手順はSkill、fileに紐付く規約はpaths付きのruleへ移す`);
// Codex は Claude Code の仕組み（rule・reviewer・Claude 専用 Skill）を使えない。書くと、無い物を探すか、代わりに別の AI を立てようとする。
for (const word of [".claude/rules", ".claude/agents", "review-shipping", "review-ui", "docs-author"])
  if (agents.includes(word)) fail(`AGENTS.md: Claude Code側の仕組み（${word}）を書いている。Codexは使えない`);

// 両方に写した規約が片側だけで消えないよう、`<!-- invariant: 名前 -->` の集合を突き合わせる。
// 実例: 設定 repository で分けたとき、書き直しで 1 句が片側から消えて気付かれなかった。
const invariants = (source) =>
  new Set([...source.matchAll(/<!-- invariant: ([a-z0-9-]+) -->/g)].map((m) => m[1]));
const claudeSide = new Set(
  ["CLAUDE.md", ...fs.readdirSync(path.join(root, ".claude/rules")).map((f) => `.claude/rules/${f}`)].flatMap(
    (f) => [...invariants(read(f))],
  ),
);
const codexSide = invariants(agents);
if (codexSide.size < 20)
  fail(`AGENTS.md: invariantが${codexSide.size}個しか読めない。印の形が崩れていないか`);
for (const id of claudeSide)
  if (!codexSide.has(id)) fail(`AGENTS.md: invariant ${id} がCLAUDE.md側にだけある`);
for (const id of codexSide)
  if (!claudeSide.has(id)) fail(`CLAUDE.md・.claude/rules: invariant ${id} がAGENTS.md側にだけある`);
const claudeVerification = read(".claude/rules/verification.md");
for (const required of [
  "bun run release:plan -- --base <前回のrelease commit>",
  "`plugin`: 配布物に入る変更",
  "bun run release:prepare -- --base <前回のrelease commit>",
]) {
  if (!claudeVerification.includes(required)) {
    fail(`.claude/rules/verification.md: Claudeのrelease規約に \`${required}\` が無い`);
  }
}

for (const name of developmentSkills) {
  const relative = `.agents/skills/${name}/SKILL.md`;
  const source = read(relative);
  const fields = frontmatter(relative, source);
  if (fields.name !== name) fail(`${relative}: nameがdirectory名と一致しない`);
  if (!fields.description) fail(`${relative}: descriptionが無い`);
  if ((fields.description ?? "").length > 1024) fail(`${relative}: descriptionが1024文字を超えている`);
  if (!source.includes("## Triggers") || !source.includes("## Does not trigger")) {
    fail(`${relative}: trigger / non-triggerの例が揃っていない`);
  }
  if (/\b(TODO|TBD)\b/.test(source)) fail(`${relative}: 未完成のplaceholderがある`);
  checkLocalLinks(relative, source);

  const claudePath = path.join(root, `.claude/skills/${name}`);
  try {
    if (!fs.lstatSync(claudePath).isSymbolicLink()) fail(`.claude/skills/${name}: symlinkではない`);
    if (fs.realpathSync(claudePath) !== fs.realpathSync(path.join(root, `.agents/skills/${name}`))) {
      fail(`.claude/skills/${name}: Codex側の正本と同じdirectoryを指していない`);
    }
  } catch (error) {
    fail(`.claude/skills/${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const releaseGuide = read(".agents/skills/plugin-release/SKILL.md");
const releaseStart = releaseGuide.indexOf("## 届けるまで");
const releaseEnd = releaseGuide.indexOf("## 届いたことを確かめる");
const releaseSteps =
  releaseStart === -1 || releaseEnd === -1 ? "" : releaseGuide.slice(releaseStart, releaseEnd);
const releaseOrder = [
  "npm publish <file>.tgz --tag next",
  "npm pack gleanery@<version> --silent",
  "mainへmergeする",
  "git diff --exit-code <reviewed commit> <merge commit>",
  "git tag v<version> <merge commit>",
  "npm dist-tag add gleanery@<version> latest",
  "npm pack gleanery@latest --silent",
];
let releaseCursor = -1;
for (const step of releaseOrder) {
  const position = releaseSteps.indexOf(step);
  if (position === -1) {
    fail(`.agents/skills/plugin-release/SKILL.md: release手順に \`${step}\` が無い`);
  } else if (position <= releaseCursor) {
    fail(`.agents/skills/plugin-release/SKILL.md: release手順の \`${step}\` の順序が逆転している`);
  } else {
    releaseCursor = position;
  }
}
for (const [publish] of releaseSteps.matchAll(/npm publish[^\n`]*/g)) {
  if (!publish.includes("--tag next")) {
    fail(".agents/skills/plugin-release/SKILL.md: merge前のnpm publishは--tag nextでlatestを動かさない");
  }
}

try {
  const pluginManifest = JSON.parse(read("plugin/.codex-plugin/plugin.json"));
  if (pluginManifest.skills !== "./skills/") {
    fail("plugin/.codex-plugin/plugin.json: 利用者向けSkillの置き場所は./skills/に限る");
  }
  if (pluginManifest.hooks !== "./hooks/codex.json") {
    fail("plugin/.codex-plugin/plugin.json: Codexのhookは./hooks/codex.jsonを読む");
  }
  const codexHooks = JSON.parse(read("plugin/hooks/codex.json")).hooks;
  const codexCapture = ["$", '{PLUGIN_ROOT}/dist/capture.js" codex'].join("");
  const codexCaptureWindows =
    "powershell.exe -NoProfile -NonInteractive -Command node $env:PLUGIN_ROOT/dist/capture.js codex";
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt"]) {
    const commands = codexHooks?.[event]?.flatMap((group) => group.hooks ?? []) ?? [];
    if (!commands.some((hook) => hook.command?.includes(codexCapture))) {
      fail(`plugin/hooks/codex.json: ${event}がCodexの自動記録へ繋がっていない`);
    }
    if (!commands.some((hook) => hook.commandWindows === codexCaptureWindows)) {
      fail(`plugin/hooks/codex.json: ${event}のWindows用自動記録がない`);
    }
    if (commands.some((hook) => hook.async)) {
      fail(`plugin/hooks/codex.json: ${event}を非同期にすると会話の順序を保てない`);
    }
  }
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const entry = marketplace.plugins?.[0];
  const src = entry?.source;
  if (src?.source !== "npm" || src?.package !== "gleanery") {
    fail(".claude-plugin/marketplace.json: 配布sourceはnpmのgleaneryに限る");
  } else if (!/^\d+\.\d+\.\d+$/.test(src.version ?? "")) {
    // 範囲やlatestを書くと、同じcommitが時期によって別のtarballを解決する。
    fail(`.claude-plugin/marketplace.json: versionはexactにする（受け取った値: ${src.version}）`);
  }
  if (entry?.version !== undefined) {
    // 両方に置くとClaude Codeは警告なくplugin.jsonを使い、marketplaceの値が黙って無視される。
    fail(".claude-plugin/marketplace.json: versionはsourceの中だけに置く");
  }
} catch (error) {
  fail(`plugin manifest: ${error instanceof Error ? error.message : String(error)}`);
}

const skillDirectory = path.join(root, "plugin/skills");
const pluginSkills = fs
  .readdirSync(skillDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const name of pluginSkills) {
  const relative = `plugin/skills/${name}/SKILL.md`;
  const source = read(relative);
  const fields = frontmatter(relative, source);
  if (fields.name !== name) fail(`${relative}: nameがdirectory名と一致しない`);
  if (!fields.description) fail(`${relative}: descriptionが無い`);
  if ((fields.description ?? "").length > 1024) fail(`${relative}: descriptionが1024文字を超えている`);
  // reviewのSKILLは呼ぶたび全文がcontextへ載る。**追記で膨らませない**ための回帰の上限で、
  // 品質を測る数字ではない。相手モデルを使うときだけ読む手順はreferences/へ出してある。
  // 超えたら上限を上げる前に、同じ概念の重複を消す。
  if (name === "review" && source.split("\n").length > 497) {
    fail(
      `${relative}: ${source.split("\n").length}行。497行以下にする（節を足したなら同じ概念の重複を消す）`,
    );
  }
  checkLocalLinks(relative, source);

  // Codexはdisable-model-invocationを解釈しないので、明示起動だけにするにはopenai.yamlも要る。
  const policy = path.join(skillDirectory, name, "agents/openai.yaml");
  const codexExplicitOnly =
    fs.existsSync(policy) &&
    /^policy:\n\s+allow_implicit_invocation:\s*false\s*$/m.test(
      fs.readFileSync(policy, "utf8").replaceAll("\r\n", "\n"),
    );
  if ((fields["disable-model-invocation"] === "true") !== codexExplicitOnly) {
    fail(
      `${relative}: disable-model-invocation: trueとagents/openai.yamlのallow_implicit_invocation: falseが揃っていない`,
    );
  }

  // CodexのPATHにgleaneryは無い（exit 127を観測）。**shell scriptを挟まずpackage内のJSを直接起動する** —
  // npmの`bin`はplugin内のPATHへ公開される契約が無く、POSIX shellはWindowsで動かない。
  if (/\}\/bin\/gleanery|\.\.\/\.\.\/bin\/gleanery/m.test(source)) {
    fail(`${relative}: bin/gleaneryは使わない。node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js" の形で呼ぶ`);
  }
  if (/Bash\(gleanery |^gleanery /m.test(source)) {
    fail(`${relative}: 素のgleaneryはCodexのPATHに無い。package内のdist/cli.jsを直接起動する`);
  }
  if (/dist\/cli\.js/.test(source) && !source.includes("../../dist/cli.js")) {
    fail(`${relative}: gleaneryのCLIを呼ぶのに、Codex用の../../dist/cli.jsが無い`);
  }
}

// claude --help の choices。渡した値が外れると Warning だけ出てセッション既定へ落ちる。
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// repository 専用の reviewer（.claude/agents）を見る。配る reviewer は Agent 定義ではなく
// plugin/skills/review/reviewers/ の本文になったので、frontmatter を持たない
// （そちらの検査は check-pairs.mjs が持つ）。
const agentDirectories = [".claude/agents"];
const agentEntries = agentDirectories.flatMap((directory) => {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${directory}/${file}`);
});
const agentFiles = agentEntries;
for (const relative of agentEntries) {
  const file = path.basename(relative);
  const source = read(relative);
  const fields = frontmatter(relative, source);
  for (const required of ["name", "description", "tools", "model", "effort", "maxTurns"]) {
    if (!fields[required]) fail(`${relative}: ${required}が無い`);
  }
  if (fields.name !== path.basename(file, ".md")) fail(`${relative}: nameがfile名と一致しない`);
  if (fields.model === "inherit") fail(`${relative}: modelをsessionから継承しない`);
  if (!EFFORT_LEVELS.has(fields.effort)) {
    fail(`${relative}: effortは${[...EFFORT_LEVELS].join(" / ")}のどれかにする（${fields.effort}）`);
  }
  // 本文でも effort を名指しして理由を書いている定義がある。片方だけ直すと、読む人と CLI が違う値を見る。
  const named = /`effort: ([a-z]+)`/.exec(source.replace(/^---\n[\s\S]*?\n---\n/, ""));
  if (named && named[1] !== fields.effort) {
    fail(`${relative}: frontmatterのeffortは${fields.effort}だが本文は${named[1]}と書いている`);
  }
  // プリロードするSkillが無ければ、その名前は解決されず本文の前提が崩れる。
  for (const name of Array.isArray(fields.skills) ? fields.skills : []) {
    const repoSkill = fs.existsSync(path.join(root, ".agents/skills", name, "SKILL.md"));
    const pluginSkill = fs.existsSync(path.join(root, "plugin/skills", name, "SKILL.md"));
    if (!repoSkill && !pluginSkill) fail(`${relative}: skills の ${name} が実在しない`);
  }
  if (!Number.isInteger(Number(fields.maxTurns)) || Number(fields.maxTurns) <= 0) {
    fail(`${relative}: maxTurnsは正の整数にする`);
  }
}

// 作り替えで消した前提（PostgreSQL・Docker・埋め込み・鍵）が、AI の読む文書へ戻っていないか。戻ると、AI は無い
// command や鍵を案内する。文書の説明で旧構成に触れるときは「旧構成」と書き、この一覧の綴りを避ける。
const GONE = [
  /pgvector/i,
  /VOYAGE_API_KEY/,
  /GLEANERY_DB_URL/,
  /docker compose/i,
  /halfvec/i,
  /tsvector/i,
  /db:roles/,
];
const docs = [
  "AGENTS.md",
  "CLAUDE.md",
  ...fs.readdirSync(path.join(root, ".claude/rules")).map((f) => `.claude/rules/${f}`),
  ...developmentSkills.map((name) => `.agents/skills/${name}/SKILL.md`),
  ...pluginSkills.map((name) => `plugin/skills/${name}/SKILL.md`),
  ...pluginSkills.flatMap((name) => {
    const dir = path.join(root, "plugin/skills", name, "references");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => `plugin/skills/${name}/references/${f}`)
      : [];
  }),
  ...agentFiles,
  // 配る manifest の keywords と説明も、利用者に旧構成を見せる
  "plugin/package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];
for (const relative of docs) {
  const source = read(relative);
  for (const word of GONE)
    if (word.test(source)) fail(`${relative}: 消した前提の語（${word.source}）が戻っている`);
}

if (failures.length > 0) {
  console.error(failures.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}

console.log(
  `AI設定: CLAUDE ${claudeLines}行、AGENTS ${lines}行 / ${bytes} bytes、invariant ${codexSide.size}件、開発Skill ${developmentSkills.length}件、plugin Skill ${pluginSkills.length}件、Agent ${agentFiles.length}件`,
);
