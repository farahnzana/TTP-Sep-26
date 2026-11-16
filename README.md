# SpotIt — UTP Campus Parking Availability (Meeting 1 implementation)

## What's included
- Original responsive SpotIt Leaflet/OpenStreetMap map, zone list, coloured markers, details modal, report buttons and four-hour session expiry.
- All Village 1–6 and Academic Block 1–5 **candidate** zones in the non-destructive seed. Academic Block names and the complete campus inventory must be checked with UTP; add further blocks/areas in Firestore as needed.
- Unknown/unverified zones are grey and cannot accept parking reports until an administrator verifies capacity and parking coordinates.
- `admin.html`: Firebase email/password sign-in, admin allowlist, edit zone name, capacity and coordinates, verify locations. Details expand only when a location is selected.
- `research.html`: detection technology feasibility and accuracy limitations.
- `firestore.rules`: starter authorization rules. Review and deploy before real use.

## Run locally
1. In Firebase Console enable **Anonymous** and **Email/Password** sign-in in Authentication.
2. Create a Firestore database and publish `firestore.rules` in Firestore → Rules. This is a pilot ruleset, not production-grade capacity enforcement.
3. In VS Code open this directory and use Live Server, or run `python -m http.server 8000` and open `http://localhost:8000`.
4. To seed missing locations: install Node.js; `npm install firebase-admin`; download a service account JSON to `serviceAccountKey.json` locally (NEVER commit/share it); run `node seed.js`. Existing documents are preserved. Note that previously seeded Village 2–5 records may have demo capacities and no `verified` field; these will show as unverified until reviewed.
5. Create an Email/Password Firebase Authentication user for the administrator. Find their UID in Firebase Authentication. In Firestore Console manually create document `admins/<UID>` with boolean `enabled: true`. This step is privileged; users cannot grant themselves admin rights.
6. Visit `/admin.html`, sign in, expand a location, enter **surveyed parking-lot coordinates**, actual space count, tick verified, save.

## Important limitations
- Village 2–5 original coordinates are cafe reference points from the supplied project, **not validated parking-space locations**. The app never automatically verifies them.
- The seed includes Academic Block 1–5 as candidate labels, not a verified full UTP inventory. Validate exact block names, count and actual parking areas with campus facilities before demo claims.
- Availability counts are **crowd-sourced estimates**, not real sensor measurements. No RFID, camera, GPS parking detection, payments or physical gate integration is claimed.
- Firestore rules restrict admin changes, but browser-side capacity checks are not atomic; simultaneous check-ins can exceed a zone's capacity. A production version requires a trusted transactional backend, data minimization and proper anti-abuse protections.
- A four-hour session can expire even if a car remains parked. This is a modelling limitation, not verified exit detection.
- The original service worker and web manifest references were removed because the files were absent.
- Firebase project configuration is retained from the uploaded project; ensure you control that project and verify its settings.

## Meeting 1 traceability
1. Coverage: Village and Academic Block candidate zones.
2. Detection: feasibility assessment in `research.html`; hardware integration deferred.
3. Capacity: editable and requires admin verification.
4. Accuracy: one session per anonymous user ID, expiry, stale indicators, unknown status; known limits documented.
5. Automatic updates: Firestore live snapshots and session expiry (not physical occupancy detection).
6. Existing systems: technology comparison categories in research page; detailed literature review still needed.
7. Chips/payment: future research, not implemented.
8. Expanded scope: seed includes additional candidates; full campus survey pending.


## Role selection / login (new)

Open **index.html** using Live Server. Choose **Free user**, **Subscribed user**, or **Administrator**. The existing parking app is now at **parking.html**, and the existing admin dashboard remains **admin.html**.

- **Free:** opens the original parking app, which uses Firebase anonymous authentication and retains the existing reporting functions.
- **Subscribed:** requires Firebase Email/Password sign-in **and** an existing Firestore `users/{uid}` document containing `subscriptionStatus` (string) = `active`. Set this field through the Firebase Console only after a genuine subscription is approved. No checkout or payment integration is implemented. This role currently opens the same parking map as Free; premium features are not implemented.
- **Admin:** goes to the existing administrator sign-in. The Firestore `admins/{uid}` document with `enabled: true` and matching security rules is still required.

**Security:** Selecting a role is not permission. Firestore rules must continue to enforce admin authorization. For future premium-only data/actions, also enforce subscription status in Firestore rules or a trusted backend; the login page alone does not protect premium features. Do not allow ordinary users to change their own `subscriptionStatus` to `active` in Firestore rules. The prior `users/{uid}` rule allowed users to write all fields, so replace it with a restricted rule before relying on subscription status. Example below permits a user to create/update only `displayName`, while admins may set subscription fields:

```javascript
match /users/{uid} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow create: if request.auth != null && request.auth.uid == uid
    && request.resource.data.keys().hasOnly(['displayName']);
  allow update: if request.auth != null && request.auth.uid == uid
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['displayName']);
  allow delete: if false;
}
```

Admin changes to subscription documents can be made through Firebase Console for this prototype. Avoid introducing an insecure public self-service subscription toggle.


### Admin map and list workspace
After a verified administrator signs in at `admin.html`, the **Map & List** tab embeds the same live `parking.html` interface used by free users (including its Map/List bottom navigation). The **Verify & Edit Zones** tab retains the existing expandable zone forms. Changes saved to Firestore appear in the map/list through the existing realtime listener. The embedded view uses the same Firebase Auth session as the parent page. Subscription features are unchanged.


## Mobile-first integration (this ZIP)
- Start at `index.html` (role selection), then use `parking.html` for free/subscribed users or `admin.html` for admins.
- All three views use a phone-width layout, including the admin map/list and verify/edit dashboard.
- The admin Map & List view displays the same `parking.html` interface within the phone-width admin screen.
- The Firebase config comes from the most recently uploaded project; no account credentials are bundled.
- Approve administrators through `admins/{uid}` with boolean `enabled: true` and publish the included `firestore.rules` after reviewing them against your existing rules.
- Subscription purchase/features remain deferred.
