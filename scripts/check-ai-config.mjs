import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const developmentSkills = [
  "deploy",
  "knowledge-schema",
  "next-hono",
  "plugin-agent-authoring",
  "plugin-release",
];

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
if (bytes > 32 * 1024) fail(`AGENTS.md: ${bytes} bytes。Codex既定の32 KiBを超えている`);
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
  if (marketplace.plugins?.[0]?.source !== "./plugin") {
    fail(".claude-plugin/marketplace.json: 配布sourceは./pluginに限る");
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

  // CodexのPATHにmitosは無い（exit 127を観測）。
  if (/Bash\(mitos |^mitos |\}\/bin\/mitos/m.test(source) && !source.includes("../../bin/mitos")) {
    fail(`${relative}: mitosのCLIを呼ぶのに、Codex用の../../bin/mitosが無い`);
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
