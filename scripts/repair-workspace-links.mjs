import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function workspaceDirectories() {
  const yaml = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
  const directories = [];
  for (const pattern of patterns) {
    const base = path.join(root, pattern.replace(/\/\*$/, ''));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(base, entry.name));
    }
  }
  return directories;
}

const workspacePackages = workspaceDirectories()
  .map((directory) => {
    const manifestPath = path.join(directory, 'package.json');
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return { directory, name: manifest.name, manifest };
  })
  .filter((entry) => entry && typeof entry.name === 'string');

const packageByName = new Map(workspacePackages.map((entry) => [entry.name, entry]));

const consumers = [
  ...workspacePackages,
  { directory: root, manifest: { dependencies: Object.fromEntries(workspacePackages.map((entry) => [entry.name, '*'])) } }
];

function dependencyEntry(consumerDirectory, name) {
  const segments = name.split('/');
  const leaf = segments.pop();
  const parent = path.join(consumerDirectory, 'node_modules', ...segments);
  try {
    return readdirSync(parent, { withFileTypes: true }).find((entry) => entry.name === leaf) ?? null;
  } catch {
    return null;
  }
}

function isBrokenLink(linkPath) {
  try {
    realpathSync(linkPath);
    return false;
  } catch {
    return true;
  }
}

let repaired = 0;
for (const consumer of consumers) {
  const { dependencies, devDependencies, optionalDependencies } = consumer.manifest;
  const declared = { ...dependencies, ...devDependencies, ...optionalDependencies };
  for (const name of Object.keys(declared)) {
    const target = packageByName.get(name);
    if (!target) continue;
    const entry = dependencyEntry(consumer.directory, name);
    if (!entry || !entry.isSymbolicLink()) continue;
    const linkPath = path.join(consumer.directory, 'node_modules', ...name.split('/'));
    if (!isBrokenLink(linkPath)) continue;

    try {
      rmdirSync(linkPath);
    } catch {
      unlinkSync(linkPath);
    }
    mkdirSync(linkPath, { recursive: true });
    cpSync(target.directory, linkPath, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules'
    });
    repaired += 1;
    console.log(`[workspace-links] rebuilt ${name} in ${path.relative(root, consumer.directory) || '.'}`);
  }
}

console.log(`[workspace-links] repaired ${repaired} broken link(s)`);
