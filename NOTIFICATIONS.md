# Rise Hub Notifications

Rise Hub uses Android's native notification system. It does **not** use Firebase, OneSignal, ChatGPT, or another push-notification service.

## Automatic new-app notifications

The app periodically checks the existing `app.json` feed. On the first sync it silently records the current catalog. After that:

- a new `id` = **New App Added** notification
- a changed `version` or `updatedAt` = **App Updated** notification
- the app's `icon` is downloaded and used in the notification when available
- the notification contains name, version, developer, size, date and description
- tapping the notification opens that app's detail page in Rise Hub

Android controls the exact background execution time. The periodic worker requests a 15-minute interval, but Android may defer background work for battery/OS reasons.

## Custom notifications

Edit the `notifications.json` at this exact public URL:

`https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/notifications.json`

The Android background worker is already hard-wired to this URL. Edit that GitHub file and commit/push the change; no APK rebuild is required for future notification content.

Example content:

```json
{
  "notifications": [
    {
      "id": "notice-2026-10-04-001",
      "enabled": true,
      "title": "🔥 New Rise Hub Update",
      "message": "A new update is now available on Rise Hub.",
      "image": "https://example.com/notice.png",
      "date": "2026-10-04",
      "time": "10:30 AM",
      "appId": "optional-app-id"
    }
  ]
}
```

Use a **new unique `id`** every time you want a notification to be delivered again. Reusing an already-delivered ID prevents duplicates.

- `enabled`: set to `true` to publish; `false` disables it.
- `title`: notification title.
- `message`: main notification text.
- `image`: optional HTTPS image URL.
- `date` / `time`: optional metadata shown in expanded text.
- `appId`: optional. If supplied, tapping the notification opens that app's detail page.

After committing the JSON, installed Rise Hub apps will pick it up during the next permitted background sync or when the app is opened.

## Permission

Android 13+ requires the user to allow notifications. Rise Hub requests `POST_NOTIFICATIONS` on first launch. If the user denies it, Android will block the notifications until permission is enabled in system settings.

## Important v2.2.2 fix

The notification worker now runs immediately after notification permission is granted. This fixes the case where the first worker run happened before Android 13+ notification permission was accepted.

The worker is also rescheduled after device boot/app replacement. Periodic checks remain subject to Android/WorkManager background scheduling rules.
