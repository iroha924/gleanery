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
  for (const line of source.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line);
    if (!match) {
      fail(`${relative}: frontmatterの行を解釈できない: ${line}`);
      continue;
    }
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
const USER_RESERVE = 20 * 1024; // 持ち主のglobal指示に見込む分
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

const agentDirectory = path.join(root, "plugin/agents");
const agentFiles = fs.readdirSync(agentDirectory).filter((file) => file.endsWith(".md"));
for (const file of agentFiles) {
  const relative = `plugin/agents/${file}`;
  const fields = frontmatter(relative, read(relative));
  for (const required of ["name", "description", "tools", "model", "effort", "maxTurns"]) {
    if (!fields[required]) fail(`${relative}: ${required}が無い`);
  }
  if (fields.name !== path.basename(file, ".md")) fail(`${relative}: nameがfile名と一致しない`);
  if (fields.model === "inherit") fail(`${relative}: modelをsessionから継承しない`);
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
