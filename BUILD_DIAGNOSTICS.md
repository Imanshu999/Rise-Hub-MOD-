# Rise Hub v2.2.8 build diagnostics

The GitHub workflow now saves `build-debug.log` and `build-release.log` as workflow artifacts even when Gradle fails. The final `exit code 1` line is only a wrapper error; the first `FAILURE`, `e:`, or `Caused by:` section earlier in the log is the actual cause.

The build also limits Gradle workers to 2 and runs without the Gradle configuration cache to reduce GitHub Actions worker/lease failures.
