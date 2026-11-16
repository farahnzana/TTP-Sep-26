// SpotIt Plus: read-only nearby parking recommendations.
// Subscription is verified from Firestore before displaying premium navigation.
// This is client-side UI gating; production enforcement also requires server-side rules.
import { plusEnabled } from "./plus-booking.js";


import { distanceMeters } from "./gps-checkin.js";

export function initializePlusNearby({ getZones, openZone }) {
  const nav = document.getElementById("plusNavButton");
  const locate = document.getElementById("plusLocate");
  const feedback = document.getElementById("plusFeedback");
  const results = document.getElementById("plusResults");
  nav.hidden = false;
  function refreshGate() {
    nav.disabled = !plusEnabled();
    nav.title = plusEnabled() ? "SpotIt Plus: find nearest parking" : "SpotIt Plus only";
    nav.classList.toggle("plus-locked",!plusEnabled());
    locate.disabled = !plusEnabled();
  }
  refreshGate();
  document.addEventListener("spotit-plus-change", refreshGate);

  locate.addEventListener("click", () => {
    if (!plusEnabled()) {
      feedback.textContent = "An active SpotIt Plus subscription is required.";
      return;
    }
    if (!window.isSecureContext || !navigator.geolocation) {
      feedback.textContent = "Location requires HTTPS or localhost with browser location permission.";
      return;
    }
    locate.disabled = true;
    feedback.textContent = "Finding your current location…";
    navigator.geolocation.getCurrentPosition(position => {
      locate.disabled = false;
      if (!plusEnabled()) return;
      const { latitude, longitude, accuracy } = position.coords;
      if (![latitude, longitude, accuracy].every(Number.isFinite)) {
        feedback.textContent = "Invalid location reading. Please try again.";
        return;
      }
      feedback.textContent = `Location accuracy ±${Math.round(accuracy)} m. Results sorted by estimated straight-line distance.`;
      results.replaceChildren();
      const zones = Object.values(getZones()).filter(z => z.verified && Number.isFinite(z.lat) && Number.isFinite(z.lng) && z.capacity - z.occupied - (z.reserved || 0) > 0)
        .map(z => ({ ...z, distance: distanceMeters(latitude, longitude, z.lat, z.lng) }))
        .sort((a, b) => a.distance - b.distance);
      if (!zones.length) {
        results.textContent = "No verified parking zones with coordinates are available yet.";
        return;
      }
      for (const z of zones) {
        const card = document.createElement("article");
        card.className = "plus-result";
        const top = document.createElement("div");
        top.className = "plus-result-top";
        const heading = document.createElement("h3");
        heading.textContent = z.name;
        const status = document.createElement("span");
        status.className = `badge ${z.status}`;
        status.textContent = z.status === "full" ? "Full" : z.status === "limited" ? "Limited" : "Available";
        top.append(heading, status);
        const description = document.createElement("p");
        description.textContent = `${Math.round(z.distance)} m away · ${Math.max(0, z.capacity - z.occupied - (z.reserved || 0))} of ${z.capacity} reported spaces available`;
        const actions = document.createElement("div");
        actions.className = "plus-actions";
        const view = document.createElement("button");
        view.type = "button";
        view.textContent = "View parking";
        view.addEventListener("click", () => openZone(z.id));
        const directions = document.createElement("a");
        directions.textContent = "Directions ↗";
        directions.target = "_blank";
        directions.rel = "noopener noreferrer";
        directions.href = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${latitude}%2C${longitude}%3B${z.lat}%2C${z.lng}`;
        actions.append(view, directions);
        card.append(top, description, actions);
        results.append(card);
      }
    }, error => {
      locate.disabled = false;
      feedback.textContent = error.code === 1 ? "Location permission denied. Enable location permission and retry." : "Unable to determine location. Try outdoors or on your phone.";
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
