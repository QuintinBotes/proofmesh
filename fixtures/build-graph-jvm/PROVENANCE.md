# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A Maven reactor (`com.acme:shop` with modules `core` and `web`) and a Gradle build (`:app`, `:lib`), the JVM build files of issue 13 (FR151 to FR160); Bazel and Buck are not in this fixture yet. Two sentinels would write a marker file if the build ran: an `exec` plugin bound to `validate` in `maven/web/pom.xml`, and a task and a top-level statement in `gradle/app/build.gradle.kts` (FR079, SC015). `gradle/lib/build.gradle` adds one dependency in a `for` loop, which is not read statically.
