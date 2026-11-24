#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# flat layout: put files where Capacitor expects them
mkdir -p www native
cp -f index.html style.css app.js www/
cp -f NetBoostPlugin.java AutoTestWorker.java native/

npm install
[ -d android ] || npx cap add android

PKG_DIR=android/app/src/main/java/com/nexus/netboost
mkdir -p "$PKG_DIR"
cp native/NetBoostPlugin.java native/AutoTestWorker.java "$PKG_DIR"/

cat > "$PKG_DIR/MainActivity.java" <<'JAVA'
package com.nexus.netboost;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NetBoostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
JAVA

MANIFEST=android/app/src/main/AndroidManifest.xml
if ! grep -q "KILL_BACKGROUND_PROCESSES" "$MANIFEST"; then
  cat > perms.xml.tmp <<'XML'
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.KILL_BACKGROUND_PROCESSES" />
    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
    <uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_SECURE_SETTINGS" />
XML
  awk 'FNR==NR { p = p $0 "\n"; next } /<application/ && !d { printf "%s", p; d=1 } { print }' perms.xml.tmp "$MANIFEST" > "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
  rm -f perms.xml.tmp
fi

GRADLE=android/app/build.gradle
if ! grep -q "work-runtime" "$GRADLE"; then
  sed -i '0,/^dependencies {/s//dependencies {\n    implementation "androidx.work:work-runtime:2.9.0"/' "$GRADLE"
fi

npx cap sync android
echo "Android project ready."
