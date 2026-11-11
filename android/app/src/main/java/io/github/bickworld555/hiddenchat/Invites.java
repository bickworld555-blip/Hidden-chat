package io.github.bickworld555.hiddenchat;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.provider.ContactsContract;
import android.telephony.SmsManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * "Invite a friend": reads the phone's contacts on the device (nothing is uploaded) and texts an invite link.
 * Contacts with a phone number only; one entry per person, with all of their numbers.
 */
final class Invites {
    private Invites() {}

    static boolean allowed(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static JSArray contacts(Context context) {
        JSArray list = new JSArray();
        if (!allowed(context, Manifest.permission.READ_CONTACTS)) return list;
        ContentResolver resolver = context.getContentResolver();
        String[] columns = {
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        };
        Map<String, JSObject> people = new LinkedHashMap<>();
        Map<String, ArrayList<String>> numbers = new LinkedHashMap<>();
        try (Cursor cursor = resolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, columns, null, null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE NOCASE ASC")) {
            if (cursor == null) return list;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String number = cursor.getString(2);
                if (id == null || number == null || number.trim().isEmpty()) continue;
                if (!people.containsKey(id)) {
                    JSObject person = new JSObject();
                    person.put("id", id);
                    person.put("name", name == null || name.trim().isEmpty() ? number : name);
                    people.put(id, person);
                    numbers.put(id, new ArrayList<>());
                }
                ArrayList<String> own = numbers.get(id);
                String clean = number.replaceAll("[\s().-]", "");
                if (!own.contains(clean)) own.add(clean);
            }
        }
        for (Map.Entry<String, JSObject> entry : people.entrySet()) {
            JSObject person = entry.getValue();
            person.put("numbers", new JSArray(numbers.get(entry.getKey())));
            list.put(person);
        }
        return list;
    }

    /** Sends the invite as a regular text message from this phone (the carrier may charge for it). */
    static void sendSms(Context context, String number, String text) {
        if (!allowed(context, Manifest.permission.SEND_SMS)) throw new SecurityException("SMS permission not granted");
        SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? context.getSystemService(SmsManager.class)
            : SmsManager.getDefault();
        ArrayList<String> parts = sms.divideMessage(text);
        sms.sendMultipartTextMessage(number, null, parts, null, null);
    }
}
