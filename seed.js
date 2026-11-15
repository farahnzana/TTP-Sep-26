// Run this once (Node.js) to populate Firestore with Villages 2-5.
// Occupancy is NOT stored here any more: it is computed live from the
// "sessions" collection (see sessions.js), so only static zone info is seeded.
//
// Setup:
//   npm install firebase-admin
//   Download a service account key from Firebase console
//     (Project settings > Service accounts > Generate new private key)
//   Save it as serviceAccountKey.json in this folder (never commit it!)
//   node seed.js

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const zones = [
  { id: "v2", zone_name: "Village 2", latitude: 4.3877326, longitude: 100.9678099, capacity: 88 }, // Village 2 Cafe
  { id: "v3", zone_name: "Village 3", latitude: 4.3869444, longitude: 100.9655556, capacity: 79 }, // Village 3 Cafe
  { id: "v4", zone_name: "Village 4", latitude: 4.3883417, longitude: 100.9655226, capacity: 43 }, // Village 4 Cafe
  // TODO: confirm. 427 = sum of the 7 sub-zone figures listed in the business
  // document (83+92+78+10+24+44+96), but 8 sub-zones (A-H) are named.
  { id: "v5", zone_name: "Village 5", latitude: 4.3860593, longitude: 100.9637785, capacity: 427 }, // Village 5 Cafe
];

async function seed() {
  for (const zone of zones) {
    // set() replaces the whole document, which also removes the old
    // occupied / status / last_updated fields that are no longer used.
    await db.collection("zones").doc(zone.id).set({
      zone_name: zone.zone_name,
      latitude: zone.latitude,
      longitude: zone.longitude,
      capacity: zone.capacity,
    });
    console.log(`Seeded ${zone.zone_name} (capacity ${zone.capacity})`);
  }
  console.log("Done.");
  process.exit(0);
}

seed();
