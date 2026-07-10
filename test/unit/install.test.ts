import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInstall } from '../../src/cli/commands/install.js';

interface EnvSandbox {
  claudeConfig: string;
  opencodePlugins: string;
}

function withTempTargets<T>(fn: (dirs: EnvSandbox) => Promise<T>): Promise<T> {
  const claudeConfig = mkdtempSync(path.join(os.tmpdir(), 'aistats-install-cc-'));
  const opencodePlugins = mkdtempSync(path.join(os.tmpdir(), 'aistats-install-oc-'));
  const prevClaudeConfig = process.env['AISTATS_CLAUDE_CONFIG'];
  const prevOpencodePlugins = process.env['AISTATS_OPENCODE_PLUGINS'];
  process.env['AISTATS_CLAUDE_CONFIG'] = claudeConfig;
  process.env['AISTATS_OPENCODE_PLUGINS'] = opencodePlugins;

  return fn({ claudeConfig, opencodePlugins }).finally(() => {
    if (prevClaudeConfig === undefined) delete process.env['AISTATS_CLAUDE_CONFIG'];
    else process.env['AISTATS_CLAUDE_CONFIG'] = prevClaudeConfig;
    if (prevOpencodePlugins === undefined) delete process.env['AISTATS_OPENCODE_PLUGINS'];
    else process.env['AISTATS_OPENCODE_PLUGINS'] = prevOpencodePlugins;
  });
}

function skillPath(claudeConfig: string): string {
  return path.join(claudeConfig, 'skills', 'aistats', 'SKILL.md');
}

function hookPath(claudeConfig: string): string {
  return path.join(claudeConfig, 'global', 'hooks', 'aistats-ingest.sh');
}

function pluginPath(opencodePlugins: string): string {
  return path.join(opencodePlugins, 'aistats.js');
}

void test('install --claude-code copies the skill and an executable, syntax-valid hook script', async () => {
  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall(['--claude-code']);

    const skill = skillPath(claudeConfig);
    assert.ok(existsSync(skill), 'skill file should be copied');
    const skillContent = readFileSync(skill, 'utf8');
    assert.match(skillContent, /^---\nname: aistats\n/, 'skill should carry minimal frontmatter with name: aistats');
    assert.match(skillContent, /aistats report/);

    const hook = hookPath(claudeConfig);
    assert.ok(existsSync(hook), 'hook script should be copied');
    const mode = statSync(hook).mode;
    assert.ok((mode & 0o111) !== 0, 'hook script should be executable (chmod +x)');
    const hookContent = readFileSync(hook, 'utf8');
    assert.match(hookContent, /transcript_path/);
    assert.match(hookContent, /aistats ingest --session/);
    assert.match(hookContent, /aistats ingest --tool cc/);

    const syntaxCheck = spawnSync('sh', ['-n', hook]);
    assert.equal(syntaxCheck.status, 0, `hook script must be valid POSIX sh: ${syntaxCheck.stderr.toString()}`);

    // --opencode was not requested, so the plugin must not have been touched.
    assert.equal(existsSync(pluginPath(opencodePlugins)), false);
  });
});

void test('install --opencode copies the plugin only', async () => {
  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall(['--opencode']);

    const plugin = pluginPath(opencodePlugins);
    assert.ok(existsSync(plugin), 'plugin file should be copied');
    const pluginContent = readFileSync(plugin, 'utf8');
    assert.match(pluginContent, /session\.idle/);
    assert.match(pluginContent, /aistats ingest --tool opencode/);

    const syntaxCheck = spawnSync(process.execPath, ['--check', plugin]);
    assert.equal(syntaxCheck.status, 0, `plugin must be syntactically valid JS: ${syntaxCheck.stderr.toString()}`);

    assert.equal(existsSync(skillPath(claudeConfig)), false, '--claude-code was not requested');
    assert.equal(existsSync(hookPath(claudeConfig)), false, '--claude-code was not requested');
  });
});

void test('install with no flags (and --all) installs both', async () => {
  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall([]);
    assert.ok(existsSync(skillPath(claudeConfig)));
    assert.ok(existsSync(hookPath(claudeConfig)));
    assert.ok(existsSync(pluginPath(opencodePlugins)));
  });

  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall(['--all']);
    assert.ok(existsSync(skillPath(claudeConfig)));
    assert.ok(existsSync(hookPath(claudeConfig)));
    assert.ok(existsSync(pluginPath(opencodePlugins)));
  });
});

void test('install --dry-run writes nothing', async () => {
  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall(['--all', '--dry-run']);
    assert.equal(existsSync(skillPath(claudeConfig)), false);
    assert.equal(existsSync(hookPath(claudeConfig)), false);
    assert.equal(existsSync(pluginPath(opencodePlugins)), false);
    // Dry run must not even create the parent directories.
    assert.equal(existsSync(path.join(claudeConfig, 'skills')), false);
    assert.equal(existsSync(path.join(claudeConfig, 'global')), false);
  });
});

void test('install --all is idempotent (safe to re-run, overwrites in place)', async () => {
  await withTempTargets(async ({ claudeConfig, opencodePlugins }) => {
    await runInstall(['--all']);
    const firstSkill = readFileSync(skillPath(claudeConfig), 'utf8');
    const firstHook = readFileSync(hookPath(claudeConfig), 'utf8');
    const firstPlugin = readFileSync(pluginPath(opencodePlugins), 'utf8');

    await runInstall(['--all']);
    assert.equal(readFileSync(skillPath(claudeConfig), 'utf8'), firstSkill);
    assert.equal(readFileSync(hookPath(claudeConfig), 'utf8'), firstHook);
    assert.equal(readFileSync(pluginPath(opencodePlugins), 'utf8'), firstPlugin);
    assert.ok((statSync(hookPath(claudeConfig)).mode & 0o111) !== 0, 'hook stays executable after re-install');
  });
});
