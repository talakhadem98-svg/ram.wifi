package com.nexus.netboost;

import android.Manifest;
import android.app.ActivityManager;
import android.app.AppOpsManager;
import android.app.PendingIntent;
import android.app.usage.StorageStats;
import android.app.usage.StorageStatsManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.DhcpInfo;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.Process;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(
    name = "NetBoost",
    requestCodes = {9001},
    permissions = {
        @Permission(alias = "loc", strings = {Manifest.permission.ACCESS_FINE_LOCATION}),
        @Permission(alias = "media33", strings = {"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO"}),
        @Permission(alias = "media", strings = {Manifest.permission.READ_EXTERNAL_STORAGE})
    }
)
public class NetBoostPlugin extends Plugin {

    private static final int REQ_DELETE = 9001;
    private PluginCall pendingDeleteCall;
    private long pendingDeleteBytes = 0;
    private int pendingDeleteCount = 0;

    // ---------------------------------------------------------------- helpers

    static int chan(int f) {
        if (f >= 2412 && f <= 2484) return f == 2484 ? 14 : (f - 2407) / 5;
        if (f >= 5000 && f < 5950) return (f - 5000) / 5;
        if (f >= 5950) return (f - 5950) / 5;
        return 0;
    }

    static String ip(int i) {
        return (i & 0xff) + "." + ((i >> 8) & 0xff) + "." + ((i >> 16) & 0xff) + "." + ((i >> 24) & 0xff);
    }

    static JSObject wifiInfoObj(Context c) {
        JSObject o = new JSObject();
        try {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            o.put("enabled", wm.isWifiEnabled());
            WifiInfo wi = wm.getConnectionInfo();
            if (wi != null && wi.getNetworkId() != -1) {
                String ssid = wi.getSSID();
                if (ssid != null) ssid = ssid.replace("\"", "");
                o.put("connected", true);
                o.put("ssid", ssid);
                o.put("bssid", wi.getBSSID());
                o.put("rssi", wi.getRssi());
                o.put("linkSpeed", wi.getLinkSpeedMbps());
                int f = wi.getFrequency();
                o.put("freq", f);
                o.put("channel", chan(f));
                DhcpInfo d = wm.getDhcpInfo();
                if (d != null) {
                    o.put("ip", ip(d.ipAddress));
                    o.put("gateway", ip(d.gateway));
                    o.put("dns1", ip(d.dns1));
                    o.put("dns2", ip(d.dns2));
                }
            } else {
                o.put("connected", false);
            }
        } catch (Exception e) {
            o.put("connected", false);
            o.put("error", String.valueOf(e.getMessage()));
        }
        return o;
    }

    static JSObject doPing(String host, int count) {
        JSObject o = new JSObject();
        List<Double> t = new ArrayList<>();
        try {
            Process p = new ProcessBuilder("/system/bin/ping", "-c", String.valueOf(count), "-W", "2", "-i", "0.3", host)
                .redirectErrorStream(true).start();
            BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream()));
            Pattern pt = Pattern.compile("time=([0-9.]+)");
            String l;
            while ((l = br.readLine()) != null) {
                Matcher m = pt.matcher(l);
                if (m.find()) t.add(Double.parseDouble(m.group(1)));
            }
            p.waitFor(count * 3L, TimeUnit.SECONDS);
            p.destroy();
        } catch (Exception ignored) {
        }
        double sum = 0, mn = 0, mx = 0, jit = 0;
        if (!t.isEmpty()) {
            mn = Collections.min(t);
            mx = Collections.max(t);
            for (double v : t) sum += v;
            for (int i = 1; i < t.size(); i++) jit += Math.abs(t.get(i) - t.get(i - 1));
            if (t.size() > 1) jit /= (t.size() - 1);
        }
        o.put("host", host);
        o.put("received", t.size());
        o.put("loss", count > 0 ? 100.0 * (count - t.size()) / count : 100.0);
        o.put("avg", t.isEmpty() ? -1 : sum / t.size());
        o.put("min", mn);
        o.put("max", mx);
        o.put("jitter", jit);
        return o;
    }

    static double dnsQuery(String server, String domain, int timeoutMs) {
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            DataOutputStream d = new DataOutputStream(b);
            d.writeShort(new Random().nextInt(65535));
            d.writeShort(0x0100);
            d.writeShort(1);
            d.writeShort(0);
            d.writeShort(0);
            d.writeShort(0);
            for (String part : domain.split("\\.")) {
                d.writeByte(part.length());
                d.writeBytes(part);
            }
            d.writeByte(0);
            d.writeShort(1);
            d.writeShort(1);
            byte[] q = b.toByteArray();
            DatagramSocket s = new DatagramSocket();
            s.setSoTimeout(timeoutMs);
            InetAddress addr = InetAddress.getByName(server);
            long t0 = System.nanoTime();
            s.send(new DatagramPacket(q, q.length, addr, 53));
            byte[] buf = new byte[512];
            DatagramPacket r = new DatagramPacket(buf, buf.length);
            s.receive(r);
            long t1 = System.nanoTime();
            s.close();
            return (t1 - t0) / 1e6;
        } catch (Exception e) {
            return -1;
        }
    }

    private String permAlias(String type) {
        if ("wifi".equals(type)) return "loc";
        return Build.VERSION.SDK_INT >= 33 ? "media33" : "media";
    }

    private boolean allFiles() {
        return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
    }

    private long dirSize(File f) {
        long s = 0;
        File[] k = f.listFiles();
        if (k == null) return f.length();
        for (File c : k) s += c.isDirectory() ? dirSize(c) : c.length();
        return s;
    }

    private long deleteRec(File f) {
        long s = 0;
        File[] k = f.listFiles();
        if (k != null) for (File c : k) s += deleteRec(c);
        else s = f.length();
        f.delete();
        return s;
    }

    // ------------------------------------------------------------ permissions

    @PluginMethod
    public void requestPerms(PluginCall call) {
        String type = call.getString("type", "wifi");
        String alias = permAlias(type);
        if (getPermissionState(alias) == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias(alias, call, "permCb");
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        String alias = permAlias(call.getString("type", "wifi"));
        JSObject r = new JSObject();
        r.put("granted", getPermissionState(alias) == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allFiles", allFiles());
        r.put("usageAccess", hasUsageAccess());
        r.put("sdk", Build.VERSION.SDK_INT);
        boolean sec = getContext().checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
        r.put("secureSettings", sec);
        call.resolve(r);
    }

    private boolean hasUsageAccess() {
        try {
            AppOpsManager ao = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
            int m = ao.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getContext().getPackageName());
            return m == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String type = call.getString("type", "");
        String pkg = call.getString("pkg", getContext().getPackageName());
        Intent i;
        Uri pu = Uri.parse("package:" + pkg);
        switch (type) {
            case "storage": i = new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS); break;
            case "battery": i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); break;
            case "batterysaver": i = new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS); break;
            case "usage": i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS); break;
            case "location": i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS); break;
            case "wifi": i = new Intent(Settings.ACTION_WIFI_SETTINGS); break;
            case "network": i = new Intent(Settings.ACTION_WIRELESS_SETTINGS); break;
            case "allfiles":
                if (Build.VERSION.SDK_INT >= 30) {
                    i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                } else {
                    i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                }
                break;
            default: i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pu);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent f = new Intent(Settings.ACTION_SETTINGS);
                f.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(f);
                call.resolve();
            } catch (Exception e2) {
                call.reject(String.valueOf(e2.getMessage()));
            }
        }
    }

    // ------------------------------------------------------------------- wifi

    @PluginMethod
    public void wifiInfo(PluginCall call) {
        call.resolve(wifiInfoObj(getContext()));
    }

    @PluginMethod
    public void wifiScan(final PluginCall call) {
        new Thread(() -> {
            try {
                WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                try {
                    wm.startScan();
                    Thread.sleep(2500);
                } catch (Exception ignored) {
                }
                JSArray arr = new JSArray();
                for (ScanResult r : wm.getScanResults()) {
                    JSObject o = new JSObject();
                    o.put("ssid", r.SSID);
                    o.put("bssid", r.BSSID);
                    o.put("rssi", r.level);
                    o.put("freq", r.frequency);
                    o.put("channel", chan(r.frequency));
                    arr.put(o);
                }
                JSObject res = new JSObject();
                res.put("list", arr);
                call.resolve(res);
            } catch (SecurityException e) {
                call.reject("no_permission");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void ping(final PluginCall call) {
        final String host = call.getString("host", "1.1.1.1");
        final int count = call.getInt("count", 4);
        new Thread(() -> call.resolve(doPing(host, count))).start();
    }

    @PluginMethod
    public void dnsBench(final PluginCall call) {
        final JSArray servers = call.getArray("servers", new JSArray());
        new Thread(() -> {
            String[] domains = {"google.com", "wikipedia.org", "instagram.com"};
            JSArray out = new JSArray();
            try {
                for (int i = 0; i < servers.length(); i++) {
                    String s = servers.getString(i);
                    List<Double> ok = new ArrayList<>();
                    int fail = 0;
                    for (String dom : domains) {
                        for (int k = 0; k < 2; k++) {
                            double ms = dnsQuery(s, dom, 1500);
                            if (ms < 0) fail++;
                            else ok.add(ms);
                        }
                    }
                    Collections.sort(ok);
                    JSObject o = new JSObject();
                    o.put("server", s);
                    o.put("ms", ok.isEmpty() ? -1 : ok.get(ok.size() / 2));
                    o.put("fail", fail);
                    out.put(o);
                }
            } catch (Exception ignored) {
            }
            JSObject res = new JSObject();
            res.put("list", out);
            call.resolve(res);
        }).start();
    }

    @PluginMethod
    public void setPrivateDns(PluginCall call) {
        String host = call.getString("host", "");
        String mode = call.getString("mode", "hostname");
        JSObject r = new JSObject();
        try {
            ContentResolver cr = getContext().getContentResolver();
            if ("hostname".equals(mode)) {
                Settings.Global.putString(cr, "private_dns_specifier", host);
            }
            Settings.Global.putString(cr, "private_dns_mode", mode);
            r.put("ok", true);
        } catch (SecurityException e) {
            r.put("ok", false);
            r.put("needsAdb", true);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void scheduleAuto(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        int minutes = call.getInt("minutes", 60);
        WorkManager wm = WorkManager.getInstance(getContext());
        if (enabled) {
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(AutoTestWorker.class, Math.max(15, minutes), TimeUnit.MINUTES).build();
            wm.enqueueUniquePeriodicWork("netboost_auto", ExistingPeriodicWorkPolicy.REPLACE, req);
        } else {
            wm.cancelUniqueWork("netboost_auto");
        }
        call.resolve();
    }

    @PluginMethod
    public void getHistory(PluginCall call) {
        String s = getContext().getSharedPreferences("netboost", Context.MODE_PRIVATE).getString("hist", "[]");
        JSObject r = new JSObject();
        try {
            r.put("list", new JSArray(s));
        } catch (Exception e) {
            r.put("list", new JSArray());
        }
        call.resolve(r);
    }

    @PluginMethod
    public void clearHistory(PluginCall call) {
        getContext().getSharedPreferences("netboost", Context.MODE_PRIVATE).edit().remove("hist").apply();
        call.resolve();
    }

    // ----------------------------------------------------- device / battery

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        Context c = getContext();
        JSObject o = new JSObject();
        ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("ramTotal", mi.totalMem);
        o.put("ramFree", mi.availMem);
        StatFs sf = new StatFs(Environment.getDataDirectory().getPath());
        o.put("diskTotal", sf.getTotalBytes());
        o.put("diskFree", sf.getAvailableBytes());
        Intent b = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b != null) {
            int lvl = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int sc = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            o.put("battery", sc > 0 ? lvl * 100 / sc : lvl);
            o.put("temp", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
            o.put("status", b.getIntExtra(BatteryManager.EXTRA_STATUS, 0));
            o.put("plugged", b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0));
            o.put("voltage", b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0));
            o.put("health", b.getIntExtra(BatteryManager.EXTRA_HEALTH, 0));
        }
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        o.put("powerSave", pm.isPowerSaveMode());
        if (Build.VERSION.SDK_INT >= 29) o.put("thermal", pm.getCurrentThermalStatus());
        else o.put("thermal", -1);
        call.resolve(o);
    }

    @PluginMethod
    public void listApps(final PluginCall call) {
        new Thread(() -> {
            Context c = getContext();
            PackageManager pm = c.getPackageManager();
            boolean includeSystem = call.getBoolean("system", false);
            JSArray arr = new JSArray();
            for (ApplicationInfo ai : pm.getInstalledApplications(0)) {
                boolean sys = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0;
                if (sys && !includeSystem) continue;
                if (ai.packageName.equals(c.getPackageName())) continue;
                JSObject o = new JSObject();
                o.put("pkg", ai.packageName);
                o.put("name", String.valueOf(pm.getApplicationLabel(ai)));
                o.put("stopped", (ai.flags & ApplicationInfo.FLAG_STOPPED) != 0);
                o.put("system", sys);
                arr.put(o);
            }
            JSObject r = new JSObject();
            r.put("list", arr);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void killApps(final PluginCall call) {
        new Thread(() -> {
            Context c = getContext();
            ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo m1 = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(m1);
            JSArray pk = call.getArray("pkgs", new JSArray());
            int n = 0;
            for (int i = 0; i < pk.length(); i++) {
                try {
                    am.killBackgroundProcesses(pk.getString(i));
                    n++;
                } catch (Exception ignored) {
                }
            }
            try {
                Thread.sleep(1200);
            } catch (InterruptedException ignored) {
            }
            ActivityManager.MemoryInfo m2 = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(m2);
            JSObject r = new JSObject();
            r.put("count", n);
            r.put("freed", Math.max(0, m2.availMem - m1.availMem));
            r.put("ramFree", m2.availMem);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void appCacheSizes(final PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("no_usage_access");
            return;
        }
        new Thread(() -> {
            try {
                Context c = getContext();
                PackageManager pm = c.getPackageManager();
                StorageStatsManager ssm = (StorageStatsManager) c.getSystemService(Context.STORAGE_STATS_SERVICE);
                JSArray arr = new JSArray();
                long total = 0;
                for (ApplicationInfo ai : pm.getInstalledApplications(0)) {
                    try {
                        StorageStats st = ssm.queryStatsForPackage(StorageManager.UUID_DEFAULT, ai.packageName, Process.myUserHandle());
                        long cache = st.getCacheBytes();
                        if (cache < 512 * 1024) continue;
                        total += cache;
                        JSObject o = new JSObject();
                        o.put("pkg", ai.packageName);
                        o.put("name", String.valueOf(pm.getApplicationLabel(ai)));
                        o.put("cache", cache);
                        o.put("data", st.getDataBytes());
                        o.put("app", st.getAppBytes());
                        arr.put(o);
                    } catch (Exception ignored) {
                    }
                }
                JSObject r = new JSObject();
                r.put("list", arr);
                r.put("total", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void cleanSelf(PluginCall call) {
        long freed = 0;
        File a = getContext().getCacheDir();
        if (a != null) freed += deleteRec(a);
        File b = getContext().getExternalCacheDir();
        if (b != null) freed += deleteRec(b);
        System.gc();
        JSObject r = new JSObject();
        r.put("freed", freed);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ files

    private static boolean endsWithAny(String n, String... ext) {
        String l = n.toLowerCase();
        for (String e : ext) if (l.endsWith(e)) return true;
        return false;
    }

    private String hashOf(Uri uri, long size) {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[64 * 1024];
            if (size <= 8L * 1024 * 1024) {
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            } else {
                long chunk = 1024 * 1024;
                long[] offsets = {0, size / 2, size - chunk};
                long pos = 0;
                for (long off : offsets) {
                    long skip = off - pos;
                    while (skip > 0) {
                        long s = in.skip(skip);
                        if (s <= 0) break;
                        skip -= s;
                        pos += s;
                    }
                    long left = chunk;
                    while (left > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                        if (n <= 0) break;
                        md.update(buf, 0, n);
                        left -= n;
                        pos += n;
                    }
                }
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString() + ":" + size;
        } catch (Exception e) {
            return null;
        }
    }

    private JSObject item(long id, String name, String path, long size, int type, long mtime) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("name", name);
        o.put("path", path);
        o.put("size", size);
        o.put("type", type);
        o.put("mtime", mtime);
        return o;
    }

    @PluginMethod
    public void scanMedia(final PluginCall call) {
        new Thread(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                Uri files = MediaStore.Files.getContentUri("external");
                String[] proj = {
                    MediaStore.Files.FileColumns._ID,
                    MediaStore.Files.FileColumns.DISPLAY_NAME,
                    MediaStore.Files.FileColumns.SIZE,
                    MediaStore.Files.FileColumns.MEDIA_TYPE,
                    MediaStore.Files.FileColumns.DATE_MODIFIED,
                    MediaStore.Files.FileColumns.DATA
                };
                Cursor cur = cr.query(files, proj, MediaStore.Files.FileColumns.SIZE + ">0", null, null);
                Map<Long, List<JSObject>> bySize = new HashMap<>();
                List<JSObject> apks = new ArrayList<>(), shots = new ArrayList<>(), bigs = new ArrayList<>(), temps = new ArrayList<>();
                long apkB = 0, shotB = 0, bigB = 0, tmpB = 0;
                int scanned = 0;
                if (cur != null) {
                    while (cur.moveToNext()) {
                        long id = cur.getLong(0);
                        String name = cur.getString(1);
                        long size = cur.getLong(2);
                        int type = cur.getInt(3);
                        long mt = cur.getLong(4);
                        String path = cur.getString(5);
                        if (name == null) continue;
                        if (path == null) path = "";
                        scanned++;
                        JSObject it = item(id, name, path, size, type, mt);
                        boolean media = type == 1 || type == 3;
                        boolean inDownload = path.contains("/Download");
                        if (endsWithAny(name, ".apk") && apks.size() < 300) {
                            apks.add(it);
                            apkB += size;
                        } else if (endsWithAny(name, ".tmp", ".temp", ".log", ".bak", ".cache", ".thumbdata", ".crdownload", ".part") || path.contains("/.thumbnails/")) {
                            if (temps.size() < 500) {
                                temps.add(it);
                                tmpB += size;
                            }
                        }
                        if (media && (path.contains("/Screenshots/") || path.contains("/Screenrecords/") || path.contains("/Screen recordings/")) && shots.size() < 500) {
                            shots.add(it);
                            shotB += size;
                        }
                        if (type == 3 && size > 100L * 1024 * 1024 && bigs.size() < 60) {
                            bigs.add(it);
                            bigB += size;
                        }
                        if ((media || inDownload) && size > 10 * 1024 && !path.contains("/.thumbnails/") && !path.contains("/Android/")) {
                            List<JSObject> l = bySize.get(size);
                            if (l == null) {
                                l = new ArrayList<>();
                                bySize.put(size, l);
                            }
                            l.add(it);
                        }
                    }
                    cur.close();
                }
                JSArray groups = new JSArray();
                long dupB = 0;
                int dupCount = 0;
                for (Map.Entry<Long, List<JSObject>> e : bySize.entrySet()) {
                    List<JSObject> l = e.getValue();
                    if (l.size() < 2) continue;
                    Map<String, List<JSObject>> byHash = new HashMap<>();
                    for (JSObject it : l) {
                        Uri u = ContentUris.withAppendedId(files, it.getLong("id"));
                        String h = hashOf(u, e.getKey());
                        if (h == null) continue;
                        List<JSObject> hl = byHash.get(h);
                        if (hl == null) {
                            hl = new ArrayList<>();
                            byHash.put(h, hl);
                        }
                        hl.add(it);
                    }
                    for (List<JSObject> hl : byHash.values()) {
                        if (hl.size() < 2) continue;
                        Collections.sort(hl, (a, b) -> Long.compare(a.optLong("mtime"), b.optLong("mtime")));
                        JSArray ga = new JSArray();
                        for (JSObject it : hl) ga.put(it);
                        groups.put(ga);
                        dupB += e.getKey() * (hl.size() - 1);
                        dupCount += hl.size() - 1;
                    }
                }
                JSObject r = new JSObject();
                r.put("scanned", scanned);
                r.put("groups", groups);
                r.put("dupBytes", dupB);
                r.put("dupCount", dupCount);
                r.put("apks", toArr(apks));
                r.put("apkBytes", apkB);
                r.put("shots", toArr(shots));
                r.put("shotBytes", shotB);
                r.put("bigs", toArr(bigs));
                r.put("bigBytes", bigB);
                r.put("temps", toArr(temps));
                r.put("tempBytes", tmpB);
                call.resolve(r);
            } catch (SecurityException e) {
                call.reject("no_permission");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    private JSArray toArr(List<JSObject> l) {
        JSArray a = new JSArray();
        for (JSObject o : l) a.put(o);
        return a;
    }

    @PluginMethod
    public void thumb(final PluginCall call) {
        final long id = call.getData().optLong("id");
        final int type = call.getInt("type", 1);
        new Thread(() -> {
            JSObject r = new JSObject();
            try {
                ContentResolver cr = getContext().getContentResolver();
                Bitmap bm = null;
                if (Build.VERSION.SDK_INT >= 29) {
                    Uri base = type == 3 ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    bm = cr.loadThumbnail(ContentUris.withAppendedId(base, id), new Size(112, 112), null);
                } else if (type == 3) {
                    bm = MediaStore.Video.Thumbnails.getThumbnail(cr, id, MediaStore.Video.Thumbnails.MICRO_KIND, null);
                } else {
                    bm = MediaStore.Images.Thumbnails.getThumbnail(cr, id, MediaStore.Images.Thumbnails.MICRO_KIND, null);
                }
                if (bm != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    bm.compress(Bitmap.CompressFormat.JPEG, 70, bo);
                    r.put("data", "data:image/jpeg;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                }
            } catch (Exception ignored) {
            }
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void deleteMedia(final PluginCall call) {
        final JSArray ids = call.getArray("ids", new JSArray());
        final JSArray paths = call.getArray("paths", new JSArray());
        final JSArray sizes = call.getArray("sizes", new JSArray());
        try {
            Uri files = MediaStore.Files.getContentUri("external");
            ContentResolver cr = getContext().getContentResolver();
            if (allFiles()) {
                new Thread(() -> {
                    int n = 0;
                    long bytes = 0;
                    try {
                        for (int i = 0; i < ids.length(); i++) {
                            try {
                                File f = new File(paths.getString(i));
                                boolean ok = !f.exists() || f.delete();
                                try {
                                    cr.delete(ContentUris.withAppendedId(files, ids.getLong(i)), null, null);
                                } catch (Exception ignored) {
                                }
                                if (ok) {
                                    n++;
                                    bytes += sizes.getLong(i);
                                }
                            } catch (Exception ignored) {
                            }
                        }
                    } catch (Exception ignored) {
                    }
                    JSObject r = new JSObject();
                    r.put("deleted", n);
                    r.put("freed", bytes);
                    call.resolve(r);
                }).start();
                return;
            }
            if (Build.VERSION.SDK_INT >= 30) {
                List<Uri> uris = new ArrayList<>();
                long bytes = 0;
                for (int i = 0; i < ids.length(); i++) {
                    uris.add(ContentUris.withAppendedId(files, ids.getLong(i)));
                    bytes += sizes.getLong(i);
                }
                PendingIntent pi = MediaStore.createDeleteRequest(cr, uris);
                pendingDeleteCall = call;
                pendingDeleteBytes = bytes;
                pendingDeleteCount = uris.size();
                bridge.saveCall(call);
                getActivity().startIntentSenderForResult(pi.getIntentSender(), REQ_DELETE, null, 0, 0, 0);
                return;
            }
            int n = 0;
            long bytes = 0;
            for (int i = 0; i < ids.length(); i++) {
                try {
                    n += cr.delete(ContentUris.withAppendedId(files, ids.getLong(i)), null, null);
                    bytes += sizes.getLong(i);
                } catch (Exception ignored) {
                }
            }
            JSObject r = new JSObject();
            r.put("deleted", n);
            r.put("freed", bytes);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_DELETE || pendingDeleteCall == null) return;
        JSObject r = new JSObject();
        boolean ok = resultCode == android.app.Activity.RESULT_OK;
        r.put("deleted", ok ? pendingDeleteCount : 0);
        r.put("freed", ok ? pendingDeleteBytes : 0);
        r.put("cancelled", !ok);
        pendingDeleteCall.resolve(r);
        pendingDeleteCall = null;
    }

    @PluginMethod
    public void scanEmptyFolders(final PluginCall call) {
        if (!allFiles()) {
            call.reject("no_all_files");
            return;
        }
        new Thread(() -> {
            JSArray out = new JSArray();
            walkEmpty(Environment.getExternalStorageDirectory(), 0, out);
            JSObject r = new JSObject();
            r.put("list", out);
            call.resolve(r);
        }).start();
    }

    private void walkEmpty(File dir, int depth, JSArray out) {
        if (depth > 5 || out.length() > 300) return;
        File[] k = dir.listFiles();
        if (k == null) return;
        for (File f : k) {
            if (!f.isDirectory()) continue;
            String n = f.getName();
            if (n.equals("Android") || n.startsWith(".")) continue;
            String[] inner = f.list();
            if (inner != null && inner.length == 0) out.put(f.getAbsolutePath());
            else walkEmpty(f, depth + 1, out);
        }
    }

    @PluginMethod
    public void deleteFolders(PluginCall call) {
        JSArray p = call.getArray("paths", new JSArray());
        int n = 0;
        for (int i = 0; i < p.length(); i++) {
            try {
                File f = new File(p.getString(i));
                String[] in = f.list();
                if (in != null && in.length == 0 && f.delete()) n++;
            } catch (Exception ignored) {
            }
        }
        JSObject r = new JSObject();
        r.put("deleted", n);
        call.resolve(r);
    }
}
