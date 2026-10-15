# Campus Parking Availability — Website version

Plain HTML/CSS/JavaScript, Firebase Firestore, and Google Maps. No build tools needed.

## Files
- `index.html` — page structure (map, zone list, zone detail modal)
- `style.css` — all styling
- `firebase-config.js` — your Firebase project credentials go here
- `script.js` — map markers, Firestore live sync, report buttons, 20-spot cap logic
- `seed.js` — one-time Node.js script to populate Villages 2-5 in Firestore

## 1. Firebase setup
1. Go to console.firebase.google.com → create a project
2. Build → Firestore Database → Create database (start in **test mode** for development)
3. Project settings → your apps → add a **Web app** → copy the config object
4. Paste those values into `firebase-config.js` (replace `YOUR_API_KEY`, `YOUR_PROJECT`, etc.)

## 2. Google Maps setup
1. Go to Google Cloud Console → enable **Maps JavaScript API**
2. Create an API key (restrict it to your domain/localhost for safety)
3. In `index.html`, replace `YOUR_API_KEY` in the Google Maps `<script>` tag at the bottom

## 3. Seed the database (Villages 2-5, 20 spots each)
Option A — run the Node script:
```
npm install firebase-admin
# download a service account key from Firebase console > Project settings > Service accounts
# save it as serviceAccountKey.json next to seed.js
node seed.js
```
Option B — add the 4 documents manually in the Firestore console under a `zones` collection,
using the same fields as in `seed.js` (`zone_name`, `latitude`, `longitude`, `capacity: 20`,
`occupied: 0`, `status: "available"`).

**Note:** Village 3's coordinates are a placeholder — confirm the real parking area location
on Google Maps and update it in both `script.js` and `seed.js` before your demo.

## 4. Run it locally
Since this uses ES modules (`type="module"`), you can't just double-click `index.html` —
serve it with a local server, e.g.:
```
npx serve .
```
or in VS Code, install the "Live Server" extension and click "Go Live".

## 5. How the 20-spot cap works
- Each village document has `capacity: 20` and `occupied` (starts at 0).
- Tapping **"I parked here"** increments `occupied` by 1 (capped — button disables at 20/20).
- Tapping **"I just left"** decrements `occupied` by 1 (disables at 0/20).
- Status is derived automatically from occupancy:
  - 0–13/20 → **Available**
  - 14–19/20 → **Limited**
  - 20/20 → **Full**
- This scales easily for future real-world use — just change `capacity` per village to its
  actual spot count instead of the demo value of 20.

## 6. Deploying (optional)
Firebase Hosting is the easiest free option since you're already using Firestore:
```
npm install -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```
