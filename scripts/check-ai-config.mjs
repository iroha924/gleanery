import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const developmentSkills = ["knowledge-schema", "ui-hono", "plugin-agent-authoring", "plugin-release"];

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

// **Codexはglobal → repo root → CWDまでのAGENTS.mdを連結し、32 KiBで打ち切る。**
// rootだけを見ると、nestedを足したぶんが黙って切り捨てられる。ここではリポジトリ側の合計を見る
// （持ち主の ~/.codex/AGENTS.md はマシンごとに違うので、その分の余白を引いて判定する）。
const CODEX_LIMIT = 32 * 1024;
// 持ち主の ~/.codex/AGENTS.md に見込む分。実測 18,638 bytes（2026-09-20）へ 1 KiB の伸びを足した。
// **これを増やすとリポジトリ側の余白が減る。**足りなくなったら、まず nested を Skill へ移す。
const USER_RESERVE = 19 * 1024;
const nested = ["dashboard/AGENTS.md"];
const nestedBytes = nested.map((f) => Buffer.byteLength(read(f)));
const repoTotal = bytes + nestedBytes.reduce((a, b) => a + b, 0);
if (repoTotal > CODEX_LIMIT - USER_RESERVE) {
  fail(
    `AGENTS.mdの合計が${repoTotal} bytes（root ${bytes} + nested ${nestedBytes.join(" + ")}）。` +
      `Codexの32 KiBからglobal分${USER_RESERVE}を引いた${CODEX_LIMIT - USER_RESERVE}以内にする。` +
      "長い手順は.agents/skills/へ移す",
  );
}
if (read("CLAUDE.md").trim() !== "@AGENTS.md") fail("CLAUDE.md: @AGENTS.mdだけを正本として読む形ではない");
if (read("dashboard/CLAUDE.md").trim() !== "@AGENTS.md") {
  fail("dashboard/CLAUDE.md: dashboard/AGENTS.mdをimportしていない");
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

try {
  const pluginManifest = JSON.parse(read("plugin/.codex-plugin/plugin.json"));
  if (pluginManifest.skills !== "./skills/") {
    fail("plugin/.codex-plugin/plugin.json: 利用者向けSkillの入口は./skills/に限る");
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

// 範囲の読み方の正本は起動側の 1 箇所にしかない。消えてもレビュアーは「渡された読み方だけを使う」と
// 書いてあるだけなので、どのレーンも範囲を受け取れないまま検査は通る。
const REVIEW_SKILL = "plugin/skills/review/SKILL.md";
const SCOPE_CONTRACT = ["コミット済み", "未コミット・追跡済み", "未追跡", "gh pr diff"];
// review-validator は finding を 1 件受け取る体で、範囲を渡されない。
const REVIEWERS_WITH_SCOPE = new Set([
  "review-adversarial",
  "review-cleanup",
  "review-conventions",
  "review-precedent",
  "review-security",
]);
const SCOPE_BOUNDARY = [
  "範囲は起動側が",
  "渡された読み方だけを使い",
  "渡された層だけがレビュー対象",
  "現在のファイルを読みにいかず",
];
// claude --help の choices。渡した値が外れると Warning だけ出てセッション既定へ落ちる。
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

const reviewSkill = read(REVIEW_SKILL);
const scopeTable = /^\| 層 \| 渡す形 \|$\n^\|---\|---\|$\n(?:^\|.*$\n)+/m.exec(reviewSkill);
if (!scopeTable) {
  fail(`${REVIEW_SKILL}: 範囲の「渡す形」の表が無い`);
} else {
  for (const phrase of SCOPE_CONTRACT) {
    if (!scopeTable[0].includes(phrase)) fail(`${REVIEW_SKILL}: 「渡す形」の表から「${phrase}」が消えている`);
  }
}
if (!reviewSkill.includes("空だった層")) {
  fail(`${REVIEW_SKILL}: 空の層も渡すという指示が消えている`);
}

// 配る reviewer（plugin/agents）と repository 専用（.claude/agents）を同じ規則で見る。
// **片方だけ検査すると、もう片方の壊れ方が静かに残る。**
const agentDirectories = ["plugin/agents", ".claude/agents"];
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
  // 範囲の境界。1 文でも欠けたレビュアーは、範囲が解決しないとき現在のツリーを読みにいく。
  if (REVIEWERS_WITH_SCOPE.has(path.basename(relative, ".md"))) {
    for (const phrase of SCOPE_BOUNDARY) {
      if (!source.includes(phrase)) fail(`${relative}: 範囲の境界から「${phrase}」が消えている`);
    }
  }
  for (const required of ["name", "description", "tools", "model", "effort", "maxTurns"]) {
    if (!fields[required]) fail(`${relative}: ${required}が無い`);
  }
  if (fields.name !== path.basename(file, ".md")) fail(`${relative}: nameがfile名と一致しない`);
  if (fields.model === "inherit") fail(`${relative}: modelをsessionから継承しない`);
  if (!EFFORT_LEVELS.has(fields.effort)) {
    fail(`${relative}: effortは${[...EFFORT_LEVELS].join(" / ")}のどれかにする（${fields.effort}）`);
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

if (failures.length > 0) {
  console.error(failures.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}

console.log(
  `AI設定: AGENTS ${lines}行 / ${bytes} bytes、開発Skill ${developmentSkills.length}件、plugin Skill ${pluginSkills.length}件、Agent ${agentFiles.length}件`,
);
