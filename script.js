import { db } from "./firebase-config.js";
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
  summarise,
  SESSION_TTL_MS,
} from "./sessions.js";

// Used only if a zone document has no "capacity" field.
// Set the real capacity per zone in Firestore (zones/v2/capacity, etc.).
const DEFAULT_CAPACITY = 20;

let map;
let markers = {};
let zonesData = {};     // static zone info from Firestore
let sessionsList = [];  // live sessions from Firestore
let currentZones = {};  // zones + computed occupancy/status
let selectedZoneId = null;
let myUid = null;
let mySession = null;   // this user's active (non-expired) session, if any

// ---- Leaflet map init (OpenStreetMap tiles, free, no API key) ----
function initMap() {
  map = L.map("map").setView([4.3870, 100.9660], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
}
initMap();

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
  if (occupied >= capacity) return "full";
  if (occupied >= capacity * 0.7) return "limited";
  return "available";
}

function markerColor(status) {
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
  if (zone.stale) return "⚠ Some reports may be outdated";
  return timeAgo(zone.lastUpdated);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- Firestore: zone info (static) ----
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
        capacity: d.capacity ?? DEFAULT_CAPACITY,
      };
    });
    recompute();
  });
}

// ---- Combine zones + sessions into what the UI shows ----
function recompute() {
  const { byZone, mine } = summarise(sessionsList, myUid);
  mySession = mine;

  // If my own session has expired, quietly clear it so I can report again.
  const raw = sessionsList.find((s) => s.uid === myUid);
  if (raw && !mine && Date.now() - raw.startedAt.getTime() > SESSION_TTL_MS) {
    removeExpiredSession().catch(() => {});
  }

  currentZones = {};
  Object.entries(zonesData).forEach(([id, z]) => {
    const info = byZone[id] || { occupied: 0, newest: null, stale: false };
    currentZones[id] = {
      id,
      name: z.name,
      lat: z.lat,
      lng: z.lng,
      capacity: z.capacity,
      occupied: info.occupied,
      status: statusFor(info.occupied, z.capacity),
      lastUpdated: info.newest,
      stale: info.stale,
    };
  });

  renderMarkers();
  renderZoneList();
  if (selectedZoneId) renderModal(selectedZoneId);
}

// ---- Render markers on the map ----
function renderMarkers() {
  Object.values(currentZones).forEach((zone) => {
    const color = markerColor(zone.status);
    const dash = zone.stale ? "4 3" : null; // dashed border = possibly outdated
    if (markers[zone.id]) {
      markers[zone.id].setStyle({ fillColor: color, dashArray: dash });
    } else {
      const marker = L.circleMarker([zone.lat, zone.lng], {
        radius: 10,
        fillColor: color,
        color: "#fff",
        weight: 2,
        fillOpacity: 1,
        dashArray: dash,
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
          <div class="zone-name">${escapeHtml(zone.name)}</div>
          <div class="zone-sub">${escapeHtml(freshnessText(zone).replace("Updated ", ""))}</div>
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

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>`;
const CROSS_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;

function renderModal(zoneId) {
  const zone = currentZones[zoneId];
  if (!zone) return;
  document.getElementById("modalZoneName").textContent = zone.name;
  document.getElementById("modalStatus").textContent =
    zone.status[0].toUpperCase() + zone.status.slice(1);
  document.getElementById("modalCapacity").textContent =
    `${zone.occupied} / ${zone.capacity} spots taken (reported)`;
  document.getElementById("modalUpdated").textContent = freshnessText(zone);

  document.getElementById("statusCard").className = `status-card status-${zone.status}`;
  document.getElementById("statusIcon").innerHTML =
    zone.status === "full" ? CROSS_ICON : CHECK_ICON;

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
    btnParked.disabled = zone.occupied >= zone.capacity;
    btnLeft.disabled = true;
    hintEl.textContent = "Reports expire automatically after 4 hours.";
  }
}

// ---- Report actions ----
async function reportParked() {
  const zone = currentZones[selectedZoneId];
  if (!zone || mySession || zone.occupied >= zone.capacity) return;
  document.getElementById("btnParked").disabled = true;
  try {
    await startSession(zone.id);
    // the live listener updates the UI
  } catch (err) {
    console.error(err);
    alert("Couldn't send your report. Check your connection and try again.");
    renderModal(zone.id);
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
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});
document.getElementById("btnParked").addEventListener("click", reportParked);
document.getElementById("btnLeft").addEventListener("click", reportLeft);

// ---- Bottom nav tab switching ----
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".overlay-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");

    const isMapTab = btn.dataset.tab === "tabMap";
    document.querySelector(".phone").classList.toggle("map-page", isMapTab);
    document.getElementById("pageTitle").textContent = btn.dataset.label;
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

// ---- Start: sign in anonymously, then listen to zones + sessions ----
async function start() {
  try {
    myUid = await ensureSignedIn();
  } catch (err) {
    console.error("Sign-in failed. Is Anonymous sign-in enabled in Firebase Authentication?", err);
    alert("Couldn't connect to SpotIt. Please try again later.");
    return;
  }
  listenToZones();
  listenToSessions((list) => {
    sessionsList = list;
    recompute();
  });
  // Re-evaluate every 30 s so "Updated X mins ago", stale flags and
  // session expiry stay correct even when nothing changes in the database.
  setInterval(recompute, 30000);
}
start();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
