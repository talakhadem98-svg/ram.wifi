# NetBoost
1. این پوشه رو توی یه ریپوی GitHub بذار (push).
2. تب Actions ← Build APK ← اجرا. بعد از چند دقیقه فایل NetBoost-apk رو دانلود کن (app-debug.apk).
3. نصب کن و مجوزها رو بده.

اختیاری (یک بار با ADB):
  adb shell pm grant com.nexus.netboost android.permission.WRITE_SECURE_SETTINGS   # تغییر Private DNS از داخل اپ
  adb shell pm trim-caches 999G                                                     # پاک کردن کش همه برنامه‌ها
