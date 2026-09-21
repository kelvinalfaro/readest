plugins {
  `kotlin-dsl`
}

gradlePlugin {
  plugins {
    create("pluginsForCoolKids") {
      id = "rust"
      implementationClass = "RustPlugin"
    }
  }
}

repositories {
  google()
  mavenCentral()
}

dependencies {
  compileOnly(gradleApi())
  implementation("com.android.tools.build:gradle:8.11.0")
}

// Tauri also materializes template Kotlin files below src/main/java when it
// refreshes this project. Compile the maintained buildSrc copy only.
sourceSets {
  main {
    kotlin.setSrcDirs(listOf("src/main/kotlin"))
  }
}
