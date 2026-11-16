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
  updateDoc,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
 
// ---- Tunable rules (change these to suit your pilot) ----
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // legacy sessions only; new sessions remain until user checks out
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const PARKING_TYPES = Object.freeze({
  short: { label: "Short stay (under 3 hours)", reminderMs: 3 * 3600000 },
  day: { label: "Day parking (3–12 hours)", reminderMs: 12 * 3600000 },
  overnight: { label: "Overnight (1–3 days)", reminderMs: 24 * 3600000 },
  long: { label: "Long-term / semester break", reminderMs: 7 * 24 * 3600000 },
});
export const REMINDER_COOLDOWN_MS = 12 * 3600000;
 
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
export async function startSession(zoneId, duration = "day", expectedDeparture = null) {
  if (!PARKING_TYPES[duration]) throw new Error("Invalid parking duration");
  if (expectedDeparture !== null && (!Number.isFinite(expectedDeparture) || expectedDeparture <= Date.now())) throw new Error("Expected departure must be in the future");
  const uid = await ensureSignedIn();
  await setDoc(doc(db, "sessions", uid), {
    uid,
    zoneId,
    startedAt: serverTimestamp(),
    duration,
    expectedDeparture: expectedDeparture ? new Date(expectedDeparture) : null,
    confirmedAt: serverTimestamp(),
    remindedAt: null,
  });
  logEvent(uid, zoneId, "parked");
}
 
export async function endSession(zoneId) {
  const uid = await ensureSignedIn();
  await deleteDoc(doc(db, "sessions", uid));
  logEvent(uid, zoneId, "left");
}
 
// Confirm that the vehicle remains parked; never infer departure from phone GPS.
export async function confirmStillParked(duration = "day", expectedDeparture = null) {
  if (!PARKING_TYPES[duration]) throw new Error("Invalid parking duration");
  if (expectedDeparture !== null && (!Number.isFinite(expectedDeparture) || expectedDeparture <= Date.now())) throw new Error("Expected departure must be in the future");
  const uid = await ensureSignedIn();
  await updateDoc(doc(db, "sessions", uid), { duration, expectedDeparture: expectedDeparture === null ? null : new Date(expectedDeparture), confirmedAt: serverTimestamp(), remindedAt: serverTimestamp() });
}

// Record that the user has seen a reminder (12-hour cooldown across devices).
export async function recordReminder() {
  const uid = await ensureSignedIn();
  await updateDoc(doc(db, "sessions", uid), { remindedAt: serverTimestamp() });
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
        duration: PARKING_TYPES[x.duration] ? x.duration : "legacy",
        expectedDeparture: x.expectedDeparture?.toDate?.() ?? null,
        confirmedAt: x.confirmedAt?.toDate?.() ?? x.startedAt?.toDate?.() ?? new Date(),
        remindedAt: x.remindedAt?.toDate?.() ?? null,
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
    // Legacy records retain the old 4-hour expiry for backwards compatibility.
    if (s.duration === "legacy" && age > SESSION_TTL_MS) continue;
    const z = (byZone[s.zoneId] ??= { occupied: 0, newest: null, stale: false, confirmed: 0, uncertain: 0 });
    z.occupied++;
    const interval = PARKING_TYPES[s.duration]?.reminderMs ?? SESSION_TTL_MS;
    const lastConfirmation = s.confirmedAt ?? s.startedAt;
    // A future expected departure suppresses routine reminders, but not forever.
    const dueAt = s.expectedDeparture ? s.expectedDeparture.getTime() : lastConfirmation.getTime() + interval;
    const overdue = now >= dueAt;
    if (overdue) z.uncertain++; else z.confirmed++;
    if (!z.newest || lastConfirmation > z.newest) z.newest = lastConfirmation;
    if (overdue) z.stale = true;
    if (s.uid === myUid) mine = s;
  }
  return { byZone, mine };
}
 
