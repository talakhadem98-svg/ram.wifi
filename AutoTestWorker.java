package com.nexus.netboost;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

public class AutoTestWorker extends Worker {

    public AutoTestWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context c = getApplicationContext();
            JSObject w = NetBoostPlugin.wifiInfoObj(c);
            if (!w.optBoolean("connected", false)) return Result.success();

            String gw = w.optString("gateway", "");
            JSObject g = gw.isEmpty() ? new JSObject() : NetBoostPlugin.doPing(gw, 4);
            JSObject n = NetBoostPlugin.doPing("1.1.1.1", 4);

            JSONObject e = new JSONObject();
            e.put("t", System.currentTimeMillis());
            e.put("ssid", w.optString("ssid", ""));
            e.put("rssi", w.optInt("rssi", 0));
            e.put("link", w.optInt("linkSpeed", 0));
            e.put("freq", w.optInt("freq", 0));
            e.put("gw", g.optDouble("avg", -1));
            e.put("net", n.optDouble("avg", -1));
            e.put("loss", n.optDouble("loss", 0));
            e.put("jit", n.optDouble("jitter", 0));

            SharedPreferences sp = c.getSharedPreferences("netboost", Context.MODE_PRIVATE);
            JSONArray old = new JSONArray(sp.getString("hist", "[]"));
            JSONArray out = new JSONArray();
            int start = Math.max(0, old.length() - 299);
            for (int i = start; i < old.length(); i++) out.put(old.get(i));
            out.put(e);
            sp.edit().putString("hist", out.toString()).apply();
        } catch (Exception ignored) {
        }
        return Result.success();
    }
}
