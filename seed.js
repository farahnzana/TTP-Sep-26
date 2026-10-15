// Run this once (Node.js) to populate Firestore with Villages 2-5,
// each capped at 20 spots, occupied starting at 0.
//
// Setup:
//   npm install firebase-admin
//   Download a service account key from Firebase console
//     (Project settings > Service accounts > Generate new private key)
//   Save it as serviceAccountKey.json in this folder
//   node seed.js

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const zones = [
  { id: "v2", zone_name: "Village 2", latitude: 4.3877326, longitude: 100.9678099 }, // Village 2 Cafe
  { id: "v3", zone_name: "Village 3", latitude: 4.3869444, longitude: 100.9655556 }, // Village 3 Cafe
  { id: "v4", zone_name: "Village 4", latitude: 4.3883417, longitude: 100.9655226 }, // Village 4 Cafe
  { id: "v5", zone_name: "Village 5", latitude: 4.3860593, longitude: 100.9637785 }, // Village 5 Cafe
];

async function seed() {
  for (const zone of zones) {
    await db.collection("zones").doc(zone.id).set({
      zone_name: zone.zone_name,
      latitude: zone.latitude,
      longitude: zone.longitude,
      capacity: 20,
      occupied: 0,
      status: "available",
      last_updated: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Seeded ${zone.zone_name}`);
  }
  console.log("Done.");
  process.exit(0);
}

seed();
