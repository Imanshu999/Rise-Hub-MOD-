# Rise Hub v2.2.6 build fix

The previous build failed because `MainActivity.kt` was missing one closing `}` for `MainActivity`. The compiler reported `MainActivity.kt:416:2: error: missing '}'`.

This version:
- closes `MainActivity` correctly;
- uses Java/Kotlin JVM target 17 to match the CI JDK and AGP 9.1.1;
- reduces Gradle worker pressure in CI;
- uses the project Gradle wrapper in GitHub Actions instead of a separately selected global Gradle executable;
- removes the workflow's runtime mutation of `libs.versions.toml` and keeps the required version entries in the project itself;
- keeps the native notification engine and the `notifications.json` endpoint unchanged.

AGP 9.1.1 is documented as compatible with Gradle 9.3.1, JDK 17, and Kotlin Gradle Plugin 2.2.10.
