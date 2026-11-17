package io.github.bickworld555.hiddenchat;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.provider.ContactsContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reads the phone's contacts for "Sync phone contacts" (src/deviceContacts.js). Only asked for after the person taps
 * Sync (READ_CONTACTS). Everything read stays on the phone: the app sends the server only the 10-digit Hidden Messenger
 * IDs it finds in these entries (POST /api/v1/contacts/match), never names or phone numbers. Phone numbers are kept
 * locally for the Invite button (an SMS the person sends themselves).
 *
 * Returns [{ id, name, fields: [{ kind, text, label }] }] where kind is phone, note, website, im or nickname.
 */
final class DeviceContacts {
    private DeviceContacts() {}

    static final int MAX_CONTACTS = 5000;
    private static final int MAX_FIELDS = 20;
    private static final int MAX_TEXT = 300;

    static JSArray read(Context context) {
        ContentResolver resolver = context.getContentResolver();
        Map<Long, JSObject> byContact = new LinkedHashMap<>();
        Map<Long, JSArray> fields = new LinkedHashMap<>();
        String[] projection = {
            ContactsContract.Data.CONTACT_ID,
            ContactsContract.Data.DISPLAY_NAME_PRIMARY,
            ContactsContract.Data.MIMETYPE,
            ContactsContract.Data.DATA1,
            ContactsContract.Data.DATA2,
            ContactsContract.Data.DATA3,
        };
        String selection = ContactsContract.Data.MIMETYPE + " IN (?, ?, ?, ?, ?)";
        String[] args = {
            ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Im.CONTENT_ITEM_TYPE,
            ContactsContract.CommonDataKinds.Nickname.CONTENT_ITEM_TYPE,
        };
        try (Cursor cursor = resolver.query(ContactsContract.Data.CONTENT_URI, projection, selection, args, ContactsContract.Data.CONTACT_ID)) {
            if (cursor == null) return new JSArray();
            while (cursor.moveToNext()) {
                long id = cursor.getLong(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                String text = cursor.getString(3);
                if (text == null || text.trim().isEmpty()) continue;
                JSObject contact = byContact.get(id);
                if (contact == null) {
                    if (byContact.size() >= MAX_CONTACTS) continue;
                    contact = new JSObject();
                    contact.put("id", String.valueOf(id));
                    contact.put("name", name == null ? "" : name);
                    byContact.put(id, contact);
                    fields.put(id, new JSArray());
                }
                JSArray list = fields.get(id);
                if (list.length() >= MAX_FIELDS) continue;
                JSObject field = new JSObject();
                field.put("kind", kindOf(mime));
                field.put("text", text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) : text);
                field.put("label", labelOf(mime, cursor));
                list.put(field);
            }
        }
        JSArray result = new JSArray();
        for (Map.Entry<Long, JSObject> entry : byContact.entrySet()) {
            entry.getValue().put("fields", fields.get(entry.getKey()));
            result.put(entry.getValue());
        }
        return result;
    }

    private static String kindOf(String mime) {
        if (ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(mime)) return "phone";
        if (ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE.equals(mime)) return "note";
        if (ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE.equals(mime)) return "website";
        if (ContactsContract.CommonDataKinds.Im.CONTENT_ITEM_TYPE.equals(mime)) return "im";
        return "nickname";
    }

    // A custom label the person typed ("Hidden Messenger", "HM ID"…), or "" for the standard types.
    private static String labelOf(String mime, Cursor cursor) {
        if (!ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(mime)
            && !ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE.equals(mime)
            && !ContactsContract.CommonDataKinds.Im.CONTENT_ITEM_TYPE.equals(mime)) return "";
        String label = cursor.getString(5);
        return label == null ? "" : label;
    }
}
