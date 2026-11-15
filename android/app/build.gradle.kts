plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.setu.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.setu.remote"
        minSdk = 26
        targetSdk = 35
        // CI passes -PbuildNumber=<run number>, so every build is newer than the last and the app can update itself.
        val build = (project.findProperty("buildNumber") as String?)?.toIntOrNull() ?: 1
        versionCode = build
        versionName = "0.1.$build"
        // -PemulatorAbi adds x86_64 so the CI smoke test can run the app on an emulator; published builds are ARM only.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") + (if (project.hasProperty("emulatorAbi")) listOf("x86_64") else emptyList()) }
    }
    // One fixed key for every build, so updates install over the previous version and keep their permissions.
    // The key is not in the repository: CI receives it at build time (see .github/workflows/build.yml).
    // Without it (a local build) Gradle falls back to the usual debug key.
    val ksFile = System.getenv("SETU_KEYSTORE_FILE")
    signingConfigs {
        if (ksFile != null) create("setu") {
            storeFile = file(ksFile)
            storePassword = System.getenv("SETU_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("SETU_KEY_ALIAS") ?: "setu"
            keyPassword = System.getenv("SETU_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        debug { if (ksFile != null) signingConfig = signingConfigs.getByName("setu") }
        release { isMinifyEnabled = false; signingConfig = if (ksFile != null) signingConfigs.getByName("setu") else signingConfigs.getByName("debug") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = false }
    packaging { resources { excludes += "META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
    implementation("io.getstream:stream-webrtc-android:1.3.8")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
