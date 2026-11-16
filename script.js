import { db } from "./firebase-config.js";
import { initializePlusNearby } from "./plus-nearby.js";
import { initPlusBooking, plusEnabled, bookingEnabled, currentBooking, activeBookings, createBooking, cancelBooking, bookingForZone } from "./plus-booking.js";
import { distanceMeters, verifyParkingProximity, CHECKIN_RADIUS_METERS, GPS_DEMO_MODE, DEMO_RADIUS_METERS, getZoneCheckinRadius } from "./gps-checkin.js";
import {
  collection,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ensureSignedIn,
  listenToSessions,
  startSession,
  endSession,
  removeExpiredSession,
  confirmStillParked,
  recordReminder,
  PARKING_TYPES,
  REMINDER_COOLDOWN_MS,
  summarise,
  SESSION_TTL_MS,
} from "./session.js";

// Used only if a zone document has no "capacity" field.
// Set the real capacity per zone in Firestore (zones/v2/capacity, etc.).
const DEFAULT_CAPACITY = 0; // Unverified capacities are shown as pending, never as live availability.

let map;
let markers = {};
let userGpsDot = null;
let userGpsAccuracyCircle = null;
let selectedRadiusCircle = null; // One geofence preview on the main map
let radiusSelectionId = null;
let zonesData = {};     // static zone info from Firestore
let sessionsList = [];  // live sessions from Firestore
let currentZones = {};  // zones + computed occupancy/status
let selectedZoneId = null;
let myUid = null;
const PLUS_PREVIEW = sessionStorage.getItem("spotitPlusPreview") === "1";
let mySession = null;   // this user's active (non-expired) session, if any

// Update 23: browser-local presentation layer. NEVER use this data for Firebase writes,
// booking limits, GPS checks, or real session/booking availability.
const PRESENTATION_KEY = "spotitPresentation23";
function presentationSettings() {
  try { const x = JSON.parse(localStorage.getItem(PRESENTATION_KEY) || "null");
    return x && x.enabled === true && x.zones && typeof x.zones === "object" ? x : null;
  } catch { return null; }
}
function displayedZone(liveZone) {
  const cfg = presentationSettings();
  const requested = cfg?.zones?.[liveZone.id];
  if (!requested || !["available", "limited", "full", "unknown"].includes(requested)) return liveZone;
  if (requested === "unknown") return { ...liveZone, verified: false, status: "unknown", presentation: true };
  const total = Math.max(1, liveZone.capacity || 1);
  const taken = requested === "full" ? total : requested === "limited" ? Math.max(1, Math.ceil(total * .85)) : 0;
  return { ...liveZone, verified: true, capacity: total, occupied: taken, reserved: 0,
    status: requested, lastUpdated: null, uncertain: 0, presentation: true };
}
function refreshPresentation() {
  renderMarkers(); renderZoneList();
  if (selectedZoneId) renderModal(selectedZoneId);
}
window.addEventListener("storage", e => { if (e.key === PRESENTATION_KEY) refreshPresentation(); });
window.addEventListener("message", e => {
  if (e.origin === location.origin && e.data === "spotit-refresh-presentation") refreshPresentation();
});

// ---- Leaflet map init (OpenStreetMap tiles, free, no API key) ----
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([4.3870, 100.9660], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
}
initMap();

// Map-only "My location" control: requests location only on a user click.
// Never creates a session or changes Firebase data.
const mapMyLocation = document.getElementById("mapMyLocation");
const mapLocationMessage = document.getElementById("mapLocationMessage");
let mapLocationMessageTimeout = null;
function mapLocationFeedback(message, isError = false) {
  clearTimeout(mapLocationMessageTimeout);
  mapLocationMessage.textContent = message;
  mapLocationMessage.dataset.error = String(isError);
  mapLocationMessage.hidden = false;
  mapLocationMessageTimeout = setTimeout(() => { mapLocationMessage.hidden = true; }, 4500);
}
mapMyLocation.addEventListener("click", () => {
  if (!window.isSecureContext || !navigator.geolocation) {
    mapLocationFeedback("Location requires HTTPS or localhost and browser location access.", true);
    return;
  }
  mapMyLocation.disabled = true;
  mapMyLocation.classList.add("is-locating");
  navigator.geolocation.getCurrentPosition(
    ({coords}) => {
      mapMyLocation.disabled = false;
      mapMyLocation.classList.remove("is-locating");
      const locationResult = {
        latitude: coords.latitude, longitude: coords.longitude,
        accuracy: coords.accuracy
      };
      showUserGpsPreview(locationResult);
      map.flyTo([coords.latitude, coords.longitude], Math.max(map.getZoom(), 17), {duration: 0.65});
      mapLocationFeedback(`Your browser estimates your position (±${Math.round(coords.accuracy)} m).`);
    },
    (error) => {
      mapMyLocation.disabled = false;
      mapMyLocation.classList.remove("is-locating");
      const message = error.code === 1
        ? "Location access denied. Enable location permissions in your browser."
        : error.code === 3
          ? "Location timed out. Please try again."
          : "Location unavailable. Please try again.";
      mapLocationFeedback(message, true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
});


// ---- Splash screen ----
window.addEventListener("load", () => {
  setTimeout(() => {
    const splash = document.getElementById("splash");
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 400);
  }, 1200);
});

// ---- Status derivation from occupied/capacity ----
function statusFor(occupied, capacity) {
  if (!Number.isFinite(capacity) || capacity <= 0) return "unknown";
  if (occupied >= capacity) return "full";
  if (occupied >= capacity * 0.7) return "limited";
  return "available";
}

function markerColor(status) {
  if (status === "unknown") return "#94a3b8";
  if (status === "full") return "#e74c3c";
  if (status === "limited") return "#f39c12";
  return "#2ecc71";
}

function timeAgo(date) {
  if (!date) return "No active reports";
  const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "Updated just now";
  if (diffMin === 1) return "Updated 1 min ago";
  if (diffMin < 60) return `Updated ${diffMin} mins ago`;
  const h = Math.floor(diffMin / 60);
  return `Updated ${h}h ago`;
}

function freshnessText(zone) {
  if (zone.uncertain > 0) return `⚠ Low Confidence · ${zone.uncertain} overdue confirmation(s) · ${timeAgo(zone.lastUpdated)}`;
  if (!zone.lastUpdated) return "Low Confidence · No recent confirmed reports";
  return timeAgo(zone.lastUpdated);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- Firestore: zone info (static) ----
function showConnectionError(error) {
  const el = document.getElementById("connectionStatus");
  if (el) { el.hidden = false; el.textContent = `Connection error: ${error.message}`; }
}

function listenToZones() {
  onSnapshot(collection(db, "zones"), (snapshot) => {
    if (snapshot.empty) {
      console.warn("No zones found in Firestore — run seed.js first.");
      return;
    }
    zonesData = {};
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      zonesData[docSnap.id] = {
        name: d.zone_name,
        lat: d.latitude,
        lng: d.longitude,
        capacity: Number.isFinite(d.capacity) ? d.capacity : DEFAULT_CAPACITY,
        verified: d.verified === true,
        radius: d.radius,
      };
    });
    recompute();
  }, (error) => { console.error("Zone subscription failed", error); showConnectionError(error); });
}

// ---- Combine zones + sessions into what the UI shows ----
function recompute() {
  const { byZone, mine } = summarise(sessionsList, myUid);
  const reservations = {};
  for (const b of activeBookings()) {
    // A car checked in is already counted in sessions, not again as a booking.
    if (sessionsList.some(s => s.uid === b.uid)) continue;
    reservations[b.zoneId] = (reservations[b.zoneId] || 0) + 1;
  }
  mySession = mine;

  // Clean up legacy four-hour sessions only. New duration-based sessions are never auto-checked-out.
  const raw = sessionsList.find((s) => s.uid === myUid);
  if (raw && raw.duration === "legacy" && !mine && Date.now() - raw.startedAt.getTime() > SESSION_TTL_MS) {
    removeExpiredSession().catch(() => {});
  }

  currentZones = {};
  Object.entries(zonesData).forEach(([id, z]) => {
    const info = byZone[id] || { occupied: 0, newest: null, stale: false, confirmed: 0, uncertain: 0 };
    currentZones[id] = {
      id,
      name: z.name,
      lat: z.lat,
      lng: z.lng,
      capacity: z.capacity,
      occupied: info.occupied,
      reserved: reservations[id] || 0,
      status: z.verified ? statusFor(info.occupied + (reservations[id] || 0), z.capacity) : "unknown",
      verified: z.verified,
      radius: getZoneCheckinRadius(z),
      lastUpdated: info.newest,
      stale: info.stale,
      uncertain: info.uncertain,
      confirmed: info.confirmed,
    };
  });

  renderMarkers();
  updateSelectedRadiusCircle();
  renderZoneList();
  if (selectedZoneId) renderModal(selectedZoneId);
}

// ---- Visual GPS geofence for the selected parking zone ----
// This is a display overlay only; actual GPS validation remains in gps-checkin.js.
function updateSelectedRadiusCircle() {
  const zone = radiusSelectionId ? currentZones[radiusSelectionId] : null;
  if (!zone || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lng)) {
    if (selectedRadiusCircle) {
      map.removeLayer(selectedRadiusCircle);
      selectedRadiusCircle = null;
    }
    return;
  }
  const center = [zone.lat, zone.lng];
  const radius = getZoneCheckinRadius(zone);
  if (selectedRadiusCircle) {
    selectedRadiusCircle.setLatLng(center);
    selectedRadiusCircle.setRadius(radius);
  } else {
    selectedRadiusCircle = L.circle(center, {
      radius,
      color: '#16a34a',
      weight: 2,
      opacity: 0.9,
      fillColor: '#22c55e',
      fillOpacity: 0.14,
      interactive: false,
    }).addTo(map);
    // Keep the filled area behind parking markers.
    selectedRadiusCircle.bringToBack();
  }
}

// Display the exact browser location reading used for the last check-in attempt.
// Blue dot = estimated phone/laptop location; translucent blue circle = reported accuracy.
// Location is not stored in Firestore and is not continuously tracked.
function clearUserGpsPreview() {
  if (userGpsDot) { map.removeLayer(userGpsDot); userGpsDot = null; }
  if (userGpsAccuracyCircle) { map.removeLayer(userGpsAccuracyCircle); userGpsAccuracyCircle = null; }
}
function showUserGpsPreview(result) {
  if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) ||
      !Number.isFinite(result.accuracy)) return;
  const coords = [result.latitude, result.longitude];
  if (!userGpsAccuracyCircle) {
    userGpsAccuracyCircle = L.circle(coords, {
      radius: Math.max(0, result.accuracy), color: '#2563eb', weight: 2,
      fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false
    }).addTo(map);
  } else {
    userGpsAccuracyCircle.setLatLng(coords).setRadius(Math.max(0, result.accuracy));
  }
  if (!userGpsDot) {
    userGpsDot = L.circleMarker(coords, {
      radius: 7, color: '#ffffff', weight: 3,
      fillColor: '#2563eb', fillOpacity: 1, interactive: false
    }).addTo(map);
  } else userGpsDot.setLatLng(coords);
  userGpsAccuracyCircle.bringToBack();
  // Keep parking geofence visible, too, even when the accuracy circle overlaps it.
  if (selectedRadiusCircle) selectedRadiusCircle.bringToBack();
}

// Click outside markers to clear the preview; markers themselves open a zone.
map.on('click', () => {
  clearUserGpsPreview();
  radiusSelectionId = null;
  updateSelectedRadiusCircle();
});

// ---- Render markers on the map ----
function renderMarkers() {
  Object.values(currentZones).forEach((zone) => {
    if (!Number.isFinite(zone.lat) || !Number.isFinite(zone.lng)) return;
    const color = markerColor(displayedZone(zone).status);
    const isSelected = zone.id === selectedZoneId;
    const dash = zone.stale && !presentationSettings() ? "4 3" : null; // dashed border = possibly outdated
    if (markers[zone.id]) {
      markers[zone.id].setStyle({ fillColor: color, dashArray: dash, weight: isSelected ? 4 : 2, color: isSelected ? "#174e77" : "#fff", radius: isSelected ? 13 : 10 });
      markers[zone.id].setLatLng([zone.lat, zone.lng]);
      markers[zone.id].setTooltipContent(zone.name);
    } else {
      const marker = L.circleMarker([zone.lat, zone.lng], {
        radius: isSelected ? 13 : 10,
        fillColor: color,
        color: isSelected ? "#174e77" : "#fff",
        weight: isSelected ? 4 : 2,
        fillOpacity: 1,
        dashArray: dash,
        bubblingMouseEvents: false, // Marker click must not clear the selected radius via map click.
      }).addTo(map);
      marker.bindTooltip(zone.name);
      marker.on("click", (event) => {
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        openModal(zone.id);
      });
      markers[zone.id] = marker;
    }
  });
  Object.keys(markers).forEach((id) => { if (!currentZones[id] || !Number.isFinite(currentZones[id].lat) || !Number.isFinite(currentZones[id].lng)) { map.removeLayer(markers[id]); delete markers[id]; } });
}

// ---- Render the zone list ----
function renderZoneList() {
  const container = document.getElementById("zoneList");
  container.querySelectorAll(".zone-card").forEach((el) => el.remove());

  Object.values(currentZones)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((liveZone) => {
      const zone = displayedZone(liveZone);
      const card = document.createElement("div");
      card.className = "zone-card";
      card.innerHTML = `
        <div>
          <div class="zone-name">${escapeHtml(zone.name)}</div>
          <div class="zone-sub">${zone.verified ? escapeHtml(`${Math.max(0, zone.capacity-zone.occupied-(zone.reserved||0))} of ${zone.capacity} reported available · ${freshnessText(zone)}`) : "Capacity / location awaiting verification"}</div>
        </div>
        <span class="badge ${zone.status}">${zone.status[0].toUpperCase() + zone.status.slice(1)}</span>
      `;
      card.addEventListener("click", () => openModal(zone.id));
      container.appendChild(card);
    });
}

// GPS feedback is intentionally scoped to the currently selected zone.
function showGpsStatus(state, title, message, result = null) {
  const panel = document.getElementById("gpsStatusPanel");
  panel.hidden = false;
  panel.dataset.state = state;
  document.getElementById("gpsStatusIcon").textContent = state === "success" ? "✅" : state === "error" ? "⚠️" : state === "demo" ? "🧪" : "📍";
  document.getElementById("gpsStatusTitle").textContent = title;
  document.getElementById("gpsStatusMessage").textContent = message;
  document.getElementById("gpsDistance").textContent = result?.distance == null ? "—" : `${Math.round(result.distance)} m`;
  document.getElementById("gpsAccuracy").textContent = result?.accuracy == null ? "—" : `±${Math.round(result.accuracy)} m`;
  document.getElementById("gpsRadius").textContent = `${result?.radius ?? (GPS_DEMO_MODE ? DEMO_RADIUS_METERS : getZoneCheckinRadius(currentZones[selectedZoneId]))} m`;
}
function clearGpsStatus() {
  const panel = document.getElementById("gpsStatusPanel");
  panel.hidden = true;
  panel.dataset.state = "";
}

// ---- Modal (zone detail) ----
function openModal(zoneId) {
  clearUserGpsPreview();
  selectedZoneId = zoneId;
  renderMarkers();
  radiusSelectionId = zoneId;
  updateSelectedRadiusCircle();
  clearGpsStatus();
  renderModal(zoneId);
  document.getElementById("modalOverlay").classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  selectedZoneId = null;
  renderMarkers();
  clearGpsStatus();
}

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>`;
const CROSS_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;

function renderPlusActions(zone) {
  const plus = plusEnabled();
  const book = document.getElementById("btnBookParking");
  const nearest = document.getElementById("btnNearestParking");
  const hint = document.getElementById("plusFeatureHint");
  const active = currentBooking();
  const mine = bookingForZone(zone.id);
  book.classList.toggle("plus-locked", !plus);
  nearest.classList.toggle("plus-locked", !plus);
  nearest.disabled = !plus;
  nearest.textContent = plus ? "↗ Navigate" : "🔒 Navigate";
  book.textContent = plus ? (mine ? "✓ Booked" : "✦ Book · 15 min") : "🔒 Book";
  document.getElementById("premiumStateBadge").textContent = plus ? "Unlocked" : "Locked";
  document.getElementById("premiumDescription").textContent = plus ? "Reserve a reported space or find nearby parking." : "Unlock booking and nearest-parking navigation.";
  document.getElementById("popupPlusBenefits").hidden = plus;
  book.disabled = !plus || !bookingEnabled() || !!active || !!mySession || !zone.verified || zone.capacity - zone.occupied - (zone.reserved||0) <= 0;
  hint.textContent = !plus ? "" :
    !bookingEnabled() ? "Connecting to Firebase…" :
    "Bookings hold one reported space for 15 minutes.";
  const panel=document.getElementById("bookingPanel");
  panel.hidden = !mine;
  if(mine) {
    const remaining=Math.max(0,mine.expiresAt-Date.now());
    document.getElementById("bookingCountdown").textContent = `${String(Math.floor(remaining/60000)).padStart(2,"0")}:${String(Math.floor((remaining%60000)/1000)).padStart(2,"0")}`;
    document.getElementById("bookingHeading").textContent = "⭐ Booking active";
    document.getElementById("bookingMessage").textContent = "One space is held in Firebase. Check in using GPS before the 15-minute expiry.";

  }
}
function openNearestPanel() {
  if(!plusEnabled()) return;
  closeModal();
  const nav=document.getElementById("plusNavButton");
  nav.click();
  document.getElementById("plusLocate").click();
}
function updatePlus() {
  document.body.classList.toggle("spotit-plus",plusEnabled());
  renderMembershipTab();
  document.getElementById("freeAd").hidden=plusEnabled();
  document.dispatchEvent(new Event("spotit-plus-change"));
  recompute();
}

function renderModal(zoneId) {
  const liveZone = currentZones[zoneId];
  if (!liveZone) return;
  const zone = liveZone;
  const displayZone = displayedZone(liveZone);
  document.getElementById("modalZoneName").textContent = zone.name;
  document.getElementById("modalStatus").textContent =
    displayZone.status[0].toUpperCase() + displayZone.status.slice(1);
  document.getElementById("modalCapacity").textContent =
    displayZone.verified ? `${Math.max(0, displayZone.capacity - displayZone.occupied - (displayZone.reserved || 0))} of ${displayZone.capacity} spaces available (reported)` : "Parking capacity not yet verified";
  document.getElementById("modalUpdated").textContent = displayZone.presentation ? "Presentation sample · not live occupancy" : (displayZone.verified ? freshnessText(displayZone) : "Awaiting administrator verification");
  // Duration details are requested only after an outside-zone confirmation.
  document.getElementById("parkingDurationPanel").hidden = !(showParkingDetails && mySession?.zoneId === zone.id);
  renderParkingReminder();
  // Test button is available only for the signed-in user's active parking session.
  document.getElementById("reminderDemoControls").hidden = !(mySession && mySession.zoneId === zone.id);
  if (!mySession || mySession.zoneId !== zone.id) {
    document.getElementById("demoReminderPanel").hidden = true;
  }

  document.getElementById("statusCard").className = `status-card status-${displayZone.status}`;
  document.getElementById("statusIcon").innerHTML =
    displayZone.status === "full" ? CROSS_ICON : CHECK_ICON;

  renderPlusActions(zone);
  const btnParked = document.getElementById("btnParked");
  const btnLeft = document.getElementById("btnLeft");
  const hintEl = document.querySelector(".hint");

  if (!myUid) {
    btnParked.disabled = true;
    btnLeft.disabled = true;
    hintEl.textContent = "Connecting…";
  } else if (mySession && mySession.zoneId === zone.id) {
    btnParked.disabled = true;
    btnLeft.disabled = false;
    hintEl.textContent = "You're marked as parked here. Tap \"I just left\" when you go.";
  } else if (mySession) {
    btnParked.disabled = true;
    btnLeft.disabled = true;
    const otherName = currentZones[mySession.zoneId]?.name || "another village";
    hintEl.textContent = `You're already marked as parked at ${otherName}. Tap "I just left" there first.`;
  } else {
    btnParked.disabled = !zone.verified || zone.capacity <= 0 || zone.occupied + (zone.reserved || 0) >= zone.capacity && !bookingForZone(zone.id);
    btnLeft.disabled = true;
    hintEl.textContent = zone.verified ? `GPS check required (within ${getZoneCheckinRadius(zone)} m). GPS confirms phone proximity, not vehicle occupancy.` : "Administrator must verify capacity and coordinates before reports are enabled.";
  }
}

// Update 15: GPS is checked only while SpotIt is open. Phone departure
// NEVER means vehicle departure; users must explicitly confirm check-out.
let reminderShownFor = null;
let showParkingDetails = false;
let gpsCheckedFor = null;
let gpsCheckInProgress = false;

function reminderDue(session) {
  if (!session) return false;
  const last = session.confirmedAt ?? session.startedAt;
  const interval = PARKING_TYPES[session.duration]?.reminderMs ?? SESSION_TTL_MS;
  const dueAt = session.expectedDeparture ? session.expectedDeparture.getTime() : last.getTime() + interval;
  return Date.now() >= dueAt;
}
function reminderCooling(session) {
  return Boolean(session?.remindedAt && Date.now() - session.remindedAt.getTime() < REMINDER_COOLDOWN_MS);
}
function renderParkingReminder() {
  const panel = document.getElementById("parkingReminder");
  if (!panel) return;
  panel.hidden = !(mySession && selectedZoneId === mySession.zoneId && reminderShownFor === mySession.uid);
  if (!panel.hidden) {
    document.getElementById("parkingReminderText").textContent =
      "Your phone appears outside the parking zone, or your expected departure/confirmation is due. Is your CAR still parked here? Your phone's location does not prove your car has left.";
  }
}
async function promptParkingConfirmation() {
  if (!mySession || reminderCooling(mySession) || document.visibilityState !== "visible") return;
  const sessionId = mySession.uid;
  reminderShownFor = sessionId;
  showParkingDetails = false;
  if (selectedZoneId !== mySession.zoneId) openModal(mySession.zoneId);
  else renderModal(mySession.zoneId);
  try { await recordReminder(); } catch (err) { console.warn("Reminder timestamp could not be saved", err); }
}
async function checkOutsideOnOpen() {
  if (!mySession || document.visibilityState !== "visible" || gpsCheckInProgress) return;
  if (reminderDue(mySession)) { await promptParkingConfirmation(); return; }
  // A future expected departure suppresses routine outside-zone prompts.
  if (mySession.expectedDeparture && mySession.expectedDeparture.getTime() > Date.now()) return;
  if (reminderCooling(mySession)) return;
  const zone = currentZones[mySession.zoneId];
  if (!zone || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lng)) return;
  const key = mySession.uid + ':' + mySession.startedAt.getTime();
  if (gpsCheckedFor === key) return;
  gpsCheckedFor = key;
  if (!window.isSecureContext || !navigator.geolocation) return;
  // Do not surprise the user with a browser permission dialog on each visit.
  // If permission is not already granted, the manual GPS button remains available.
  try {
    if (!navigator.permissions?.query) return;
    const permission = await navigator.permissions.query({name:"geolocation"});
    if (permission.state !== "granted") return;
  } catch { return; }
  gpsCheckInProgress = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    gpsCheckInProgress = false;
    if (!mySession || mySession.uid !== key.split(':')[0]) return;
    const distance = distanceMeters(pos.coords.latitude,pos.coords.longitude,zone.lat,zone.lng);
    // Subtract uncertainty: only prompt if phone is clearly outside the zone.
    if (distance - pos.coords.accuracy > getZoneCheckinRadius(zone)) await promptParkingConfirmation();
  }, () => {gpsCheckInProgress = false;}, {enableHighAccuracy:true,timeout:15000,maximumAge:0});
}
function showDueReminder() {
  if (!mySession) { reminderShownFor=null; showParkingDetails=false; return; }
  if (reminderDue(mySession) && !reminderCooling(mySession)) {
    promptParkingConfirmation().catch(console.warn);
  } else if (!reminderDue(mySession)) {
    checkOutsideOnOpen().catch(console.warn);
  }
}
document.getElementById("confirmStillParked").addEventListener("click",()=>{
  if (!mySession) return;
  document.getElementById("parkingReminder").hidden=true;
  showParkingDetails=true;
  document.getElementById("parkingDuration").value=PARKING_TYPES[mySession.duration] ? mySession.duration : "day";
  document.getElementById("expectedDeparture").value=mySession.expectedDeparture ? new Date(mySession.expectedDeparture.getTime()-mySession.expectedDeparture.getTimezoneOffset()*60000).toISOString().slice(0,16) : "";
  document.getElementById("parkingDetailsMessage").textContent="";
  renderModal(mySession.zoneId);
});
document.getElementById("saveParkingDetails").addEventListener("click",async()=>{
  if (!mySession) return;
  const msg=document.getElementById("parkingDetailsMessage");
  const duration=document.getElementById("parkingDuration").value;
  const value=document.getElementById("expectedDeparture").value;
  const expected=value ? new Date(value).getTime() : null;
  if (value && (!Number.isFinite(expected) || expected <= Date.now())) {msg.textContent="Choose a future departure date/time.";return;}
  const button=document.getElementById("saveParkingDetails");button.disabled=true;
  try {
    await confirmStillParked(duration,expected);
    showParkingDetails=false;reminderShownFor=null;gpsCheckedFor=null;
    document.getElementById("parkingDurationPanel").hidden=true;
  } catch(err) {msg.textContent="Could not save: "+err.message;}
  finally {button.disabled=false;}
});
document.getElementById("confirmLeft").addEventListener("click",async()=>{
  if (!mySession) return;
  try { await endSession(mySession.zoneId); reminderShownFor=null;showParkingDetails=false;document.getElementById("parkingReminder").hidden=true; }
  catch(err) { document.getElementById("departureGpsResult").textContent=err.message; }
});
document.getElementById("checkDepartureGps").addEventListener("click",()=>{
  const zone=currentZones[mySession?.zoneId],out=document.getElementById("departureGpsResult");
  if (!zone || !navigator.geolocation || !window.isSecureContext) {out.textContent="GPS requires HTTPS or localhost.";return;}
  out.textContent="Checking phone location (this does not check out your car)…";
  navigator.geolocation.getCurrentPosition(pos=>{
    const distance=distanceMeters(pos.coords.latitude,pos.coords.longitude,zone.lat,zone.lng);
    const outside=distance-pos.coords.accuracy>getZoneCheckinRadius(zone);
    out.textContent=outside?`Your phone appears outside this zone (about ${Math.round(distance)} m away, ±${Math.round(pos.coords.accuracy)} m). Is your CAR still parked?`:`Your phone is near the zone or GPS is inconclusive. Confirm whether your CAR is still parked.`;
  },()=>{out.textContent="Location unavailable. You can still confirm whether your car remains parked.";},{enableHighAccuracy:true,timeout:15000,maximumAge:0});
});

// ---- Presentation-only departure reminder preview ----
// No Firebase writes, GPS overrides, session expiry changes, or timer changes.
const demoPanel = document.getElementById("demoReminderPanel");
const demoDetails = document.getElementById("demoDetailsPanel");
const demoFeedback = document.getElementById("demoReminderFeedback");
document.getElementById("testDepartureReminder").addEventListener("click", () => {
  if (!mySession || selectedZoneId !== mySession.zoneId) return;
  demoPanel.hidden = false;
  demoDetails.hidden = true;
  demoFeedback.textContent = "Preview only — your actual parking session is unchanged.";
  document.getElementById("demoDuration").value = PARKING_TYPES[mySession.duration] ? mySession.duration : "day";
  document.getElementById("demoDeparture").value = "";
});
document.getElementById("demoStillParked").addEventListener("click", () => {
  demoDetails.hidden = false;
  demoFeedback.textContent = "Demo: car still parked. Enter an expected departure to preview the confirmation form.";
});
document.getElementById("demoLeft").addEventListener("click", () => {
  demoDetails.hidden = true;
  demoFeedback.textContent = "Demo: parking session would end and occupancy would update. No Firebase data was changed.";
});
document.getElementById("demoSaveDetails").addEventListener("click", () => {
  const date = document.getElementById("demoDeparture").value;
  const parsed = date ? new Date(date).getTime() : null;
  if (date && (!Number.isFinite(parsed) || parsed <= Date.now())) {
    demoFeedback.textContent = "Choose a future expected departure date/time, or leave it blank.";
    return;
  }
  demoDetails.hidden = true;
  const duration = document.getElementById("demoDuration").selectedOptions[0].textContent;
  demoFeedback.textContent = `Demo confirmed: ${duration}${date ? ` · expected departure ${new Date(parsed).toLocaleString()}` : ""}. In the real workflow, the session confirmation and freshness timestamp would update. Firebase was not changed.`;
});
document.getElementById("demoCloseReminder").addEventListener("click", () => {
  demoPanel.hidden = true;
  demoDetails.hidden = true;
});

// ---- Report actions ----
async function reportParked() {
  const zoneId = selectedZoneId;
  const zone = currentZones[zoneId];
  if (!zone || !zone.verified || zone.capacity <= 0 || mySession || zone.occupied + (zone.reserved || 0) >= zone.capacity && !bookingForZone(zone.id)) return;
  const button = document.getElementById("btnParked");
  const hintEl = document.querySelector(".hint");
  button.disabled = true;
  clearUserGpsPreview();
  hintEl.textContent = "Checking your GPS location…";
  showGpsStatus("checking", "Checking location", "Allow location access in your browser. GPS is checked once when you press the button.");
  try {
    const gpsResult = await verifyParkingProximity(zone);
    showUserGpsPreview(gpsResult);
    if (selectedZoneId !== zoneId) return;
    if (GPS_DEMO_MODE) {
      throw new Error("GPS simulation mode is enabled. Disable GPS_DEMO_MODE in gps-checkin.js to submit a real parking report.");
    }
    // Re-check after the asynchronous GPS request; the zone or session may have changed.
    const latest = currentZones[zoneId];
    if (!latest || !latest.verified || latest.capacity <= 0 || latest.occupied + (latest.reserved || 0) >= latest.capacity && !bookingForZone(zoneId) || mySession) {
      throw new Error("Parking availability changed. Please review the zone and retry.");
    }
    showGpsStatus("success", "Reported location inside radius", `Estimated distance ${Math.round(gpsResult.distance)} m (radius ${gpsResult.radius} m; accuracy ±${Math.round(gpsResult.accuracy)} m). Check-in allowed using the browser-reported position. This does not prove your car is parked here.`, gpsResult);
    hintEl.textContent = "Reported location is inside the parking radius. Saving your parking report…";
    // Check-in is immediate. Duration is requested only if the user later
    // confirms their car remains parked while their phone is outside the zone.
    await startSession(zoneId);
    // After successful GPS check-in, release this user's booking.
    if(bookingForZone(zoneId)) cancelBooking().catch(e=>console.warn("Booking cleanup failed",e));
    // the live listener updates the UI
  } catch (err) {
    console.error(err);
    if (selectedZoneId === zoneId) {
      showUserGpsPreview(err.gpsResult);
      showGpsStatus(err.gpsResult?.verification === "uncertain" ? "uncertain" : "error",
        err.gpsResult?.verification === "uncertain" ? "GPS location uncertain" : "Check-in not completed",
        err.message || "Unable to check your location or submit the report. Please retry.", err.gpsResult);
      renderModal(zoneId);
      if (err.gpsResult) showGpsStatus(err.gpsResult.verification === "uncertain" ? "uncertain" : "error", err.gpsResult.verification === "uncertain" ? "GPS location uncertain" : "Check-in not completed", err.message, err.gpsResult);
    }
  }
}

async function reportLeft() {
  const zone = currentZones[selectedZoneId];
  if (!zone || !mySession || mySession.zoneId !== zone.id) return;
  document.getElementById("btnLeft").disabled = true;
  try {
    await endSession(zone.id);
  } catch (err) {
    console.error(err);
    alert("Couldn't send your report. Check your connection and try again.");
    renderModal(zone.id);
  }
}

// ---- UI events ----
document.getElementById("popupPlusBenefits").addEventListener("click", () => {
  closeModal();
  const membershipTab = document.querySelector('.nav-btn[data-tab="tabList"]');
  if (membershipTab) membershipTab.click();
});
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});
document.getElementById("btnBookParking").addEventListener("click",async()=>{
  const zone=currentZones[selectedZoneId];if(!zone || !plusEnabled()) return;
  const btn=document.getElementById("btnBookParking");btn.disabled=true;
  try {await createBooking(zone.id,zone);recompute();}
  catch(e){alert("Booking not completed: "+e.message);renderModal(zone.id);}
});
document.getElementById("cancelBooking").addEventListener("click",async()=>{
  try {await cancelBooking();recompute();}catch(e){alert("Cannot cancel booking: "+e.message);}
});

document.getElementById("btnNearestParking").addEventListener("click",openNearestPanel);
document.getElementById("btnParked").addEventListener("click", reportParked);
document.getElementById("btnLeft").addEventListener("click", reportLeft);

// ---- Role-aware mobile membership and parking list ----
const isEmbeddedAdmin = new URLSearchParams(location.search).get("adminView") === "1";
let browsingZones = false;
function renderMembershipTab() {
  const isPlus = plusEnabled();
  const isMemberPage = !isEmbeddedAdmin;
  const nav = document.querySelector('.nav-btn[data-tab="tabList"]');
  if (nav) {
    nav.dataset.label = isMemberPage ? "Membership" : "List";
    nav.title = isMemberPage ? "Membership" : "Parking list";
  }
  const icon = document.getElementById("listNavIcon");
  if (icon) icon.textContent = isMemberPage ? "♛" : "☰";
  document.getElementById("membershipView").hidden = !isMemberPage || browsingZones;
  document.getElementById("zoneListSection").hidden = isMemberPage && !browsingZones;
  document.getElementById("membershipFree").hidden = !isMemberPage || isPlus;
  document.getElementById("membershipPlus").hidden = !isMemberPage || !isPlus;
  document.getElementById("membershipBack").hidden = !isMemberPage;
  if (nav?.classList.contains("active")) document.getElementById("pageTitle").textContent = browsingZones || !isMemberPage ? "List" : "Membership";
}
function changeMembershipMode(toPlus) {
  if (toPlus) sessionStorage.setItem("spotitPlusPreview", "1");
  else sessionStorage.removeItem("spotitPlusPreview");
  // The Plus booking module reads role on load. Reload to synchronize all controls.
  window.location.reload();
}
document.getElementById("membershipSubscribe").addEventListener("click", () => {
  if (window.confirm("Activate SpotIt Plus for this prototype? No payment will be charged.")) changeMembershipMode(true);
});
document.getElementById("membershipManage").addEventListener("click", () => {
  if (window.confirm("Switch to the Free experience? Any existing booking remains in Firebase until cancelled or expired.")) changeMembershipMode(false);
});
document.getElementById("membershipBrowse").addEventListener("click", () => { browsingZones = true; renderMembershipTab(); });
document.getElementById("membershipBack").addEventListener("click", () => { browsingZones = false; renderMembershipTab(); });
renderMembershipTab();

// About tab: keep the administrator view unchanged; show role-aware membership CTA.
const userAboutView = document.getElementById("userAboutView");
const adminAboutLegacy = document.getElementById("adminAboutLegacy");
userAboutView.hidden = isEmbeddedAdmin;
adminAboutLegacy.hidden = !isEmbeddedAdmin;
const aboutMembershipAction = document.getElementById("aboutMembershipAction");
aboutMembershipAction.textContent = plusEnabled() ? "Manage SpotIt Plus  →" : "Explore SpotIt Plus  →";
aboutMembershipAction.addEventListener("click", () => {
  const membershipTab = document.querySelector('.nav-btn[data-tab="tabList"]');
  if (membershipTab) membershipTab.click();
});

// ---- Bottom nav tab switching ----
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".overlay-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");

    if (btn.dataset.tab === "tabList") { browsingZones = false; renderMembershipTab(); }
    const isMapTab = btn.dataset.tab === "tabMap";
    document.querySelector(".phone").classList.toggle("map-page", isMapTab);
    if (!isMapTab) mapLocationMessage.hidden = true;
    document.getElementById("pageTitle").textContent = btn.dataset.label;
    document.getElementById("legendFloat").style.display =
      isMapTab ? "flex" : "none";
    document.getElementById("map").style.display = isMapTab ? "block" : "none";

    if (!isMapTab) {
      document.getElementById(btn.dataset.tab).hidden = false;
    } else if (map) {
      setTimeout(() => map.invalidateSize(), 50);
    }
  });
});

// ---- Start: sign in anonymously, then listen to zones + sessions ----
async function start() {
  
  try {
    myUid = await ensureSignedIn();
  } catch (err) {
    console.error("Sign-in failed. Is Anonymous sign-in enabled in Firebase Authentication?", err);
    alert("Couldn't connect to SpotIt. Please try again later.");
    return;
  }
  initializePlusNearby({ getZones: () => currentZones, openZone: openModal });
  initPlusBooking(updatePlus);
  updatePlus();
  listenToZones();
  listenToSessions((list) => {
    sessionsList = list;
    recompute();
    showDueReminder();
  });
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")showDueReminder();});
  // Re-evaluate every 30 s so "Updated X mins ago", stale flags and
  // session expiry stay correct even when nothing changes in the database.
  setInterval(()=>{recompute();showDueReminder();}, 30000);
}
start();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
