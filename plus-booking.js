// SpotIt Update 22 — prototype role-selected Plus bookings persisted to Firestore.
// Every booking is a 15-minute hold; expired holds stop affecting availability immediately.
// Role is selected locally; Firebase Auth still identifies the booking owner.
import { db } from "./firebase-config.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, onSnapshot, runTransaction, deleteDoc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
export const BOOKING_MS = 15 * 60 * 1000;
const adminParkingView = new URLSearchParams(window.location.search).get("adminView") === "1";
// Admin parking view has the same booking and nearby features as SpotIt Plus.
const selectedPlus = adminParkingView || sessionStorage.getItem("spotitPlusPreview") === "1";
let activePlus = selectedPlus;
let signedInUid = null;
let myBooking = null;
let allBookings = [];
let update = () => {};
const auth = getAuth();
const expired = b => !b || b.expiresAt <= Date.now();
let cleanupInFlight = new Set();
export function plusEnabled() { return activePlus; }
export function bookingEnabled() { return activePlus && !!signedInUid && auth.currentUser?.uid === signedInUid; }
export function currentBooking() { return expired(myBooking) ? null : myBooking; }
export function activeBookings() { return allBookings.filter(b => !expired(b)); }
function cleanupExpiredBookings() {
  // Expired holds have already stopped counting. Delete stale documents while a
  // client is online; Firestore TTL can clean up remaining offline documents later.
  for (const b of allBookings) {
    if (!expired(b) || b.uid !== auth.currentUser?.uid || cleanupInFlight.has(b.uid)) continue;
    cleanupInFlight.add(b.uid);
    deleteDoc(doc(db,"bookings",b.uid)).catch(err => {
      console.warn("Expired booking cleanup deferred:", err.message);
    }).finally(() => cleanupInFlight.delete(b.uid));
  }
}
export function initPlusBooking(onChange) {
  update = onChange;
  let seq = 0;
  let unsubscribeBookings = null;
  onAuthStateChanged(auth, async user => {
    const n = ++seq;
    if (unsubscribeBookings) { unsubscribeBookings(); unsubscribeBookings = null; }
    signedInUid = null;
    activePlus = selectedPlus;
    myBooking = null;
    allBookings = [];
    update();
    if (!user) return;
    signedInUid = user.uid;
    update();
    // Read aggregate bookings only after authentication, so Firestore listener
    // does not fail permanently when Anonymous Auth is still initializing.
    unsubscribeBookings = onSnapshot(collection(db,"bookings"), snap => {
      if (n !== seq) return;
      allBookings = snap.docs.map(d => {
        const x = d.data();
        return {uid:d.id,zoneId:x.zoneId,createdAt:x.createdAt?.toMillis?.() || 0,expiresAt:x.expiresAt?.toMillis?.() || 0};
      });
      myBooking = allBookings.find(b => b.uid === auth.currentUser?.uid) || null;
      update();
      cleanupExpiredBookings();
    }, err => console.warn("Booking listener unavailable; publish merged Firestore rules:",err));
  });
  setInterval(() => {
    if (myBooking && expired(myBooking)) { myBooking = null; update(); }
    cleanupExpiredBookings();
    const panel = document.getElementById("bookingPanel");
    if (panel && !panel.hidden) {
      const b = currentBooking();
      if (!b) update();
      else {
        const ms = Math.max(0,b.expiresAt-Date.now());
        document.getElementById("bookingCountdown").textContent = `${String(Math.floor(ms/60000)).padStart(2,"0")}:${String(Math.floor((ms%60000)/1000)).padStart(2,"0")}`;
      }
    }
  },1000);
}
export async function createBooking(zoneId,zone) {
  if (!activePlus) throw new Error("SpotIt Plus is required.");
  if (!bookingEnabled()) throw new Error("Please select Subscribed User and wait for Firebase to connect.");
  if (!zone?.verified || zone.capacity <= 0 || zone.capacity-zone.occupied-(zone.reserved||0) <= 0) throw new Error("No reported spaces available.");
  if (currentBooking()) throw new Error("Cancel or use your current booking first.");
  const uid = signedInUid;
  const ref = doc(db,"bookings",uid);
  await runTransaction(db,async tx => {
    const [existing,session,zoneSnap] = await Promise.all([
      tx.get(ref),tx.get(doc(db,"sessions",uid)),tx.get(doc(db,"zones",zoneId))
    ]);
    if (session.exists()) throw new Error("Check out from your current parking session first.");
    if (existing.exists() && existing.data().expiresAt?.toMillis?.() > Date.now()) throw new Error("You already have an active booking.");
    if (!zoneSnap.exists() || !zoneSnap.data().verified) throw new Error("Parking zone is not verified.");
    tx.set(ref,{uid,zoneId,createdAt:serverTimestamp(),expiresAt:Timestamp.fromMillis(Date.now()+BOOKING_MS)});
  });
  update();
}
export async function cancelBooking() {
  if (!bookingEnabled()) throw new Error("Booking authorization required.");
  await deleteDoc(doc(db,"bookings",signedInUid));
  myBooking = null;
  update();
}
export function bookingForZone(zoneId) { const b=currentBooking(); return b?.zoneId===zoneId?b:null; }
