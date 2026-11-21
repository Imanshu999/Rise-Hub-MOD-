# Rise Hub

Android APK-ready project for the Rise Hub WebView application.

## Build locally

Requires JDK 17 and Android SDK Platform 36 / Build Tools.

```bash
./gradlew assembleDebug
./gradlew assembleRelease
```

APKs are written to:

- `app/build/outputs/apk/debug/app-debug.apk`
- `app/build/outputs/apk/release/app-release.apk`

The repository contains a CI debug keystore so the CI release build is signed and installable for testing.
For production distribution, provide a real release keystore through `KEYSTORE_PATH`, `STORE_PASSWORD`,
`KEY_ALIAS`, and `KEY_PASSWORD` environment variables.

## GitHub Actions

`.github/workflows/build.yml` builds both debug and release APKs and uploads them as workflow artifacts.
The workflow provisions Gradle 9.3.1 directly, so a binary Gradle wrapper JAR is not required in the repository.

## Release signing
See `SIGNING_SETUP.md`. GitHub Actions can produce a real signed release APK and a signed Play Store AAB using repository secrets; no private keystore is stored in the repository.

## Automated update checker

`app/src/main/assets/riseup-update.js` compares the running version (native `versionName`) with `version.json`
published next to `app.json` in the GitHub repository
(`https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/version.json`).

To ship an update:
1. Bump `versionName` / `versionCode` in `app/build.gradle.kts` and build the new APK.
2. Upload the APK and set `version`, `apkUrl`, `notes` (and `mandatory`) in `version.json` in that GitHub repo.

Older installs are locked behind an "Update Available" dialog until they update. With `apkUrl` the APK is downloaded
and installed; without it the catalog data is refreshed and the app reloads. Set `"mandatory": false` to allow "Later".
