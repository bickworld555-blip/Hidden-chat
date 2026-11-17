package io.github.bickworld555.hiddenchat;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import java.util.Locale;

/**
 * What can stop calls ringing while the app is closed, and the system pages that fix it (the in-app "Make calls ring"
 * guide, src/callAccess.js). Android's battery optimization is checkable; the phone makers' own switches (Xiaomi,
 * Vivo, Oppo… "Autostart", Samsung "Sleeping apps") are not readable by apps, so only their settings page is opened
 * (the first one that exists on this phone) and the app asks the person to confirm.
 */
final class WakeSettings {
    private WakeSettings() {}

    // Known autostart / background-start pages, by maker (component names as published by each maker's settings app).
    private static final String[][] AUTOSTART = {
        { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
        { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
        { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager" },
        { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
        { "com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity" },
        { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
        { "com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity" },
        { "com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity" },
    };
    // Samsung's battery page, where "Never sleeping apps" lives (One UI).
    private static final String[][] SAMSUNG_SLEEPING = {
        { "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity" },
        { "com.samsung.android.sm", "com.samsung.android.sm.battery.ui.BatteryActivity" },
    };

    static String maker() {
        return (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase(Locale.ROOT);
    }

    /** True when Android's battery optimization leaves this app alone (or the phone has none: before Android 6). */
    static boolean batteryUnrestricted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = context.getSystemService(PowerManager.class);
        return power == null || power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    static boolean hasAutostartPage(Context context) {
        return firstExisting(context, AUTOSTART) != null;
    }

    static boolean hasSleepingPage(Context context) {
        return maker().contains("samsung") && firstExisting(context, SAMSUNG_SLEEPING) != null;
    }

    /** Opens the page for `which` ("battery", "autostart" or "sleeping"); falls back to the app's info page. */
    static void open(Context context, String which) {
        Uri pkg = Uri.parse("package:" + context.getPackageName());
        Intent intent = null;
        if ("battery".equals(which)) {
            // Android 12+: App info › Battery › Unrestricted. Before that, the "Optimize battery usage" list. No
            // REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: only standard permissions, like WhatsApp (and Play policy).
            intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                ? new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
                : new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        } else if ("autostart".equals(which)) {
            ComponentName page = firstExisting(context, AUTOSTART);
            if (page != null) intent = new Intent().setComponent(page);
        } else if ("sleeping".equals(which)) {
            ComponentName page = firstExisting(context, SAMSUNG_SLEEPING);
            if (page != null) intent = new Intent().setComponent(page);
        }
        if (intent == null || !start(context, intent)) {
            start(context, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg));
        }
    }

    private static boolean start(Context context, Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            return true;
        } catch (RuntimeException unavailable) {
            // ActivityNotFoundException, or a maker page that is not exported to other apps (SecurityException).
            return false;
        }
    }

    private static ComponentName firstExisting(Context context, String[][] pages) {
        PackageManager packages = context.getPackageManager();
        for (String[] page : pages) {
            ComponentName component = new ComponentName(page[0], page[1]);
            try {
                packages.getActivityInfo(component, 0);
                return component;
            } catch (PackageManager.NameNotFoundException missing) {
                // not on this phone
            }
        }
        return null;
    }
}
