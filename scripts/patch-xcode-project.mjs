#!/usr/bin/env node
/**
 * Idempotently wires the SOOYA custom Swift plugins into the Capacitor Xcode
 * project (App target) and points CODE_SIGN_ENTITLEMENTS at App.entitlements.
 *
 * Capacitor CLI only lists the *official* plugins in the generated project;
 * custom CAPBridgedPlugin sources under ios/App/App/Plugins/ must be listed
 * explicitly in project.pbxproj (objectVersion 60 format) to compile into the
 * app target. Run this after `npx cap add ios` / `cap sync ios`:
 *
 *   node scripts/patch-xcode-project.mjs
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const PLUGIN_FILES = [
  'SOOYADatabasePlugin.swift',
  'SOOYAHttpPlugin.swift',
  'SOOYAMcpPlugin.swift',
  'SOOYAMediaPlugin.swift',
  'SOOYASecretsPlugin.swift'
];

const PLUGIN_GROUP_ID = 'SOOYA00000000000000000P10';
// Stable synthetic IDs (24 hex chars, no conflicts with Apple/Capacitor IDs).
const FILE_REF_BASE = 0x5a0000000000000000000001n; // 5A0000000000000000000001..
const BUILD_FILE_OFFSET = 0x100n;

const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const ENTITLEMENTS_PATH = 'App/App.entitlements';

function hexId(value) {
  return value.toString(16).toUpperCase().padStart(24, '0');
}

async function main() {
  const root = process.cwd();
  const file = path.join(root, PBXPROJ);
  let content = await fsp.readFile(file, 'utf8');

  const fileRefs = PLUGIN_FILES.map((name, index) => ({
    name,
    fileRef: hexId(FILE_REF_BASE + BigInt(index)),
    buildFile: hexId(FILE_REF_BASE + BUILD_FILE_OFFSET + BigInt(index))
  }));

  const alreadyWired = fileRefs.every(({ buildFile }) => content.includes(`${buildFile} /* `));
  if (alreadyWired) {
    console.log('plugin sources already wired; nothing to do');
  } else {
    // 1. PBXBuildFile entries
    const buildFileEntries = fileRefs
      .map(({ name, fileRef, buildFile }) =>
        `\t\t${buildFile} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };`)
      .join('\n');
    content = content.replace(
      /(\/\* Begin PBXBuildFile section \*\/\n)/,
      `$1${buildFileEntries}\n`
    );

    // 2. PBXFileReference entries (relative to the Plugins group)
    const fileRefEntries = fileRefs
      .map(({ name, fileRef }) =>
        `\t\t${fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`)
      .join('\n');
    content = content.replace(
      /(\/\* Begin PBXFileReference section \*\/\n)/,
      `$1${fileRefEntries}\n`
    );

    // 3. Plugins group + membership in the App group
    const pluginGroup = `\t\t${PLUGIN_GROUP_ID} /* Plugins */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n${fileRefs
      .map(({ name, fileRef }) => `\t\t\t\t${fileRef} /* ${name} */,`)
      .join('\n')}\n\t\t\t);\n\t\t\tpath = Plugins;\n\t\t\tsourceTree = "<group>";\n\t\t};`;
    content = content.replace(
      /(\/\* Begin PBXGroup section \*\/\n)/,
      `$1${pluginGroup}\n`
    );
    content = content.replace(
      /(50B271D01FEDC1A000F3C39B \/\* public \*\/,\n)/,
      `$1\t\t\t\t\t${PLUGIN_GROUP_ID} /* Plugins */,\n`
    );

    // 4. Sources build phase membership
    const sourceEntries = fileRefs
      .map(({ name, buildFile }) => `\t\t\t\t\t${buildFile} /* ${name} in Sources */,`)
      .join('\n');
    content = content.replace(
      /(\t\t\t\t9582B6832FE993A70072D4E8 \/\* SceneDelegate.swift in Sources \*\/,\n)/,
      `$1${sourceEntries}\n`
    );

    await fsp.writeFile(file, content, 'utf8');
    console.log(`wired ${PLUGIN_FILES.length} plugin sources into ${PBXPROJ}`);
  }

  // 5. CODE_SIGN_ENTITLEMENTS on both App target build configurations
  if (content.includes(`CODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_PATH};`)) {
    console.log('entitlements already configured');
  } else {
    content = await fsp.readFile(file, 'utf8');
    content = content.replace(
      /(\t\t\t\tCODE_SIGN_STYLE = Automatic;\n)/g,
      `$1\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${ENTITLEMENTS_PATH};\n`
    );
    await fsp.writeFile(file, content, 'utf8');
    console.log('CODE_SIGN_ENTITLEMENTS configured');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
