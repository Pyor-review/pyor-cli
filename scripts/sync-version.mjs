#!/usr/bin/env node
// Keeps the plugin + marketplace manifests on package.json's version. Run by
// the `version` lifecycle, so `npm version <x>` bumps all three and tags once.
import fs from 'node:fs';

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

const write = (file, mutate) => {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(json);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
};

write('plugins/pyor/.claude-plugin/plugin.json', (p) => {
  p.version = version;
});
write('.claude-plugin/marketplace.json', (m) => {
  m.metadata.version = version;
});

console.log(`synced plugin + marketplace manifests to ${version}`);
