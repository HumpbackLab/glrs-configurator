#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const requestedVersion = args.find((argument) => !argument.startsWith("--"))
  ?? process.env.RELEASE_TAG;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  console.error("Usage: node scripts/set-release-version.mjs <version|vversion> [--check]");
}

function replaceTomlPackageVersion(contents, version, filename) {
  const packageStart = contents.search(/^\[package\]\s*$/m);
  if (packageStart === -1) {
    throw new Error(`${filename}: missing [package] section`);
  }

  const sectionBodyStart = contents.indexOf("\n", packageStart) + 1;
  const nextSectionOffset = contents.slice(sectionBodyStart).search(/^\[/m);
  const packageEnd = nextSectionOffset === -1
    ? contents.length
    : sectionBodyStart + nextSectionOffset;
  const packageSection = contents.slice(sectionBodyStart, packageEnd);
  const versionMatch = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m);

  if (!versionMatch) {
    throw new Error(`${filename}: missing version in [package] section`);
  }

  return {
    current: versionMatch[1],
    updated: contents.slice(0, sectionBodyStart)
      + packageSection.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${version}"`)
      + contents.slice(packageEnd),
  };
}

async function main() {
  if (!requestedVersion) {
    usage();
    throw new Error("version is required");
  }

  const version = requestedVersion.replace(/^v/, "");
  if (!semverPattern.test(version)) {
    usage();
    throw new Error(`invalid semantic version: ${requestedVersion}`);
  }

  const packageJsonPath = path.join(projectRoot, "app/package.json");
  const packageLockPath = path.join(projectRoot, "app/package-lock.json");
  const tauriConfigPath = path.join(projectRoot, "app/src-tauri/tauri.conf.json");
  const cargoTomlPath = path.join(projectRoot, "app/src-tauri/Cargo.toml");
  const cargoLockPath = path.join(projectRoot, "app/src-tauri/Cargo.lock");

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
  const cargoTomlContents = await readFile(cargoTomlPath, "utf8");
  const cargoLockContents = await readFile(cargoLockPath, "utf8");
  const cargoToml = replaceTomlPackageVersion(cargoTomlContents, version, "Cargo.toml");
  const cargoLockPattern = /(\[\[package\]\]\r?\nname = "gyro-elrs-configurator"\r?\nversion = ")[^"]+("\r?\n)/;
  const cargoLockMatch = cargoLockContents.match(cargoLockPattern);

  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json: missing root package entry");
  }
  if (!cargoLockMatch) {
    throw new Error("Cargo.lock: missing gyro-elrs-configurator package entry");
  }

  const versions = [
    ["app/package.json", packageJson.version],
    ["app/package-lock.json", packageLock.version],
    ["app/package-lock.json root package", packageLock.packages[""].version],
    ["app/src-tauri/tauri.conf.json", tauriConfig.version],
    ["app/src-tauri/Cargo.toml", cargoToml.current],
    ["app/src-tauri/Cargo.lock", cargoLockMatch[0].match(/version = "([^"]+)"/)[1]],
  ];
  const mismatches = versions.filter(([, current]) => current !== version);

  if (checkOnly) {
    if (mismatches.length > 0) {
      const details = mismatches
        .map(([filename, current]) => `  ${filename}: ${current ?? "<missing>"}`)
        .join("\n");
      throw new Error(`release version must be ${version}:\n${details}`);
    }
    console.log(`Release version is consistent: ${version}`);
    return;
  }

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  tauriConfig.version = version;

  await Promise.all([
    writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`),
    writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`),
    writeFile(cargoTomlPath, cargoToml.updated),
    writeFile(
      cargoLockPath,
      cargoLockContents.replace(cargoLockPattern, (_, prefix, suffix) => `${prefix}${version}${suffix}`),
    ),
  ]);

  console.log(`Synchronized release version: ${version}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
