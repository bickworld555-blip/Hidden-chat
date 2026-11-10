// Runs on Expo EAS build machines after `npm ci` (package.json "eas-build-post-install"). The Android app is a
// Capacitor shell, so before Gradle runs we build the web assets, generate the gitignored Capacitor config
// pointing at ANDROID_APP_URL, and make sure Gradle runs on JDK 21 (Capacitor 8 targets Java 21).
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== 'android') process.exit(0);
const run = (command, env = {}) => execSync(command, { stdio: 'inherit', env: { ...process.env, ...env } });

if (!process.env.ANDROID_APP_URL) throw new Error('Set ANDROID_APP_URL in the eas.json build profile.');
run('npm run build');
run('npm run android:sync');

// Firebase push: GOOGLE_SERVICES_JSON is an EAS file secret (a path) or the JSON itself. Without it the APK builds
// without push (build.gradle applies the Google services plugin only when the file is there).
const services = process.env.GOOGLE_SERVICES_JSON;
if (services) {
  const text = existsSync(services) ? readFileSync(services, 'utf8') : services;
  if (!JSON.parse(text)?.project_info?.project_id) throw new Error('GOOGLE_SERVICES_JSON is not a google-services.json file.');
  writeFileSync('android/app/google-services.json', text);
  console.log('Firebase push: google-services.json provided.');
} else {
  console.warn('GOOGLE_SERVICES_JSON is not set: this APK is built without Firebase push.');
}

function javaMajor(javaHome) {
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  try {
    const text = execSync(`"${java}" -version 2>&1`, { encoding: 'utf8' });
    return Number(/version "(\d+)/.exec(text)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

if (javaMajor(process.env.JAVA_HOME) < 21) {
  const jdk = join(homedir(), 'jdk-21');
  if (!existsSync(join(jdk, 'bin', 'java'))) {
    mkdirSync(jdk, { recursive: true });
    console.log('Installing Temurin JDK 21 for Gradle…');
    run(`curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" | tar -xz -C "${jdk}" --strip-components=1`);
  }
  appendFileSync('android/gradle.properties', `\norg.gradle.java.home=${jdk}\n`);
  console.log(`Gradle will run on ${jdk} (Java ${javaMajor(jdk)}).`);
}
