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
  'SOOYASecretsPlugin.swift',
  'SOOYAArchivePlugin.swift',
  'SOOYAWebSocketPlugin.swift',
  'SOOYAReleasePlugin.swift',
  'SOOYAReleaseConfig.swift'
];

const PLUGIN_GROUP_ID = 'SOOYA00000000000000000P10';
// Stable synthetic IDs (24 hex chars, no conflicts with Apple/Capacitor IDs).
const FILE_REF_BASE = 0x5a0000000000000000000001n; // 5A0000000000000000000001..
const BUILD_FILE_OFFSET = 0x100n;

const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const ENTITLEMENTS_PATH = 'App/App.entitlements';
const SPM_PACKAGE = 'ios/App/CapApp-SPM/Package.swift';

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

  const missingRefs = fileRefs.filter(({ buildFile }) => !content.includes(`${buildFile} /* `));
  if (missingRefs.length === 0) {
    console.log('plugin sources already wired; nothing to do');
  } else {
    // 1. PBXBuildFile entries. Only add missing files: cap sync may leave the
    // earlier custom-plugin entries in place while this script grows the set.
    const buildFileEntries = missingRefs
      .map(({ name, fileRef, buildFile }) =>
        `\t\t${buildFile} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* ${name} */; };`)
      .join('\n');
    content = content.replace(
      /(\/\* Begin PBXBuildFile section \*\/\n)/,
      `$1${buildFileEntries}\n`
    );

    // 2. PBXFileReference entries (relative to the Plugins group)
    const fileRefEntries = missingRefs
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
    if (!content.includes(`${PLUGIN_GROUP_ID} /* Plugins */ = {`)) {
      content = content.replace(
        /(\/\* Begin PBXGroup section \*\/\n)/,
        `$1${pluginGroup}\n`
      );
    } else {
      const groupPattern = new RegExp(
        `(\\t\\t${PLUGIN_GROUP_ID} \/\\* Plugins \\/\\* = \\{[\\s\\S]*?\\n\\t\\t\\tchildren = \\(\\n)([\\s\\S]*?)(\\n\\t\\t\\t\\);\\n\\t\\t\\tpath = Plugins;)`
      );
      content = content.replace(groupPattern, (_match, head, children, tail) =>
        `${head}${children}${missingRefs
          .map(({ name, fileRef }) => `\n\t\t\t\t${fileRef} /* ${name} */,`)
          .join('')}${tail}`
      );
      // The fallback uses plain offsets so a future formatting change in the
      // generated project cannot silently leave a missing plugin unwired.
      const groupStart = content.indexOf(`${PLUGIN_GROUP_ID} /* Plugins */ = {`);
      const childrenEnd = content.indexOf('\n\t\t\t);', groupStart);
      if (groupStart < 0 || childrenEnd < 0) throw new Error('Plugins group children not found');
      if (!missingRefs.every(({ fileRef }) => content.slice(groupStart, childrenEnd).includes(`${fileRef} /* `))) {
        const entries = missingRefs
          .filter(({ fileRef }) => !content.slice(groupStart, childrenEnd).includes(`${fileRef} /* `))
          .map(({ name, fileRef }) => `\n\t\t\t\t${fileRef} /* ${name} */,`)
          .join('');
        content = content.slice(0, childrenEnd) + entries + content.slice(childrenEnd);
      }
    }
    if (!content.includes(`${PLUGIN_GROUP_ID} /* Plugins */,`)) {
      content = content.replace(
        /(50B271D01FEDC1A000F3C39B \/\* public \*\/,\n)/,
        `$1\t\t\t\t\t${PLUGIN_GROUP_ID} /* Plugins */,\n`
      );
    }

    // 4. Sources build phase membership
    const sourceEntries = missingRefs
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

  // cap sync may regenerate the managed SPM manifest. Keep the native archive
  // capability present without requiring a second manual Xcode edit.
  const spmPath = path.join(root, SPM_PACKAGE);
  let spm = await fsp.readFile(spmPath, 'utf8');
  if (!spm.includes('ZIPFoundation.git')) {
    spm = spm.replace(
      '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),',
      '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),\n        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19"),'
    );
  }
  if (!spm.includes('.product(name: "ZIPFoundation", package: "ZIPFoundation")')) {
    spm = spm.replace(
      '                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar")',
      '                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),\n                .product(name: "ZIPFoundation", package: "ZIPFoundation")'
    );
  }
  await fsp.writeFile(spmPath, spm, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
