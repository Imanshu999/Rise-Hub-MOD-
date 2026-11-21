# Rise Hub v2.3.0 build fix

The GitHub Actions workflow now provisions Gradle 9.3.1 explicitly and invokes the `gradle` executable supplied by the setup action instead of relying on the repository Gradle wrapper JAR.

This avoids failures caused by an incomplete/missing `gradle-wrapper.jar` while keeping JDK 17, AGP 9.1.1 and Gradle 9.3.1 aligned.

Version: 2.3.0 / versionCode 11
