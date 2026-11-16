// Non-destructive Firestore seed. Requires firebase-admin and a LOCAL serviceAccountKey.json.
// Coordinates are only included for the original Village 2-5 sample points; they represent cafe references, NOT surveyed parking lots.
// No zone is marked verified automatically. Verify coordinates and capacity in the admin dashboard.
const admin = require("firebase-admin");
const fs = require("fs");
if (!fs.existsSync("./serviceAccountKey.json")) { console.error("Missing local serviceAccountKey.json"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();
const known = {
 v2: [4.3877326, 100.9678099], v3: [4.3869444, 100.9655556],
 v4: [4.3883417, 100.9655226], v5: [4.3860593, 100.9637785]
};
const zones = [1,2,3,4,5,6].map(n => ({ id:`v${n}`, zone_name:`Village ${n}`, area:"Village" }))
  .concat([1,2,3,4,5].map(n => ({id:`ab${n}`, zone_name:`Academic Block ${n}`, area:"Academic Block"})));
(async () => {
 for (const z of zones) {
  const ref = db.collection("zones").doc(z.id);
  const snap = await ref.get();
  if (snap.exists) { console.log(`Kept existing ${z.id} unchanged`); continue; }
  const coords = known[z.id];
  await ref.set({ zone_name:z.zone_name, area:z.area, latitude:coords?.[0] ?? null,
    longitude:coords?.[1] ?? null, capacity:0, verified:false,
    createdAt:admin.firestore.FieldValue.serverTimestamp() });
  console.log(`Created unverified ${z.id}`);
 }
 console.log("Seed complete. Review all locations and capacities in admin dashboard.");
})().catch(e => {console.error(e);process.exitCode=1;});
