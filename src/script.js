"use strict";
const KEY = "urma:track";
const FONT = "system-ui, sans-serif";
const el = (id) => document.getElementById(id);
const statusEl = el("status");
const toggleBtn = el("btn-toggle");
const finishBtn = el("btn-finish");
const followBtn = el("btn-follow");
const imageBtn = el("btn-image");
const map = L.map("map", { zoomControl: false }).setView([47.0105, 28.8638], 13);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    crossOrigin: "anonymous",
    attribution: "© OpenStreetMap contributors",
}).addTo(map);
const trail = L.polyline([], { color: "#FE7F2D", weight: 5 }).addTo(map);
const endpoints = L.layerGroup().addTo(map);
const circle = L.circle([0, 0], { radius: 0, weight: 1, color: "#233D4D", fillOpacity: 0.12 });
const marker = L.marker([0, 0], {
    interactive: false,
    icon: L.divIcon({ className: "", html: '<div class="me-dot" id="me-dot"></div>', iconSize: [18, 18] }),
});
let points = [];
let distance = 0;
let activeMs = 0;
let startedAt = 0;
let speed = 0;
let watchId = null;
let follow = true;
let finished = false;
let wakeLock = null;
const dist = (a, b) => L.latLng(a).distanceTo(b);
const formatTime = (ms) => new Date(ms).toISOString().slice(11, 19);
const time = () => activeMs + (startedAt ? Date.now() - startedAt : 0);
function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
}
function setFollow(on) {
    follow = on;
    followBtn.setAttribute("aria-pressed", String(on));
}
function render() {
    el("stat-dist").textContent = `${(distance / 1000).toFixed(2)} km`;
    el("stat-time").textContent = formatTime(time());
    el("stat-speed").textContent = `${speed.toFixed(1)} km/h`;
    toggleBtn.textContent = watchId !== null ? "Stop" : finished ? "New route" : points.length ? "Resume" : "Start";
    toggleBtn.classList.toggle("running", watchId !== null);
    finishBtn.disabled = finished || !points.length;
    imageBtn.disabled = points.length < 2;
    document.getElementById("me-dot")?.classList.toggle("live", watchId !== null);
}
function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ points, activeMs: time(), finished }));
    }
    catch { }
}
function showEnds() {
    endpoints.clearLayers();
    const dot = (p, fill, ring) => L.circleMarker(p, { radius: 8, weight: 3, color: ring, fillColor: fill, fillOpacity: 1 }).addTo(endpoints);
    dot(points[0], "#EAECF0", "#000000");
    dot(points[points.length - 1], "#000000", "#EAECF0");
}
function fit() {
    if (points.length > 1) {
        map.fitBounds(trail.getBounds(), { paddingTopLeft: [40, 40], paddingBottomRight: [40, 280], maxZoom: 18 });
    }
    else if (points.length) {
        map.setView(points[0], 16);
    }
}
function load() {
    try {
        const data = JSON.parse(localStorage.getItem(KEY) || "null");
        if (!data || !data.points?.length)
            return;
        points = data.points;
        activeMs = data.activeMs || 0;
        finished = !!data.finished;
        distance = points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);
        trail.setLatLngs(points);
        fit();
        if (finished) {
            showEnds();
            setFollow(false);
        }
        setStatus(finished ? "Loaded your finished route." : "Loaded your saved route.");
    }
    catch { }
}
function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    marker.setLatLng([lat, lng]).addTo(map);
    circle.setLatLng([lat, lng]).setRadius(accuracy).addTo(map);
    if (follow)
        map.panTo([lat, lng]);
    if (accuracy > 50) {
        setStatus(`Weak signal (±${Math.round(accuracy)} m). Waiting for a more accurate position…`);
        return;
    }
    setStatus(`Tracking · accuracy ±${Math.round(accuracy)} m`);
    const point = { lat, lng, t: pos.timestamp };
    const prev = points[points.length - 1];
    if (prev) {
        const step = dist(prev, point);
        if (step < 4) {
            speed = 0;
            return;
        }
        distance += step;
        const seconds = Math.max((point.t - prev.t) / 1000, 1);
        speed = pos.coords.speed != null ? pos.coords.speed * 3.6 : (step / seconds) * 3.6;
    }
    points.push(point);
    trail.addLatLng(point);
    save();
    render();
}
function onError(err) {
    const messages = {
        1: "Location permission was denied. Enable it in your browser settings.",
        2: "Your position can't be determined. Check your GPS or connection.",
        3: "Finding your position timed out. Trying again…",
    };
    setStatus(messages[err.code] ?? err.message, true);
    if (err.code === 1)
        stopTracking();
}
async function lockScreen() {
    try {
        wakeLock = await navigator.wakeLock.request("screen");
    }
    catch { }
}
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && watchId !== null)
        lockScreen();
});
function startTracking() {
    if (!navigator.geolocation) {
        setStatus("Your browser doesn't support geolocation.", true);
        return;
    }
    startedAt = Date.now();
    setStatus("Finding your position…");
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000,
    });
    lockScreen();
    render();
}
function stopTracking() {
    if (watchId !== null)
        navigator.geolocation.clearWatch(watchId);
    watchId = null;
    activeMs = time();
    startedAt = 0;
    speed = 0;
    wakeLock?.release();
    wakeLock = null;
    save();
    setStatus(points.length ? "Tracking stopped. Route saved on this device." : "Tracking stopped.");
    render();
}
function finishRoute() {
    if (watchId !== null)
        stopTracking();
    finished = true;
    marker.remove();
    circle.remove();
    showEnds();
    setFollow(false);
    fit();
    save();
    setStatus(`Route finished · ${(distance / 1000).toFixed(2)} km in ${formatTime(activeMs)}. Save the image to keep it.`);
    render();
}
function newRoute() {
    points = [];
    distance = 0;
    activeMs = 0;
    speed = 0;
    finished = false;
    trail.setLatLngs([]);
    endpoints.clearLayers();
    setFollow(true);
    save();
}
async function drawImage() {
    const W = 1080;
    const H = 1080;
    const FOOTER = 220;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H + FOOTER;
    const ctx = canvas.getContext("2d");
    const bounds = L.latLngBounds(points);
    let zoom = 18;
    while (zoom > 1) {
        const size = map.project(bounds.getSouthEast(), zoom).subtract(map.project(bounds.getNorthWest(), zoom));
        if (size.x <= W - 180 && size.y <= H - 180)
            break;
        zoom--;
    }
    const center = map.project(bounds.getNorthWest(), zoom).add(map.project(bounds.getSouthEast(), zoom)).divideBy(2);
    const origin = center.subtract([W / 2, H / 2]);
    const first = origin.divideBy(256).floor();
    const last = origin.add([W, H]).divideBy(256).floor();
    ctx.fillStyle = "#EAECF0";
    ctx.fillRect(0, 0, W, H);
    const tiles = [];
    for (let x = first.x; x <= last.x; x++) {
        for (let y = first.y; y <= last.y; y++) {
            tiles.push(new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    ctx.drawImage(img, x * 256 - origin.x, y * 256 - origin.y);
                    resolve();
                };
                img.onerror = () => resolve();
                img.src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
            }));
        }
    }
    await Promise.all(tiles);
    const toCanvas = (p) => map.project(p, zoom).subtract(origin);
    const line = (color, width) => {
        ctx.beginPath();
        points.forEach((p, i) => {
            const c = toCanvas(p);
            if (i)
                ctx.lineTo(c.x, c.y);
            else
                ctx.moveTo(c.x, c.y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    };
    const dot = (p, fill, ring) => {
        const c = toCanvas(p);
        ctx.fillStyle = ring;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
        ctx.fill();
    };
    line("#EAECF0", 16);
    line("#FE7F2D", 10);
    dot(points[0], "#EAECF0", "#000000");
    dot(points[points.length - 1], "#000000", "#EAECF0");
    ctx.fillStyle = "rgba(234, 236, 240, 0.9)";
    ctx.fillRect(W - 270, H - 32, 270, 32);
    ctx.fillStyle = "#233D4D";
    ctx.font = `18px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText("© OpenStreetMap contributors", W - 10, H - 10);
    ctx.fillStyle = "#EAECF0";
    ctx.fillRect(0, H, W, FOOTER);
    ctx.fillStyle = "#FE7F2D";
    ctx.fillRect(0, H, W, 6);
    ctx.fillStyle = "#233D4D";
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(new Date(points[0].t).toLocaleDateString("en-US", { dateStyle: "long" }), 40, H + 50);
    const ms = time();
    const stats = [
        [`${(distance / 1000).toFixed(2)} km`, "DISTANCE"],
        [formatTime(ms), "TIME"],
        [`${(ms ? (distance / ms) * 3600 : 0).toFixed(1)} km/h`, "AVG SPEED"],
    ];
    ctx.textAlign = "center";
    stats.forEach(([value, label], i) => {
        const x = (W / 3) * (i + 0.5);
        ctx.fillStyle = "#000000";
        ctx.font = `700 54px ${FONT}`;
        ctx.fillText(value, x, H + 130);
        ctx.fillStyle = "#233D4D";
        ctx.font = `600 22px ${FONT}`;
        ctx.fillText(label, x, H + 175);
    });
    return canvas;
}
async function saveImage() {
    imageBtn.disabled = true;
    setStatus("Rendering image…");
    try {
        const canvas = await drawImage();
        const link = document.createElement("a");
        link.href = canvas.toDataURL("image/png");
        link.download = `route-${new Date(points[0].t).toISOString().slice(0, 10)}.png`;
        link.click();
        setStatus("Image saved.");
    }
    catch {
        setStatus("Couldn't create the image. Check your connection and try again.", true);
    }
}
toggleBtn.onclick = () => {
    if (watchId !== null) {
        stopTracking();
    }
    else if (!finished || confirm("Start a new route? The finished route will be cleared.")) {
        if (finished)
            newRoute();
        startTracking();
    }
};
finishBtn.onclick = finishRoute;
imageBtn.onclick = saveImage;
followBtn.onclick = () => setFollow(!follow);
map.on("dragstart", () => setFollow(false));
load();
render();
setInterval(render, 1000);
