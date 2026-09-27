#!/usr/bin/env node
// Sets (or, with --check, verifies) one version across every published artifact:
//   node scripts/set-version.mjs 0.2.0
//   node scripts/set-version.mjs --check v0.2.0     # CI: tag must match every artifact
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = (check ? args[1] : args[0])?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: set-version.mjs [--check] <semver>");
  process.exit(2);
}

const NPM = ["core", "extractor-typescript", "extractor-java", "ai-anthropic", "cli", "mcp"];

/** [file, find current version, replace with new] */
const targets = [
  ...NPM.map((pkg) => [
    `packages/${pkg}/package.json`,
    (text) => JSON.parse(text).version,
    (text) => {
      const json = JSON.parse(text);
      json.version = version;
      for (const deps of [json.dependencies, json.devDependencies]) {
        for (const name of Object.keys(deps ?? {})) if (name.startsWith("@api-tacet/")) deps[name] = `^${version}`;
      }
      return JSON.stringify(json, null, 2) + "\n";
    },
  ]),
  regex("python/pyproject.toml", /^version = "([^"]+)"/m, (v) => `version = "${v}"`),
  regex("python/src/tacet/_version.py", /__version__ = "([^"]+)"/, (v) => `__version__ = "${v}"`),
  regex("plugins/gradle/gradle.properties", /^version=(.+)$/m, (v) => `version=${v}`),
  regex("plugins/maven/pom.xml", /<artifactId>tacet-maven-plugin<\/artifactId>\s*<version>([^<]+)<\/version>/, (v) =>
    `<artifactId>tacet-maven-plugin</artifactId>\n  <version>${v}</version>`),
  regex("packages/extractor-java/jvm/build.gradle.kts", /^version = "([^"]+)"/m, (v) => `version = "${v}"`),
];

function regex(file, pattern, render) {
  return [
    file,
    (text) => text.match(pattern)?.[1],
    (text) => text.replace(pattern, render(version)),
  ];
}

let mismatches = 0;
for (const [file, read, write] of targets) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const current = read(text);
  if (current === undefined) throw new Error(`No version found in ${file}`);
  if (check) {
    if (current !== version) {
      console.error(`${file}: ${current} (expected ${version})`);
      mismatches++;
    }
  } else if (current !== version) {
    writeFileSync(path, write(text));
    console.log(`${file}: ${current} -> ${version}`);
  }
}
if (check && mismatches) process.exit(1);
if (check) console.log(`All artifacts are at ${version}`);
else console.log("Run `npm install` to refresh package-lock.json.");
