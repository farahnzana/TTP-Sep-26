// SpotIt GPS proximity check. Location is used in memory only and is not uploaded.
export const CHECKIN_RADIUS_METERS = 150; // Default for zones without a configured radius.
export const MIN_CHECKIN_RADIUS_METERS = 10;
export const MAX_CHECKIN_RADIUS_METERS = 300;

export function getZoneCheckinRadius(zone) {
  const configured = zone?.radius;
  if (configured === null || configured === undefined || configured === '') return CHECKIN_RADIUS_METERS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= MIN_CHECKIN_RADIUS_METERS && value <= MAX_CHECKIN_RADIUS_METERS
    ? value : CHECKIN_RADIUS_METERS;
}
export const MAX_ACCURACY_METERS = 200;
export const GPS_TIMEOUT_MS = 15000;
// Development only: set true locally to simulate a check-in with a 200 m radius.
// Demo mode NEVER writes a parking session to Firebase.
export const GPS_DEMO_MODE = false;
export const DEMO_RADIUS_METERS = 200;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function verifyParkingProximity(zone) {
  if (!Number.isFinite(zone?.lat) || !Number.isFinite(zone?.lng)) {
    throw new Error('This parking zone has no verified GPS coordinates. Please contact an administrator.');
  }
  if (!window.isSecureContext || !navigator.geolocation) {
    throw new Error('GPS requires HTTPS or localhost and a browser with location support.');
  }
  const position = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: GPS_TIMEOUT_MS,
      maximumAge: 0,
    });
  }).catch((error) => {
    if (error.code === 1) throw new Error('Location permission denied. Enable location access and try again.');
    if (error.code === 2) throw new Error('Your location is unavailable. Check GPS and try again.');
    if (error.code === 3) throw new Error('GPS timed out. Move outdoors and try again.');
    throw error;
  });
  const { latitude, longitude, accuracy } = position.coords;
  if (![latitude, longitude, accuracy].every(Number.isFinite)) {
    throw new Error('Invalid GPS reading. Please try again.');
  }
  const distance = distanceMeters(latitude, longitude, zone.lat, zone.lng);
  const details = `Estimated distance: ${Math.round(distance)} m from ${zone.name || 'selected parking zone'} (location accuracy ±${Math.round(accuracy)} m).`;
  const radius = GPS_DEMO_MODE ? DEMO_RADIUS_METERS : getZoneCheckinRadius(zone);
  const result = { distance, accuracy, radius, demo: GPS_DEMO_MODE,
    latitude, longitude,
    // Prototype proximity rule: the browser-reported point must fall within the
    // zone circle, and its reported uncertainty must not exceed the quality cap.
    // This is NOT proof the car is present or that the actual position is inside.
    verification: distance <= radius && accuracy <= MAX_ACCURACY_METERS
      ? "verified" : distance - accuracy > radius ? "outside" : "uncertain" };
  if (result.verification !== "verified") {
    const error = new Error(result.verification === "outside"
      ? `${details} Your estimated GPS accuracy area is outside the ${radius} m parking zone. Move closer and retry.`
      : `${details} Your reported location cannot be accepted within the ${radius} m zone under the current location-quality limit. ${accuracy > MAX_ACCURACY_METERS ? `Accuracy exceeds ±${MAX_ACCURACY_METERS} m. ` : ""}Try again with location services enabled. Laptop location may be approximate.`);
    error.gpsResult = result;
    throw error;
  }
  return result;
}
