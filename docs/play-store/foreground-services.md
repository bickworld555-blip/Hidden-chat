# Play Console: foreground service and full-screen intent declarations

What to enter in **Play Console › App content › Foreground service permissions** and **Full-screen intent**,
for each permission in `android/app/src/main/AndroidManifest.xml`. Each answer matches what the code does
(`MessagingService.java`, `UploadService.java`, `Alerts.java`). If the code changes, update this file too.

Google asks for a short video per declared type. It should show the feature from the user's tap until the
ongoing notification appears. The shot list and recording commands are at the end of this file.

## Summary

| Permission | Service | When it runs | Play task type to choose |
| --- | --- | --- | --- |
| `FOREGROUND_SERVICE_PHONE_CALL` | `MessagingService` (+ `CallConnectionService`, self-managed Telecom) | During a voice or video call that Android's Telecom knows about | Phone call: "Calling (VoIP)" |
| `FOREGROUND_SERVICE_MICROPHONE` | `MessagingService` | During a call, when the microphone permission is granted | Microphone: "Voice or video call" |
| `FOREGROUND_SERVICE_CAMERA` | `MessagingService` | During a **video** call, when the camera permission is granted | Camera: "Video call" |
| `FOREGROUND_SERVICE_DATA_SYNC` | `MessagingService` (push-triggered sync) and `UploadService` (sending files) | A few seconds after a push message, to fetch and acknowledge it; while photos, videos or files are being sent | Data sync: "Network transfer: upload or download", "Sync of messages" |
| `FOREGROUND_SERVICE_SPECIAL_USE` | `MessagingService` | Only on devices where push (Firebase Cloud Messaging) is not available: keeps the encrypted connection open so messages and calls arrive | Special use (free text below) |
| `USE_FULL_SCREEN_INTENT` | `Alerts.java` (incoming call notification) | When a call rings while the phone is locked or the app is not open | "Calling and alarm app": incoming calls |

## Answers to paste

### Phone call (`FOREGROUND_SERVICE_PHONE_CALL`)

> Hidden Messenger makes end-to-end encrypted voice and video calls. During a call the app registers it with
> Android Telecom (self-managed ConnectionService) and runs a phone-call foreground service, so the call keeps
> going with the screen off or the app in the background, and headsets, cars and watches can answer or hang up.
> The service stops when the call ends.

### Microphone (`FOREGROUND_SERVICE_MICROPHONE`)

> During a voice or video call the microphone must keep working when the user switches apps or turns the screen
> off. The service declares the microphone type only while a call is in progress and the user has granted the
> microphone permission. An ongoing "call in progress" notification is shown the whole time.

### Camera (`FOREGROUND_SERVICE_CAMERA`)

> During a video call, the camera keeps sending video when the app goes to picture-in-picture or the background.
> The camera type is used only during video calls with the camera permission granted, and stops when the call ends
> or the user turns the camera off.

### Data sync (`FOREGROUND_SERVICE_DATA_SYNC`)

> 1. When a push notification announces a new message, the app runs a short sync. It downloads the encrypted
>    message, decrypts it on the device and tells the server it arrived, so the message can be deleted from the
>    server. This is user-visible: the message notification appears, and the sync ends within seconds.
> 2. When the user sends photos, videos or files, uploads continue in the background with a "Sending 3 files ·
>    45%" notification until they finish or the user cancels.
>
> Both stay well under Android 15's six-hour daily limit for data sync.

### Special use (`FOREGROUND_SERVICE_SPECIAL_USE`)

The manifest's `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` says: *"Keeps the Hidden Messenger connection open so messages
and calls arrive while the app is in the background."*

> Hidden Messenger is an end-to-end encrypted messenger that works without a phone number or Google account.
> On phones where Firebase Cloud Messaging is not available (no Google Play services, or push registration
> failed), it is the only way for messages and incoming calls to arrive. On those phones the app keeps one
> encrypted connection to its server open in a foreground service, with a visible ongoing notification. On phones with working push the service is not used this way: push wakes the app instead.
> No other API covers this. WorkManager and JobScheduler cannot deliver incoming calls in real time.

**Rejection risk.** Google reviews special use strictly. If it is refused, a fallback is to ship the Play Store
build with this path off (push only), because Play devices have Google Play services. In that build, remove
`specialUse` from `MessagingService`'s `foregroundServiceType` and `FOREGROUND_SERVICE_SPECIAL_USE` from the
manifest. Keep it in the direct-download APK. That is a code change, not made yet.

### Full-screen intent (`USE_FULL_SCREEN_INTENT`)

> Incoming voice and video calls. When someone calls and the phone is locked, Hidden Messenger shows the
> incoming-call screen (Accept / Decline) in full screen, as the phone app does. It is used only for incoming
> calls, never for messages or promotions.

On Android 14+, Play grants this only to calling and alarm apps that declare it. Choose **"Make and receive calls"**.

## Videos to record

Record on a real phone with **Settings › Developer options › Show taps** on. Each clip should be 20–40 seconds.
Use two test accounts, never real chats.

| # | For | Show |
| --- | --- | --- |
| 1 | Phone call, microphone | Start a voice call, press Home, turn the screen off and on. The call notification stays and the other phone still hears you. Hang up and the notification goes. |
| 2 | Camera | Start a video call, press Home. Picture-in-picture shows the video continuing. Hang up. |
| 3 | Data sync (sync) | Swipe the app away. Send it a message from the second phone. The message notification appears within seconds. |
| 4 | Data sync (upload) | Send a large video and press Home. "Sending 1 file · n%" progresses to done. |
| 5 | Special use | Only if declared. On a phone without Google Play services (or push turned off), show the ongoing connection notification, then receive a message and a call with the app in the background. |
| 6 | Full-screen intent | Lock the phone. Call it from the second phone. The full-screen incoming-call screen appears, then Accept. |

Record over USB with `adb shell screenrecord --time-limit 40 /sdcard/fgs-1.mp4`, then `adb pull /sdcard/fgs-1.mp4`.
Or use the phone's built-in screen recorder. Upload each clip, for example as an unlisted YouTube video, and paste
the link into the declaration.
