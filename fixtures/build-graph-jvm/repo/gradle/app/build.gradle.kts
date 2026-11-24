plugins {
    java
}

// Sentinel: runs at configuration time if the script is evaluated.
file("MARKER-gradle").writeText("ran")

tasks.register("sentinel") {
    doLast { file("MARKER-gradle-task").writeText("ran") }
}

dependencies {
    implementation(project(":lib"))
    implementation("com.squareup.okio:okio:3.9.0")
}
