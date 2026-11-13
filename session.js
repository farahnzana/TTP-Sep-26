// sessions.js — session-based reporting for SpotIt
// One active parking session per user (document id = user id).
// Occupancy = number of non-expired sessions in a zone, so forgotten
// "I just left" taps expire on their own instead of drifting forever.
 
import { db } from "./firebase-config.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
 
// ---- Tunable rules (change these to suit your pilot) ----
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // a session stops counting after 4 hours
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // after 2 hours the zone is flagged "may be outdated"
 
// ---- Anonymous sign-in (gives every browser a stable user id) ----
// Assumes firebase-config.js calls initializeApp(...) (default app).
const auth = getAuth(getApp());
let uidPromise = null;
 
export function ensureSignedIn() {
  if (!uidPromise) {
    uidPromise = new Promise((resolve, reject) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        if (user) {
          unsub();
          resolve(user.uid);
        } else {
          signInAnonymously(auth).catch(reject);
        }
      });
    });
  }
  return uidPromise;
}
 
// ---- Report actions ----
// Starting a session fails (by security rule) if the user already has one,
// which is what enforces "one active parking session per user".
export async function startSession(zoneId) {
  const uid = await ensureSignedIn();
  await setDoc(doc(db, "sessions", uid), {
    uid,
    zoneId,
    startedAt: serverTimestamp(),
  });
  logEvent(uid, zoneId, "parked");
}
 
export async function endSession(zoneId) {
  const uid = await ensureSignedIn();
  await deleteDoc(doc(db, "sessions", uid));
  logEvent(uid, zoneId, "left");
}
 
// Silent cleanup of the user's own expired session (no event logged).
export async function removeExpiredSession() {
  const uid = await ensureSignedIn();
  await deleteDoc(doc(db, "sessions", uid));
}
 
// Timestamped log of every report, for the evaluation
// (submission-to-display delay, number of reports per zone, etc.).
function logEvent(uid, zoneId, type) {
  addDoc(collection(db, "events"), {
    uid,
    zoneId,
    type,
    createdAt: serverTimestamp(),
  }).catch((err) => console.warn("Event log failed:", err));
}
 
// ---- Live listener ----
export function listenToSessions(callback) {
  return onSnapshot(collection(db, "sessions"), (snap) => {
    const list = snap.docs.map((d) => {
      const x = d.data();
      return {
        uid: d.id,
        zoneId: x.zoneId,
        // pending server timestamps read as null for a moment -> treat as "now"
        startedAt: x.startedAt?.toDate?.() ?? new Date(),
      };
    });
    callback(list);
  });
}
 
// ---- Turn raw sessions into per-zone numbers ----
// Returns { byZone: { zoneId: { occupied, newest, stale } }, mine }
export function summarise(sessions, myUid, now = Date.now()) {
  const byZone = {};
  let mine = null;
  for (const s of sessions) {
    const age = now - s.startedAt.getTime();
    if (age > SESSION_TTL_MS) continue; // expired: ignore
    const z = (byZone[s.zoneId] ??= { occupied: 0, newest: null, stale: false });
    z.occupied++;
    if (!z.newest || s.startedAt > z.newest) z.newest = s.startedAt;
    if (age > STALE_AFTER_MS) z.stale = true;
    if (s.uid === myUid) mine = s;
  }
  return { byZone, mine };
}
 
