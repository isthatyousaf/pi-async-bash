#!/bin/sh
# Link the installed Pi packages into node_modules for typechecking and tests.
# Pi provides these modules to extensions at runtime; they are not dependencies.
set -eu
PI_BIN="$(command -v pi || true)"
cd "$(dirname "$0")/.."
node --input-type=commonjs - "${PI_ROOT:-}" "$PI_BIN" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const host = '@earendil-works/pi-coding-agent';
const readPackage = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return undefined; }
};
let root = process.argv[2];
if (!root && process.argv[3]) {
  let dir = path.dirname(fs.realpathSync(process.argv[3]));
  for (;;) {
    if (readPackage(dir)?.name === host) { root = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
if (!root || readPackage(root)?.name !== host) {
  throw new Error('Cannot locate installed Pi. Set PI_ROOT to its pi-coding-agent package directory.');
}
root = fs.realpathSync(root);
const req = createRequire(path.join(root, 'package.json'));
const packages = [host, '@earendil-works/pi-tui', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', 'typebox'];
// Check every target before changing any links. Read manifests directly: some peers have import-only exports.
const links = packages.map((name) => {
  const target = name === host ? root : (req.resolve.paths(name) ?? [])
    .map((dir) => path.join(dir, name)).find((dir) => readPackage(dir)?.name === name);
  if (!target) throw new Error(`Pi dependency ${name} is missing from ${root}`);
  const dest = path.resolve('node_modules', name);
  let existing;
  try { existing = fs.lstatSync(dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${dest} is not a symlink. Install development dependencies with bun install --omit peer in a clean checkout.`);
  }
  return { target: fs.realpathSync(target), dest, existing };
});
for (const { target, dest, existing } of links) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (existing) fs.unlinkSync(dest);
  fs.symlinkSync(target, dest, 'dir');
}
console.log(`Linked Pi ${readPackage(root).version} from ${root}`);
JS
