import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ---- Demo scope: Villages 2, 3, 4, 5 only, capped at 20 spots each ----
const CAPACITY = 20;

// Seed data — used only if you haven't created these docs in Firestore yet.
// See README.md for how to seed them for real.
const SEED_ZONES = [
  { id: "v2", zone_name: "Village 2", lat: 4.3877326, lng: 100.9678099 }, // Village 2 Cafe
  { id: "v3", zone_name: "Village 3", lat: 4.3869444, lng: 100.9655556 }, // Village 3 Cafe
  { id: "v4", zone_name: "Village 4", lat: 4.3883417, lng: 100.9655226 }, // Village 4 Cafe
  { id: "v5", zone_name: "Village 5", lat: 4.3860593, lng: 100.9637785 }, // Village 5 Cafe
];

let map;
let markers = {};
let currentZones = {};
let selectedZoneId = null;

// ---- Track which zone THIS device/browser says it's parked at ----
// Prevents one user from reporting "parked" in multiple zones at once.
const MY_ZONE_KEY = "myParkedZoneId";
function getMyParkedZone() {
  return localStorage.getItem(MY_ZONE_KEY);
}
function setMyParkedZone(zoneId) {
  if (zoneId) localStorage.setItem(MY_ZONE_KEY, zoneId);
  else localStorage.removeItem(MY_ZONE_KEY);
}

// ---- Leaflet map init (OpenStreetMap tiles, free, no API key) ----
function initMap() {
  map = L.map("map").setView([4.3870, 100.9660], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  listenToZones();
}
initMap();

// ---- Splash screen: show briefly, then fade into the app ----
window.addEventListener("load", () => {
  setTimeout(() => {
    const splash = document.getElementById("splash");
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 400); // matches the CSS transition time
  }, 1200);
});

// ---- Status derivation from occupied/capacity ----
function statusFor(occupied) {
  if (occupied >= CAPACITY) return "full";
  if (occupied >= CAPACITY * 0.7) return "limited"; // 14+/20
  return "available";
}

function markerColor(status) {
  if (status === "full") return "#e74c3c";
  if (status === "limited") return "#f39c12";
  return "#2ecc71";
}

function timeAgo(date) {
  if (!date) return "No reports yet";
  const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "Updated just now";
  if (diffMin === 1) return "Updated 1 min ago";
  return `Updated ${diffMin} mins ago`;
}

// ---- Firestore live listener ----
function listenToZones() {
  const zonesRef = collection(db, "zones");
  onSnapshot(zonesRef, (snapshot) => {
    if (snapshot.empty) {
      console.warn("No zones found in Firestore — seed them first (see README.md).");
      return;
    }
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const occupied = data.occupied ?? 0;
      const status = statusFor(occupied);
      currentZones[docSnap.id] = {
        id: docSnap.id,
        name: data.zone_name,
        lat: data.latitude,
        lng: data.longitude,
        occupied,
        capacity: data.capacity ?? CAPACITY,
        status,
        lastUpdated: data.last_updated?.toDate?.() || null,
      };
    });
    renderMarkers();
    renderZoneList();
    if (selectedZoneId) renderModal(selectedZoneId);
  });
}

// ---- Render markers on the map (Leaflet circle markers) ----
function renderMarkers() {
  Object.values(currentZones).forEach((zone) => {
    const color = markerColor(zone.status);
    if (markers[zone.id]) {
      markers[zone.id].setStyle({ fillColor: color, color: color });
    } else {
      const marker = L.circleMarker([zone.lat, zone.lng], {
        radius: 10,
        fillColor: color,
        color: "#fff",
        weight: 2,
        fillOpacity: 1,
      }).addTo(map);
      marker.bindTooltip(zone.name);
      marker.on("click", () => openModal(zone.id));
      markers[zone.id] = marker;
    }
  });
}

// ---- Render the zone list ----
function renderZoneList() {
  const container = document.getElementById("zoneList");
  container.querySelectorAll(".zone-card").forEach((el) => el.remove());

  Object.values(currentZones)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((zone) => {
      const card = document.createElement("div");
      card.className = "zone-card";
      card.innerHTML = `
        <div>
          <div class="zone-name">${zone.name}</div>
          <div class="zone-sub">${timeAgo(zone.lastUpdated).replace("Updated ", "")}</div>
        </div>
        <span class="badge ${zone.status}">${zone.status[0].toUpperCase() + zone.status.slice(1)}</span>
      `;
      card.addEventListener("click", () => openModal(zone.id));
      container.appendChild(card);
    });
}

// ---- Modal (zone detail) ----
function openModal(zoneId) {
  selectedZoneId = zoneId;
  renderModal(zoneId);
  document.getElementById("modalOverlay").classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  selectedZoneId = null;
}

// Icons for the status card: tick for available/limited, cross for full
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>`;
const CROSS_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;

function renderModal(zoneId) {
  const zone = currentZones[zoneId];
  if (!zone) return;
  document.getElementById("modalZoneName").textContent = zone.name;
  document.getElementById("modalStatus").textContent =
    zone.status[0].toUpperCase() + zone.status.slice(1);
  document.getElementById("modalCapacity").textContent =
    `${zone.occupied} / ${zone.capacity} spots taken`;
  document.getElementById("modalUpdated").textContent = timeAgo(zone.lastUpdated);

  // Status card colour + icon (check for available/limited, X for full)
  document.getElementById("statusCard").className = `status-card status-${zone.status}`;
  document.getElementById("statusIcon").innerHTML =
    zone.status === "full" ? CROSS_ICON : CHECK_ICON;

  const btnParked = document.getElementById("btnParked");
  const btnLeft = document.getElementById("btnLeft");
  const hintEl = document.querySelector(".hint");
  const myZone = getMyParkedZone();

  if (myZone === zone.id) {
    // This is the zone the user says they're parked in
    btnParked.disabled = true;
    btnLeft.disabled = zone.occupied <= 0;
    hintEl.textContent = "You're marked as parked here. Tap \"I just left\" when you go.";
  } else if (myZone) {
    // User is marked as parked somewhere else — block both actions here
    btnParked.disabled = true;
    btnLeft.disabled = true;
    const otherName = currentZones[myZone]?.name || "another village";
    hintEl.textContent = `You're already marked as parked at ${otherName}. Tap "I just left" there first.`;
  } else {
    // User isn't marked as parked anywhere — free to report parking here
    btnParked.disabled = zone.occupied >= zone.capacity;
    btnLeft.disabled = true; // can't "leave" a spot you haven't reported taking
    hintEl.textContent = "Each village is capped at 20 demo spots.";
  }
}

// ---- Report actions: increment/decrement occupied, capped at 0..20 ----
// Also enforces "one active parked report per user" via localStorage.
async function reportParked() {
  const zone = currentZones[selectedZoneId];
  if (!zone || zone.occupied >= zone.capacity) return;
  if (getMyParkedZone()) return; // already parked somewhere — guard, shouldn't reach here since button is disabled

  await updateDoc(doc(db, "zones", zone.id), {
    occupied: increment(1),
    last_updated: serverTimestamp(),
  });
  setMyParkedZone(zone.id);
  renderModal(zone.id);
}

async function reportLeft() {
  const zone = currentZones[selectedZoneId];
  if (!zone || zone.occupied <= 0) return;
  if (getMyParkedZone() !== zone.id) return; // can only leave the zone you reported parking in

  await updateDoc(doc(db, "zones", zone.id), {
    occupied: increment(-1),
    last_updated: serverTimestamp(),
  });
  setMyParkedZone(null);
  renderModal(zone.id);
}

// ---- Wire up UI events ----
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});
document.getElementById("btnParked").addEventListener("click", reportParked);
document.getElementById("btnLeft").addEventListener("click", reportLeft);

// ---- Bottom nav tab switching ----
// Map and legend only show on the Map tab; List/About hide the map and
// show the two-tone gradient background (set in style.css) behind them.
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".overlay-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");

    const isMapTab = btn.dataset.tab === "tabMap";
    // Turns the map-page-only styling (see bottom of style.css) on/off
    document.querySelector(".phone").classList.toggle("map-page", isMapTab);
    document.getElementById("pageTitle").textContent = btn.dataset.label;
    // Legend shows on Map and List, hidden on About
document.getElementById("legendFloat").style.display =
  btn.dataset.tab === "tabAbout" ? "none" : "flex";
    document.getElementById("map").style.display = isMapTab ? "block" : "none";

    if (!isMapTab) {
      document.getElementById(btn.dataset.tab).hidden = false;
    } else if (map) {
      setTimeout(() => map.invalidateSize(), 50);
    }
  });
});

// Expose seed data for the console seed script (see README.md)
window.SEED_ZONES = SEED_ZONES;
window.CAPACITY = CAPACITY;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");