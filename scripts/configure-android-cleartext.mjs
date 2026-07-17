import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradlePath = path.join(
  repositoryRoot,
  'app',
  'src-tauri',
  'gen',
  'android',
  'app',
  'build.gradle.kts',
);
const keystorePropertiesPath = path.join(
  repositoryRoot,
  'app',
  'src-tauri',
  'keystore.properties',
);

let source;
try {
  source = await readFile(gradlePath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    // Desktop builds do not generate the Android Gradle project.
    process.exit(0);
  }
  throw error;
}

const disabled = 'manifestPlaceholders["usesCleartextTraffic"] = "false"';
const enabled = 'manifestPlaceholders["usesCleartextTraffic"] = "true"';

let changed = false;

if (source.includes(disabled)) {
  source = source.replace(disabled, enabled);
  changed = true;
  console.log('Enabled Android cleartext HTTP for the receiver configuration API.');
}

const defaultConfig = source.split('defaultConfig {', 2)[1]?.split('}', 1)[0];
if (!defaultConfig?.includes(enabled)) {
  throw new Error(`Unable to configure Android cleartext HTTP: placeholder not found in ${gradlePath}`);
}

let signingEnabled = false;
try {
  await readFile(keystorePropertiesPath, 'utf8');
  signingEnabled = true;
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

if (signingEnabled) {
  const generatedKeystoreProperties = 'rootProject.file("keystore.properties")';
  const persistentKeystoreProperties = 'rootProject.file("../../keystore.properties")';
  if (source.includes(generatedKeystoreProperties)) {
    source = source.replace(generatedKeystoreProperties, persistentKeystoreProperties);
    changed = true;
  }

  if (!source.includes('import java.io.FileInputStream')) {
    source = `import java.io.FileInputStream\n${source}`;
    changed = true;
  }

  if (!source.includes('create("release")')) {
    const signingConfig = `    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("../../keystore.properties")
            val keystoreProperties = Properties().apply {
                load(FileInputStream(keystorePropertiesFile))
            }

            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["storePassword"] as String
        }
    }
`;
    source = source.replace('    buildTypes {', `${signingConfig}    buildTypes {`);
    changed = true;
  }

  const releaseStart = '        getByName("release") {';
  const releaseSigning = `${releaseStart}\n            signingConfig = signingConfigs.getByName("release")`;
  if (!source.includes('signingConfig = signingConfigs.getByName("release")')) {
    source = source.replace(releaseStart, releaseSigning);
    changed = true;
  }

  console.log('Enabled Android release signing with the local Gyro ELRS keystore.');
}

if (changed) {
  await writeFile(gradlePath, source);
}
