(() => {
  interface TrackPoint {
    lat: number;
    lng: number;
    t: number;
    acc: number;
  }

  interface SavedTrack {
    points: TrackPoint[];
    activeMs: number;
  }

  const STORAGE_KEY = "urma:track";
  const MAX_ACCURACY_M = 50;
  const MIN_STEP_M = 4;

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
  };

  function haversine(a: TrackPoint, b: TrackPoint): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const fmtNum = (n: number, digits: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  const statusEl = $<HTMLParagraphElement>("status");
  const distEl = $<HTMLElement>("stat-dist");
  const timeEl = $<HTMLElement>("stat-time");
  const speedEl = $<HTMLElement>("stat-speed");
  const toggleBtn = $<HTMLButtonElement>("btn-toggle");
  const followBtn = $<HTMLButtonElement>("btn-follow");
  const gpxBtn = $<HTMLButtonElement>("btn-gpx");
  const resetBtn = $<HTMLButtonElement>("btn-reset");

  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  const map = L.map("map", { zoomControl: false }).setView([47.0105, 28.8638], 13);
  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  const trail = L.polyline([], { color: "#ff6b35", weight: 5, opacity: 0.9 }).addTo(map);
  const accuracyCircle = L.circle([0, 0], {
    radius: 0,
    weight: 1,
    color: "#0a84ff",
    fillColor: "#0a84ff",
    fillOpacity: 0.12,
  });
  const meIcon = L.divIcon({
    className: "",
    html: '<div class="me-dot" id="me-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  const marker = L.marker([0, 0], { icon: meIcon, interactive: false });
  let markerOnMap = false;

  let points: TrackPoint[] = [];
  let distanceM = 0;
  let activeMs = 0;
  let sessionStart = 0;
  let watchId: number | null = null;
  let timerId: number | undefined;
  let follow = true;
  let wakeLock: WakeLockSentinel | null = null;
  let lastSpeedKmh = 0;

  const isTracking = () => watchId !== null;

  function currentActiveMs(): number {
    return activeMs + (sessionStart ? Date.now() - sessionStart : 0);
  }

  function render(): void {
    distEl.textContent = `${fmtNum(distanceM / 1000, 2)} km`;
    timeEl.textContent = fmtDuration(currentActiveMs());
    speedEl.textContent = `${fmtNum(lastSpeedKmh, 1)} km/h`;
    toggleBtn.textContent = isTracking() ? "Stop" : points.length > 0 ? "Resume" : "Start";
    toggleBtn.classList.toggle("running", isTracking());
    gpxBtn.disabled = points.length < 2;
    resetBtn.disabled = points.length === 0 && !isTracking();
  }

  function save(): void {
    try {
      const data: SavedTrack = { points, activeMs: currentActiveMs() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as SavedTrack;
      points = Array.isArray(data.points) ? data.points : [];
      activeMs = Number(data.activeMs) || 0;
      distanceM = points.reduce((sum, p, i) => (i ? sum + haversine(points[i - 1], p) : 0), 0);
      trail.setLatLngs(points.map((p) => [p.lat, p.lng] as L.LatLngTuple));
      if (points.length > 1) map.fitBounds(trail.getBounds(), { padding: [40, 40] });
      else if (points.length === 1) map.setView([points[0].lat, points[0].lng], 16);
      if (points.length > 0) setStatus("Loaded your saved route.");
    } catch {}
  }

  function showMe(lat: number, lng: number, accuracy: number): void {
    const ll = L.latLng(lat, lng);
    if (!markerOnMap) {
      marker.addTo(map);
      accuracyCircle.addTo(map);
      markerOnMap = true;
    }
    marker.setLatLng(ll);
    accuracyCircle.setLatLng(ll).setRadius(accuracy);
  }

  function onPosition(pos: GeolocationPosition): void {
    const { latitude, longitude, accuracy, speed } = pos.coords;
    showMe(latitude, longitude, accuracy);

    if (follow) map.panTo([latitude, longitude]);

    if (accuracy > MAX_ACCURACY_M) {
      setStatus(`Weak signal (±${Math.round(accuracy)} m). Waiting for a more accurate position…`);
      return;
    }

    const point: TrackPoint = { lat: latitude, lng: longitude, t: pos.timestamp, acc: accuracy };
    const prev = points[points.length - 1];

    if (prev) {
      const step = haversine(prev, point);
      if (step < MIN_STEP_M) {
        lastSpeedKmh = 0;
        setStatus(`Tracking · accuracy ±${Math.round(accuracy)} m`);
        render();
        return;
      }
      distanceM += step;
      const dt = (point.t - prev.t) / 1000;
      lastSpeedKmh = speed != null && !Number.isNaN(speed) ? speed * 3.6 : dt > 0 ? (step / dt) * 3.6 : 0;
    }

    points.push(point);
    trail.addLatLng([latitude, longitude]);
    setStatus(`Tracking · accuracy ±${Math.round(accuracy)} m`);
    save();
    render();
  }

  function onError(err: GeolocationPositionError): void {
    const messages: Record<number, string> = {
      1: "Location permission was denied. Enable it in your browser settings.",
      2: "Your position can't be determined. Check your GPS or connection.",
      3: "Finding your position timed out. Trying again…",
    };
    setStatus(messages[err.code] ?? err.message, true);
    if (err.code === 1) stopTracking();
  }

  async function requestWakeLock(): Promise<void> {
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }

  async function releaseWakeLock(): Promise<void> {
    try {
      await wakeLock?.release();
    } catch {}
    wakeLock = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isTracking()) void requestWakeLock();
  });

  function startTracking(): void {
    if (!("geolocation" in navigator)) {
      setStatus("Your browser doesn't support geolocation.", true);
      return;
    }
    sessionStart = Date.now();
    setStatus("Finding your position…");
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });
    timerId = window.setInterval(render, 1000);
    document.getElementById("me-dot")?.classList.add("live");
    void requestWakeLock();
    render();
  }

  function stopTracking(): void {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    activeMs = currentActiveMs();
    sessionStart = 0;
    window.clearInterval(timerId);
    document.getElementById("me-dot")?.classList.remove("live");
    lastSpeedKmh = 0;
    void releaseWakeLock();
    save();
    setStatus(points.length ? "Tracking stopped. Route saved on this device." : "Tracking stopped.");
    render();
  }

  function exportGpx(): void {
    if (points.length < 2) return;
    const pts = points
      .map((p) => `      <trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
      .join("\n");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trace" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Route ${new Date(points[0].t).toLocaleDateString("en-US")}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
    const url = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `route-${new Date(points[0].t).toISOString().slice(0, 10)}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function resetTrack(): void {
    if (!window.confirm("Delete the saved route?")) return;
    if (isTracking()) stopTracking();
    points = [];
    distanceM = 0;
    activeMs = 0;
    lastSpeedKmh = 0;
    trail.setLatLngs([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setStatus("Route deleted. Press Start to begin again.");
    render();
  }

  toggleBtn.addEventListener("click", () => (isTracking() ? stopTracking() : startTracking()));
  gpxBtn.addEventListener("click", exportGpx);
  resetBtn.addEventListener("click", resetTrack);
  followBtn.addEventListener("click", () => {
    follow = !follow;
    followBtn.setAttribute("aria-pressed", String(follow));
  });

  map.on("dragstart", () => {
    if (follow) {
      follow = false;
      followBtn.setAttribute("aria-pressed", "false");
    }
  });

  load();
  render();
})();
