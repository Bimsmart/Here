const form = document.querySelector("#journey-form");
const list = document.querySelector("#journey-list");
const count = document.querySelector("#journey-count");
const message = document.querySelector("#form-message");
const tripEstimate = document.querySelector("#trip-estimate");
const coordinateReadout = document.querySelector("#coordinate-readout");
const mapNotice = document.querySelector("#map-notice");
const locationSearch = document.querySelector("#location-search");
const searchButton = document.querySelector("#search-location");
const searchTargetLabel = document.querySelector("#search-target-label");
const locationResults = document.querySelector("#location-results");
const incidentForm = document.querySelector("#incident-form");
const incidentList = document.querySelector("#incident-list");
const incidentCount = document.querySelector("#incident-count");
const incidentMessage = document.querySelector("#report-message");
const incidentLocationReadout = document.querySelector("#incident-location-readout");
const moderatorStatus = document.querySelector("#moderation-status");
const newsSyncStatusLabel = document.querySelector("#news-sync-status");
const syncNewsButton = document.querySelector("#sync-news");
const authDialog = document.querySelector("#auth-dialog");
const authTrigger = document.querySelector("#auth-trigger");
const accountSummary = document.querySelector("#account-summary");
const accountName = document.querySelector("#account-name");
const accountAvatar = document.querySelector("#account-avatar");
const settingsAccount = document.querySelector("#settings-account");
const authMessage = document.querySelector("#auth-message");
const markers = { origin: null, destination: null };
const points = { origin: null, destination: null, incident: null };
let activePick = "destination";
let journeys = [];
let notificationEvents = [];
let incidents = [];
let threatReports = {};
let appConfig = {};
let liveNewsStatus = {};
let authToken = localStorage.getItem("geopresence_auth_token") || "";
let currentUser = null;
const locationWatches = new Map();
let journeySnapshot = "";
let map;
let incidentLayer;
const routeLayers = new Map();
const collaborationMarkers = new Map();
const historyLayers = new Map();
let estimateTimer;
let estimateSequence = 0;
let locationSuggestionTimer;
let locationSearchSequence = 0;
let lastLocationRequestAt = 0;

const statusLabels = {
  ACTIVE: "On track",
  OVERDUE_PENDING: "Check-in due",
  OVERDUE_NOTIFIED: "Email accepted",
  ARRIVED: "Arrived",
  CANCELLED: "Cancelled",
};

const statusClasses = {
  ACTIVE: "active",
  OVERDUE_PENDING: "overdue",
  OVERDUE_NOTIFIED: "notified",
  ARRIVED: "arrived",
  CANCELLED: "cancelled",
};

function localInputDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

document.querySelector("#departure-at").value = localInputDate(new Date());

function durationLabel(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

async function updateTripEstimate() {
  window.clearTimeout(estimateTimer);
  if (!points.origin || !points.destination) {
    tripEstimate.textContent = "Choose a starting point and destination to calculate the arrival time and extended time.";
    return;
  }
  const sequence = ++estimateSequence;
  estimateTimer = window.setTimeout(async () => {
    tripEstimate.textContent = "Calculating route, ETA, and extended time…";
    try {
      const result = await request("/api/journeys/estimate", {
        method: "POST",
        body: JSON.stringify({
          origin: points.origin,
          destination: points.destination,
          departure_at: new Date(document.querySelector("#departure-at").value || Date.now()).toISOString(),
        }),
      });
      if (sequence !== estimateSequence) return;
      const routeLabel = result.route_source === "osrm" ? "road-route estimate" : "approximate direct-line estimate";
      tripEstimate.textContent = `Estimated travel: ${durationLabel(result.estimated_duration_seconds)} · ETA ${readableDate(result.eta)} · extended time ${durationLabel(result.grace_period_seconds)} (${routeLabel}).`;
    } catch (error) {
      if (sequence === estimateSequence) tripEstimate.textContent = `Could not calculate the trip estimate: ${error.message}`;
    }
  }, 450);
}

document.querySelector("#departure-at").addEventListener("change", updateTripEstimate);

function markerIcon(kind) {
  return L.divIcon({
    className: `map-marker map-marker-${kind}`,
    html: `<span class="marker-core"></span><span class="marker-pulse"></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function initMap() {
  if (!window.L) {
    mapNotice.textContent = "Map tiles are unavailable. You can still create journeys by selecting a point when the map loads.";
    mapNotice.classList.add("is-visible");
    return;
  }
  map = L.map("map", { zoomControl: false, attributionControl: false }).setView([6.5244, 3.3792], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  incidentLayer = L.layerGroup().addTo(map);
  map.on("click", (event) => setPoint(activePick, event.latlng.lat, event.latlng.lng));
}

function setPoint(kind, latitude, longitude) {
  points[kind] = { latitude, longitude };
  if (map) {
    if (markers[kind]) map.removeLayer(markers[kind]);
    markers[kind] = L.marker([latitude, longitude], { icon: markerIcon(kind) }).addTo(map);
    markers[kind].bindTooltip(kind === "origin" ? "Starting point" : kind === "incident" ? "Report location" : "Destination");
    if (kind !== "incident" && points.origin && points.destination) {
      map.fitBounds([
        [points.origin.latitude, points.origin.longitude],
        [points.destination.latitude, points.destination.longitude],
      ], { padding: [80, 80], maxZoom: 15 });
    } else {
      map.flyTo([latitude, longitude], Math.max(map.getZoom(), 14), { duration: 0.45 });
    }
  }
  if (kind === "incident") {
    incidentLocationReadout.textContent = `Report location · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    incidentLocationReadout.classList.add("has-point");
  } else {
    coordinateReadout.textContent = `${kind === "origin" ? "Start" : "Destination"} · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    coordinateReadout.classList.add("has-point");
  }
  if (kind === "origin" || kind === "destination") updateTripEstimate();
}

function showLocationResults(results, target) {
  if (!results.length) {
    locationResults.innerHTML = '<li class="location-empty">No places found. Try a nearby town or landmark.</li>';
    locationResults.hidden = false;
    return;
  }
  locationResults.innerHTML = results.map((result, index) => {
    const parts = result.label.split(",");
    const title = parts.shift().trim();
    const detail = parts.join(",").trim();
    return `<li role="option"><button type="button" class="place-result" data-result-index="${index}">
      <span class="place-result-icon" aria-hidden="true">⌖</span>
      <span class="place-result-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail || result.kind)}</small></span>
      <span class="place-result-arrow" aria-hidden="true">↗</span>
    </button></li>`;
  }).join("");
  locationResults.hidden = false;
  locationResults.querySelectorAll("[data-result-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const result = results[Number(button.dataset.resultIndex)];
      setPoint(target, result.latitude, result.longitude);
      if (target === "destination") {
        const labelInput = document.querySelector("#destination-label");
        if (!labelInput.value.trim()) labelInput.value = result.label.split(",")[0].trim();
      }
      locationSearch.value = result.label;
      window.clearTimeout(locationSuggestionTimer);
      locationSearchSequence += 1;
      locationResults.hidden = true;
      locationResults.replaceChildren();
    });
  });
}

async function searchForLocation({ automatic = false, sequence = null } = {}) {
  const currentSequence = sequence ?? ++locationSearchSequence;
  const query = locationSearch.value.trim();
  if (query.length < 3) {
    if (!automatic) showMessage("Enter at least 3 characters to search for a place.", true);
    return;
  }
  const target = activePick;
  const throttleWait = Math.max(0, 1_050 - (Date.now() - lastLocationRequestAt));
  if (throttleWait) await new Promise((resolve) => window.setTimeout(resolve, throttleWait));
  if (currentSequence !== locationSearchSequence || query !== locationSearch.value.trim() || target !== activePick) return;
  lastLocationRequestAt = Date.now();
  searchButton.disabled = true;
  locationResults.innerHTML = '<li class="location-empty">Searching places…</li>';
  locationResults.hidden = false;
  try {
    const results = await request(`/api/locations/search?q=${encodeURIComponent(query)}`);
    if (currentSequence !== locationSearchSequence || query !== locationSearch.value.trim() || target !== activePick) return;
    showLocationResults(results, target);
    if (!automatic && results.length) {
      const targetLabel = target === "origin" ? "starting point" : target === "incident" ? "report location" : "destination";
      showMessage(`${results.length} place${results.length === 1 ? "" : "s"} found. Choose one to set the ${targetLabel}.`);
    }
  } catch (error) {
    if (currentSequence === locationSearchSequence) {
      if (automatic) {
        locationResults.innerHTML = `<li class="location-empty">${escapeHtml(error.message)}</li>`;
        locationResults.hidden = false;
      } else {
        locationResults.hidden = true;
        showMessage(error.message, true);
      }
    }
  } finally {
    if (currentSequence === locationSearchSequence) searchButton.disabled = false;
  }
}

function scheduleLocationSuggestions() {
  window.clearTimeout(locationSuggestionTimer);
  const sequence = ++locationSearchSequence;
  if (locationSearch.value.trim().length < 3) {
    locationResults.hidden = true;
    locationResults.replaceChildren();
    return;
  }
  const wait = Math.max(650, 1_050 - (Date.now() - lastLocationRequestAt));
  locationSuggestionTimer = window.setTimeout(
    () => searchForLocation({ automatic: true, sequence }), wait,
  );
}

searchButton.addEventListener("click", () => {
  window.clearTimeout(locationSuggestionTimer);
  searchForLocation();
});
locationSearch.addEventListener("input", scheduleLocationSuggestions);
locationSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    window.clearTimeout(locationSuggestionTimer);
    searchForLocation();
  } else if (event.key === "Escape") {
    window.clearTimeout(locationSuggestionTimer);
    locationSearchSequence += 1;
    locationResults.hidden = true;
  }
});

document.querySelectorAll("[data-pick]").forEach((button) => {
  button.addEventListener("click", () => {
    activePick = button.dataset.pick;
    document.querySelectorAll("[data-pick]").forEach((item) => item.classList.toggle("is-selected", item === button));
    const targetLabel = activePick === "origin" ? "starting point" : activePick === "incident" ? "report location" : "destination";
    searchTargetLabel.textContent = `Setting ${targetLabel}`;
    if (locationSearch.value.trim().length >= 3) scheduleLocationSuggestions();
    if (activePick === "incident") {
      incidentLocationReadout.textContent = "Search or click the map to set this report’s location.";
      incidentLocationReadout.classList.remove("has-point");
    } else {
      coordinateReadout.textContent = `Search or click the map to choose a ${targetLabel}`;
      coordinateReadout.classList.remove("has-point");
    }
    locationResults.hidden = true;
  });
});

document.querySelector("#use-location").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showMessage("This browser does not support location access.", true);
    return;
  }
  showMessage("Requesting your location…");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setPoint("origin", coords.latitude, coords.longitude);
      activePick = "destination";
      document.querySelectorAll("[data-pick]").forEach((button) => {
        button.classList.toggle("is-selected", button.dataset.pick === activePick);
      });
      searchTargetLabel.textContent = "Setting destination";
      showMessage("Starting point set. Choose a destination on the map.");
    },
    () => showMessage("Location was unavailable or permission was denied. You can select a start point on the map.", true),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
  );
});

document.querySelector("#fit-map").addEventListener("click", () => {
  if (points.origin && points.destination) {
    map.fitBounds([
      [points.origin.latitude, points.origin.longitude],
      [points.destination.latitude, points.destination.longitude],
    ], { padding: [80, 80], maxZoom: 15 });
  } else if (points.origin || points.destination) {
    const point = points.origin || points.destination;
    map.setView([point.latitude, point.longitude], 14);
  }
});

document.querySelector("#incident-source").addEventListener("change", (event) => {
  document.querySelector("#incident-url").required = event.target.value === "news";
});

document.querySelector("#set-report-location").addEventListener("click", () => {
  activePick = "incident";
  incidentLocationReadout.textContent = "Click the map to set this report's location.";
  incidentLocationReadout.classList.remove("has-point");
  if (map) map.getContainer().focus();
});

incidentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!points.incident) {
    setIncidentMessage("Choose a report location with search or the map first.", true);
    return;
  }
  const submit = incidentForm.querySelector("[type=submit]");
  const values = new FormData(incidentForm);
  const reportedAt = values.get("reported_at");
  const payload = {
    title: values.get("title"),
    description: values.get("description"),
    category: values.get("category"),
    source_type: values.get("source_type"),
    source_url: values.get("source_url") || null,
    reported_at: reportedAt ? new Date(reportedAt).toISOString() : null,
    location: {
      latitude: points.incident.latitude,
      longitude: points.incident.longitude,
      accuracy_m: null,
    },
  };
  submit.disabled = true;
  setIncidentMessage("Submitting an unverified report…");
  try {
    const result = await request("/api/incidents", { method: "POST", body: JSON.stringify(payload) });
    incidentForm.reset();
    document.querySelector("#incident-url").required = false;
    points.incident = null;
    if (markers.incident && map) map.removeLayer(markers.incident);
    markers.incident = null;
    incidentLocationReadout.textContent = "Click the map to set this report's location.";
    incidentLocationReadout.classList.remove("has-point");
    await loadJourneys();
    setIncidentMessage(result.possible_duplicate_ids.length
      ? `Report submitted as unverified. ${result.possible_duplicate_ids.length} similar report${result.possible_duplicate_ids.length === 1 ? "" : "s"} may already exist.`
      : "Report submitted as unverified. Nearby route warnings will include its source and event time.");
  } catch (error) {
    setIncidentMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("is-error", isError);
}

function setIncidentMessage(text, isError = false) {
  incidentMessage.textContent = text;
  incidentMessage.classList.toggle("is-error", isError);
}

function readableDate(value) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function readableReportDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (authToken && !headers.Authorization) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Something went wrong. Please try again.");
  return body;
}

function showAuthDialog(mode = "login") {
  setAuthMode(mode);
  authDialog.hidden = false;
  document.querySelector(`#${mode}-email`).focus();
}

function hideAuthDialog() {
  authDialog.hidden = true;
  authMessage.textContent = "";
  authMessage.classList.remove("is-error");
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  document.querySelector("#login-form").hidden = !isLogin;
  document.querySelector("#signup-form").hidden = isLogin;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#auth-title").textContent = isLogin ? "Log in" : "Create account";
  authMessage.textContent = "";
  authMessage.classList.remove("is-error");
}

function renderAccount() {
  const signedIn = Boolean(currentUser);
  authTrigger.hidden = signedIn;
  accountSummary.hidden = !signedIn;
  if (signedIn) {
    accountName.textContent = currentUser.display_name;
    accountAvatar.textContent = currentUser.display_name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    settingsAccount.innerHTML = `<p class="account-card-label">SIGNED IN AS</p><strong>${escapeHtml(currentUser.display_name)}</strong><span>${escapeHtml(currentUser.email)}</span><button id="settings-logout" class="logout-button" type="button">Log out</button>`;
    settingsAccount.querySelector("#settings-logout").addEventListener("click", logout);
  } else {
    settingsAccount.innerHTML = '<p class="account-card-label">ACCOUNT</p><button id="settings-login" class="auth-trigger" type="button">Log in or sign up</button>';
    settingsAccount.querySelector("#settings-login").addEventListener("click", () => showAuthDialog("login"));
  }
}

async function establishSession(session) {
  authToken = session.token;
  localStorage.setItem("geopresence_auth_token", authToken);
  currentUser = session.user;
  renderAccount();
  hideAuthDialog();
  await loadJourneys();
}

async function logout() {
  try {
    if (authToken) await request("/api/auth/logout", { method: "POST" });
  } catch {
    // Removing a local session remains safe when a server is unreachable.
  }
  authToken = "";
  currentUser = null;
  localStorage.removeItem("geopresence_auth_token");
  journeys = [];
  notificationEvents = [];
  threatReports = {};
  renderAccount();
  renderJourneys();
  if (map) renderJourneyMarkers();
  switchView("plan");
}

function renderJourneys() {
  const sharedList = document.querySelector("#shared-journey-list");
  const sharedCount = document.querySelector("#shared-journey-count");
  const chatSelect = document.querySelector("#chat-trip-select");
  const chatRoom = document.querySelector("#chat-room");
  const chatEmpty = document.querySelector("#chat-empty");
  const chatTitle = document.querySelector("#chat-room-title");
  const ownedJourneys = journeys.filter((journey) => journey.owner_user_id === currentUser?.id);
  const sharedJourneys = journeys.filter((journey) => journey.owner_user_id !== currentUser?.id);
  count.textContent = ownedJourneys.length;
  sharedCount.textContent = sharedJourneys.length;
  const localShareOnly = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const renderJourneyCard = (journey) => {
    const isOwner = journey.owner_user_id === currentUser?.id;
    const canUpdate = isOwner && ["ACTIVE", "OVERDUE_PENDING", "OVERDUE_NOTIFIED"].includes(journey.status);
    const canExtend = ["ACTIVE", "OVERDUE_PENDING"].includes(journey.status);
    const canClose = !["ARRIVED", "CANCELLED"].includes(journey.status);
    const latestNotification = notificationEvents.find((event) => event.journey_id === journey.id);
    const notificationMessage = latestNotification?.status === "LOGGED"
      ? "Check-in reminder recorded locally; no email was sent."
      : latestNotification?.status === "SENT"
        ? "Email accepted by the configured SMTP server."
        : latestNotification?.status === "FAILED"
          ? "Email delivery failed. Check the server log."
          : "";
    const alerts = threatReports[journey.id] || [];
    const routeNotice = journey.route_source === "direct_estimate"
      ? "Direct-line estimate; not a road route."
      : journey.route_source === "unavailable"
        ? "Route unavailable. Set a starting point to check reports along the way."
        : "Road route preview";
    const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${journey.destination_lat},${journey.destination_lon}&travelmode=driving`;
    const shareUrl = journey.share_token
      ? `${window.location.origin}/shared-location.html#${encodeURIComponent(journey.share_token)}`
      : "";
    const helpSubject = encodeURIComponent(`I need help with my trip to ${journey.destination_label}`);
    const savedLocation = journey.location_lat != null && journey.location_lon != null
      ? `\nView the location I shared: ${shareUrl} (last updated ${journey.location_at || "time unknown"}).`
      : "\nI have not shared my current location with this app yet.";
    const helpBody = encodeURIComponent(`Hi ${journey.contact_name},\n\nI need help with my trip to ${journey.destination_label}.${savedLocation}\nPlease contact me when you can.\n\nThis message was prepared in this app and will only be sent if you press Send.`);
    const hasSharedLocation = journey.location_lat != null && journey.location_lon != null;
    return `<article class="journey-item" data-id="${escapeHtml(journey.id)}">
      <div class="journey-topline"><span class="status-pill status-${statusClasses[journey.status]}"><i></i>${statusLabels[journey.status]}</span><time>ETA · ${readableDate(journey.eta)}</time></div>
      <h3>${escapeHtml(journey.destination_label)}</h3>
      <p class="journey-contact">Contact · ${escapeHtml(journey.contact_name)}</p>
      <p class="route-source">${routeNotice}${journey.estimated_duration_seconds == null ? "" : ` · App estimate ${durationLabel(journey.estimated_duration_seconds)} · ${durationLabel(journey.grace_period_seconds)} extended time`}</p>
      <section class="shared-location" aria-label="Shared location"><div class="shared-location-heading"><strong>Shared location</strong><span>${hasSharedLocation ? "Saved once" : "Not shared yet"}</span></div>${hasSharedLocation && journey.status !== "CANCELLED" ? `<p>Last shared ${journey.location_at ? readableDate(journey.location_at) : "time unknown"}${journey.location_accuracy == null ? "" : ` · accuracy ±${Math.round(journey.location_accuracy)} m`}.</p><a href="${shareUrl}" target="_blank" rel="noopener noreferrer">Preview recipient view ↗</a><div class="shared-location-actions"><button type="button" data-share-link="${escapeHtml(shareUrl)}">Share link</button><button type="button" data-copy-link="${escapeHtml(shareUrl)}">Copy link</button><button type="button" data-rotate-link>Replace link</button></div><p>Anyone with the private link can view the latest point you shared. No account required.</p>${localShareOnly ? "<p class=\"share-local-warning\">This app is running on this device only. To share the link with someone elsewhere, it must be hosted at an address they can reach.</p>" : ""}` : journey.status === "CANCELLED" ? "<p>This journey was cancelled, so its shared link is no longer available.</p>" : ""}</section>
      ${journey.status === "OVERDUE_PENDING" ? '<p class="journey-alert">Your extended time window is active. You can still check in or extend your ETA.</p>' : ""}
      ${notificationMessage ? `<p class="journey-alert">${notificationMessage}</p>` : ""}
      ${journey.route_source !== "unavailable" ? `<section class="threat-summary" aria-label="News and reports along this route"><div class="threat-heading"><strong>News along this route</strong><span>${alerts.length}</span></div>${alerts.length ? `<p class="route-news-note">Current reports within ${appConfig.route_alert_buffer_m || 500} m of this route. Reports may be unverified and do not determine whether a route is safe.</p><ul>${alerts.map((report) => `<li><span>${escapeHtml(report.title)}</span><small>~${report.distance_to_route_m} m from route · ${escapeHtml(categoryLabel(report.category))} · ${escapeHtml(report.verification_status)} · ${report.reported_at ? `event ${readableReportDate(report.reported_at)}` : "event time unknown"} · published ${report.source_published_at ? readableReportDate(report.source_published_at) : "time unknown"} · ${report.location_accuracy_m == null ? "location accuracy unknown" : `location ±${report.location_accuracy_m} m${report.approximate_location ? " (approximate)" : ""}`}</small>${report.source_url ? `<a href="${escapeHtml(report.source_url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ""}</li>`).join("")}</ul>` : `<p class="route-news-note">No current reports found within ${appConfig.route_alert_buffer_m || 500} m of this route.</p>`}</section>` : `<section class="threat-summary" aria-label="News and reports along this route"><strong>News along this route</strong><p class="route-news-note">A road route is unavailable, so reports cannot be matched to this journey.</p></section>`}
      ${canUpdate ? `<div class="journey-actions"><a class="journey-nav-link" href="${navigationUrl}" target="_blank" rel="noopener noreferrer">Open directions ↗</a><a class="journey-help-link" href="mailto:${encodeURIComponent(journey.contact_email)}?subject=${helpSubject}&body=${helpBody}">Ask for help</a><button type="button" data-action="share-location">Share location</button><button type="button" data-action="arrive">I’ve arrived</button>${canExtend ? '<button type="button" data-action="extend">Extend ETA</button>' : ""}${canClose ? '<button type="button" data-action="cancel" aria-label="Cancel journey">Cancel</button>' : ""}</div>` : journey.status === "ARRIVED" && isOwner ? '<div class="journey-actions"><button type="button" data-action="undo-arrive">Undo “I’ve arrived”</button></div>' : ""}
    </article>`;
  };
  const renderGroup = (target, group, emptyText) => {
    const current = group.filter((journey) => !["ARRIVED", "CANCELLED"].includes(journey.status));
    const past = group.filter((journey) => ["ARRIVED", "CANCELLED"].includes(journey.status));
    target.innerHTML = `${current.length ? current.map(renderJourneyCard).join("") : `<div class="empty-state">${emptyText}</div>`}${past.length ? `<details class="past-journeys"><summary>Past journeys (${past.length})</summary><div class="past-journey-list">${past.map(renderJourneyCard).join("")}</div></details>` : ""}`;
    target.querySelectorAll(".journey-item").forEach((card) => {
      const journey = group.find((candidate) => candidate.id === card.dataset.id);
      if (!journey) return;
      const isPast = ["ARRIVED", "CANCELLED"].includes(journey.status);
      const panel = document.createElement("section");
      panel.className = "trip-collaboration";
      panel.dataset.collaborationId = journey.id;
      panel.innerHTML = `<div class="trip-collab-heading"><strong>${isPast ? "Trip history" : "Trip details & live location"}</strong><span>Shared with trip members</span><button type="button" class="trip-chat-open" data-chat-journey="${escapeHtml(journey.id)}" aria-label="Open chat for ${escapeHtml(journey.destination_label)}" title="Open chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.75A2.75 2.75 0 0 1 6.75 2h10.5A2.75 2.75 0 0 1 20 4.75v8.5A2.75 2.75 0 0 1 17.25 16H10l-5.2 4.2c-.33.27-.8.03-.8-.39V4.75Z"/></svg></button></div>
        <button type="button" class="trip-export-kml">Export trip as KML</button>
        ${isPast ? '<button type="button" class="trip-history-map">View saved route on map</button><div class="trip-location-history" data-location-history>Loading location history…</div>' : ""}
        ${!isPast && journey.owner_user_id === currentUser?.id ? `<form class="trip-invite-form"><label class="field-label">Invite a GeoPresence user</label><div class="trip-inline-form"><input type="email" name="email" placeholder="Their account email" required><button type="submit">Invite</button></div><p class="trip-feedback" aria-live="polite"></p></form>` : ""}
        ${!isPast ? `<button type="button" class="trip-location-toggle">${locationWatches.has(journey.id) ? "Stop sharing my live location" : "Share my live location"}</button><p class="trip-location-note">Location sharing is optional. Members can see your current point; past points are kept in trip history.</p>` : ""}
        <div class="trip-members" data-trip-members>Loading participants…</div>`;
      card.append(panel);
      refreshCollaboration(journey.id);
    });
    target.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleJourneyAction(button)));
    target.querySelectorAll("[data-share-link]").forEach((button) => button.addEventListener("click", () => shareJourneyLink(button.dataset.shareLink)));
    target.querySelectorAll("[data-copy-link]").forEach((button) => button.addEventListener("click", () => copyJourneyLink(button.dataset.copyLink)));
    target.querySelectorAll("[data-rotate-link]").forEach((button) => button.addEventListener("click", () => rotateJourneyLink(button)));
    target.querySelectorAll(".trip-invite-form").forEach((inviteForm) => inviteForm.addEventListener("submit", (event) => inviteTripMember(event)));
    target.querySelectorAll(".trip-location-toggle").forEach((button) => button.addEventListener("click", () => toggleTripLocation(button)));
    target.querySelectorAll(".trip-history-map").forEach((button) => button.addEventListener("click", () => showTripHistory(button)));
    target.querySelectorAll(".trip-export-kml").forEach((button) => button.addEventListener("click", (event) => exportTripKml(event.currentTarget)));
    target.querySelectorAll(".trip-chat-open").forEach((button) => button.addEventListener("click", () => {
      chatSelect.value = button.dataset.chatJourney;
      selectChatJourney();
      switchView("chat");
    }));
  };
  renderGroup(list, ownedJourneys, "Your planned journeys will appear here.");
  renderGroup(sharedList, sharedJourneys, "Journeys shared with you will appear here.");

  const previouslySelected = chatSelect.value;
  chatSelect.innerHTML = journeys.length ? journeys.map((journey) => `<option value="${escapeHtml(journey.id)}">${escapeHtml(journey.destination_label)}${journey.owner_user_id === currentUser?.id ? " · yours" : " · shared"}</option>`).join("") : "";
  chatSelect.hidden = !journeys.length;
  chatEmpty.hidden = Boolean(journeys.length);
  chatRoom.hidden = !journeys.length;
  if (journeys.length) {
    chatSelect.value = journeys.some((journey) => journey.id === previouslySelected) ? previouslySelected : journeys[0].id;
    selectChatJourney();
  } else {
    chatRoom.dataset.collaborationId = "";
  }
}

function selectChatJourney() {
  const chatSelect = document.querySelector("#chat-trip-select");
  const chatRoom = document.querySelector("#chat-room");
  const journey = journeys.find((item) => item.id === chatSelect.value);
  if (!journey) return;
  chatRoom.dataset.collaborationId = journey.id;
  document.querySelector("#chat-room-title").textContent = journey.destination_label;
  const messages = chatRoom.querySelector("[data-trip-messages]");
  messages.innerHTML = '<p class="trip-chat-empty">Loading trip messages…</p>';
  const form = chatRoom.querySelector(".trip-chat-form");
  form.hidden = ["ARRIVED", "CANCELLED"].includes(journey.status);
  refreshCollaboration(journey.id);
}

async function refreshCollaboration(journeyId) {
  const panels = [...document.querySelectorAll(`[data-collaboration-id="${CSS.escape(journeyId)}"]`)];
  const panel = panels.find((item) => item.closest(".journey-item"));
  const chatPanel = document.querySelector(`#chat-room[data-collaboration-id="${CSS.escape(journeyId)}"]`);
  if ((!panel && !chatPanel) || !currentUser) return;
  try {
    const data = await request(`/api/journeys/${journeyId}/collaboration`);
    const members = panel?.querySelector("[data-trip-members]") || chatPanel?.querySelector("[data-trip-members]");
    const liveMembers = data.members.filter((member) => member.latitude != null);
    const liveMarkerIds = new Set(liveMembers.map((member) => `${journeyId}:${member.id}`));
    collaborationMarkers.forEach((marker, key) => {
      if (key.startsWith(`${journeyId}:`) && !liveMarkerIds.has(key)) {
        map.removeLayer(marker);
        collaborationMarkers.delete(key);
      }
    });
    liveMembers.forEach((member) => {
      const key = `${journeyId}:${member.id}`;
      const marker = collaborationMarkers.get(key);
      if (marker) marker.setLatLng([member.latitude, member.longitude]);
      else collaborationMarkers.set(key, L.circleMarker([member.latitude, member.longitude], {
        radius: 8, color: "#fff", weight: 2, fillColor: "#c8664f", fillOpacity: 1,
      }).addTo(map).bindTooltip(`${escapeHtml(member.display_name)} · live location`));
    });
    members.innerHTML = `<strong>Participants</strong>${data.members.map((member) => {
      const location = member.latitude == null ? "Location not shared" : `Live point · ${readableDate(member.updated_at)}`;
      return `<div class="trip-member"><span>${escapeHtml(member.display_name)}${member.id === currentUser.id ? " (you)" : ""}</span><small>${location}</small>${member.latitude == null ? "" : `<a target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=${member.latitude}&mlon=${member.longitude}#map=16/${member.latitude}/${member.longitude}">View location ↗</a>`}</div>`;
    }).join("")}`;
    if (chatPanel) chatPanel.querySelector("[data-trip-members]").innerHTML = members.innerHTML;
    const messages = chatPanel?.querySelector("[data-trip-messages]");
    if (messages) {
      const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      messages.innerHTML = data.messages.length ? data.messages.map((item) => `<p class="trip-message ${item.user_id === currentUser.id ? "mine" : ""}"><strong>${escapeHtml(item.display_name)}</strong><span>${escapeHtml(item.body)}</span><small>${readableDate(item.created_at)}</small></p>`).join("") : '<p class="trip-chat-empty">Messages for this trip will appear here.</p>';
      if (nearBottom) messages.scrollTop = messages.scrollHeight;
    }
    const history = panel?.querySelector("[data-location-history]");
    if (history) {
      history.innerHTML = data.location_history.length
        ? `<strong>${data.location_history.length} saved location point${data.location_history.length === 1 ? "" : "s"}</strong><ul>${data.location_history.slice(-12).reverse().map((point) => `<li><span>${escapeHtml(point.display_name)}</span><small>${readableDate(point.recorded_at)} · ${Number(point.latitude).toFixed(5)}, ${Number(point.longitude).toFixed(5)}</small></li>`).join("")}</ul>`
        : "No live location points were saved during this trip.";
      panel.dataset.routeData = JSON.stringify({ route_coordinates: data.route_coordinates, origin: data.origin, destination: data.destination, location_history: data.location_history });
    }
  } catch (error) {
    panel.querySelector("[data-trip-members]").textContent = error.message;
  }
}

function showTripHistory(button) {
  const panel = button.closest("[data-collaboration-id]");
  const journey = journeys.find((item) => item.id === panel.dataset.collaborationId);
  if (!journey) return;
  let data;
  try { data = JSON.parse(panel.dataset.routeData || "{}"); } catch { data = {}; }
  const oldLayer = historyLayers.get(journey.id);
  if (oldLayer) map.removeLayer(oldLayer);
  const layers = [];
  const allPoints = [];
  const route = data.route_coordinates || (data.origin ? [[data.origin.longitude, data.origin.latitude], [data.destination.longitude, data.destination.latitude]] : []);
  const plannedPoints = route.map(([lon, lat]) => [lat, lon]);
  allPoints.push(...plannedPoints);
  if (plannedPoints.length > 1) layers.push(L.polyline(plannedPoints, { color: "#285b4c", weight: 5, opacity: 0.8 }));
  const grouped = new Map();
  (data.location_history || []).forEach((point) => {
    if (!grouped.has(point.user_id)) grouped.set(point.user_id, []);
    grouped.get(point.user_id).push([point.latitude, point.longitude]);
    allPoints.push([point.latitude, point.longitude]);
  });
  grouped.forEach((points) => {
    if (points.length > 1) layers.push(L.polyline(points, { color: "#c8664f", weight: 4, opacity: 0.85, dashArray: "7 6" }));
    points.forEach((point) => layers.push(L.circleMarker(point, { radius: 4, color: "#fff", weight: 1, fillColor: "#c8664f", fillOpacity: 1 })));
  });
  if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30], maxZoom: 15 });
  if (!layers.length && data.destination) map.setView([data.destination.latitude, data.destination.longitude], 13);
  const group = L.layerGroup(layers).addTo(map);
  historyLayers.set(journey.id, group);
  showMessage(`Showing the saved route for ${journey.destination_label}.`);
}

async function exportTripKml(button) {
  const panel = button.closest("[data-collaboration-id]");
  const journey = journeys.find((item) => item.id === panel.dataset.collaborationId);
  if (!journey || !authToken) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/journeys/${journey.id}/export.kml`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || "KML export failed.");
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `geopresence-${journey.destination_label.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "trip"}.kml`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  } catch (error) {
    showMessage(error.message, true);
  } finally { button.disabled = false; }
}

async function inviteTripMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const journeyId = form.closest("[data-collaboration-id]").dataset.collaborationId;
  const feedback = form.querySelector(".trip-feedback");
  try {
    const email = new FormData(form).get("email");
    const member = await request(`/api/journeys/${journeyId}/members`, { method: "POST", body: JSON.stringify({ email }) });
    feedback.textContent = `${member.display_name} can now open this trip in their account.`;
    form.reset();
    await refreshCollaboration(journeyId);
    await loadJourneys();
  } catch (error) { feedback.textContent = error.message; }
}

async function sendTripMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const journeyId = form.closest("[data-collaboration-id]").dataset.collaborationId;
  const input = form.elements.body;
  try {
    await request(`/api/journeys/${journeyId}/messages`, { method: "POST", body: JSON.stringify({ body: input.value }) });
    input.value = "";
    await refreshCollaboration(journeyId);
  } catch (error) { form.closest(".trip-collaboration").querySelector("[data-chat-feedback]").textContent = error.message; }
}

async function toggleTripLocation(button) {
  const journeyId = button.closest("[data-collaboration-id]").dataset.collaborationId;
  if (locationWatches.has(journeyId)) {
    navigator.geolocation.clearWatch(locationWatches.get(journeyId));
    locationWatches.delete(journeyId);
    try { await request(`/api/journeys/${journeyId}/live-location`, { method: "DELETE" }); } catch (error) { showMessage(error.message, true); }
    button.textContent = "Share my live location";
    return;
  }
  if (!navigator.geolocation) { showMessage("This browser does not support location access.", true); return; }
  if (!window.confirm("Share your live location with the people on this trip? You can stop at any time.")) return;
  const watchId = navigator.geolocation.watchPosition(async (position) => {
    try {
      await request(`/api/journeys/${journeyId}/live-location`, { method: "POST", body: JSON.stringify({
        location: { latitude: position.coords.latitude, longitude: position.coords.longitude },
        accuracy_meters: position.coords.accuracy,
      }) });
    } catch (error) { showMessage(error.message, true); }
  }, (error) => showMessage(`Location sharing stopped: ${error.message}`, true), { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  locationWatches.set(journeyId, watchId);
  button.textContent = "Stop sharing my live location";
}

async function copyJourneyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    showMessage("Private location link copied. Anyone with it can view the last point you shared.");
  } catch {
    window.prompt("Copy this private location link:", url);
  }
}

async function shareJourneyLink(url) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Shared journey location", text: "View the location I shared with you.", url });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await copyJourneyLink(url);
}

async function rotateJourneyLink(button) {
  const item = button.closest(".journey-item");
  const journey = journeys.find((candidate) => candidate.id === item.dataset.id);
  if (!journey || !window.confirm("Replace this private link? Anyone with the old link will lose access.")) return;
  button.disabled = true;
  try {
    await request(`/api/journeys/${journey.id}/share-link/rotate`, { method: "POST" });
    await loadJourneys();
    showMessage("The old location link was revoked and a new link is ready to share.");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadJourneys() {
  const [configResult, newsStatus, publicIncidents] = await Promise.all([
    request("/api/config"),
    request("/api/news/status"),
    request("/api/incidents"),
  ]);
  appConfig = configResult;
  liveNewsStatus = newsStatus;
  incidents = publicIncidents;
  if (currentUser) {
    try {
      [journeys, notificationEvents] = await Promise.all([
        request("/api/journeys"),
        request("/api/notifications"),
      ]);
    } catch (error) {
      if (error.message.includes("Sign in") || error.message.includes("session")) {
        authToken = "";
        currentUser = null;
        localStorage.removeItem("geopresence_auth_token");
        renderAccount();
      } else {
        throw error;
      }
    }
  } else {
    journeys = [];
    notificationEvents = [];
  }
  journeySnapshot = journeys.map((journey) => `${journey.id}:${journey.status}:${journey.updated_at}`).join("|");
  renderNewsSyncStatus();
  threatReports = Object.fromEntries(await Promise.all(journeys.map(async (journey) => {
    try {
      const result = await request(`/api/journeys/${journey.id}/threats`);
      return [journey.id, result.reports];
    } catch {
      return [journey.id, []];
    }
  })));
  const relevantIncidentIds = new Set(Object.values(threatReports).flat().map((report) => report.id));
  const routeIncidents = incidents.filter((report) => relevantIncidentIds.has(report.id));
  renderJourneys();
  if (map) renderJourneyMarkers();
  renderIncidentFeed(routeIncidents);
  renderIncidentMarkers(routeIncidents);
}

function renderNewsSyncStatus() {
  if (!liveNewsStatus.enabled) {
    newsSyncStatusLabel.textContent = "Live news off · configure NEWS_FEED_URLS with RSS/Atom GeoRSS feeds.";
    return;
  }
  const lastSync = liveNewsStatus.last_sync_at
    ? readableReportDate(liveNewsStatus.last_sync_at)
    : "waiting for first sync";
  const errors = liveNewsStatus.errors?.length ? ` · ${liveNewsStatus.errors.length} feed error${liveNewsStatus.errors.length === 1 ? "" : "s"}` : "";
  newsSyncStatusLabel.textContent = `Live news on · last sync ${lastSync} · ${liveNewsStatus.last_added || 0} added, ${liveNewsStatus.last_skipped || 0} skipped${errors}`;
}

setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (incidentForm.contains(document.activeElement) || incidentList.contains(document.activeElement)
      || document.activeElement?.closest(".trip-collaboration")) return;
  loadJourneys().catch((error) => showMessage(`Could not refresh live reports: ${error.message}`, true));
}, 60_000);

setInterval(async () => {
  if (!currentUser || !authToken || document.visibilityState !== "visible") return;
  try {
    const latest = await request("/api/journeys", { cache: "no-store" });
    const nextSnapshot = latest.map((journey) => `${journey.id}:${journey.status}:${journey.updated_at}`).join("|");
    if (nextSnapshot !== journeySnapshot && (journeySnapshot || latest.length)) {
      const knownJourneyIds = new Set(journeySnapshot.split("|").map((item) => item.split(":")[0]));
      const hasNewSharedTrip = latest.some((journey) => !knownJourneyIds.has(journey.id));
      await loadJourneys();
      if (hasNewSharedTrip) {
        showMessage("A shared trip is now available in Shared journeys.");
      }
    } else if (!journeySnapshot) {
      journeySnapshot = nextSnapshot;
    }
  } catch {
    // The regular workspace refresh handles expired sessions and visible errors.
  }
}, 8_000);

setInterval(() => {
  if (document.visibilityState !== "visible") return;
  const selectedChatId = document.querySelector("#chat-room").dataset.collaborationId;
  const openJourneyIds = new Set([...document.querySelectorAll(".journey-item [data-collaboration-id]")].map((panel) => panel.dataset.collaborationId));
  if (selectedChatId) openJourneyIds.add(selectedChatId);
  openJourneyIds.forEach((id) => {
    const journey = journeys.find((item) => item.id === id);
    if (journey && !["ARRIVED", "CANCELLED"].includes(journey.status)) refreshCollaboration(journey.id);
  });
}, 4_000);

function renderJourneyMarkers() {
  const visibleJourneys = journeys.filter((journey) =>
    ["ACTIVE", "OVERDUE_PENDING", "OVERDUE_NOTIFIED"].includes(journey.status)
  ).slice(0, 1);
  const journeyIds = new Set(visibleJourneys.map((journey) => journey.id));
  Object.entries(markers).forEach(([key, marker]) => {
    if ((key.startsWith("journey-") || key.startsWith("origin-")) && marker && !journeyIds.has(key.split("-").slice(1).join("-"))) {
      map.removeLayer(marker);
      delete markers[key];
    }
  });
  routeLayers.forEach((layer, journeyId) => {
    if (!journeyIds.has(journeyId)) {
      map.removeLayer(layer);
      routeLayers.delete(journeyId);
    }
  });
  visibleJourneys.forEach((journey) => {
    if (!markers[`journey-${journey.id}`]) {
      markers[`journey-${journey.id}`] = L.marker([journey.destination_lat, journey.destination_lon], {
        icon: markerIcon("destination"),
      }).addTo(map).bindTooltip(escapeHtml(journey.destination_label));
    }
    if (journey.origin_lat != null && journey.origin_lon != null && !markers[`origin-${journey.id}`]) {
      markers[`origin-${journey.id}`] = L.marker([journey.origin_lat, journey.origin_lon], {
        icon: markerIcon("origin"),
      }).addTo(map).bindTooltip("Starting point");
    }
    const route = journey.route_coordinates || (journey.origin_lat == null ? null : [
      [journey.origin_lon, journey.origin_lat],
      [journey.destination_lon, journey.destination_lat],
    ]);
    if (route?.length > 1) {
      routeLayers.get(journey.id)?.remove();
      const layer = L.polyline(route.map(([longitude, latitude]) => [latitude, longitude]), {
        color: "#1e5044", weight: 4, opacity: .72, lineCap: "round",
      }).addTo(map);
      routeLayers.set(journey.id, layer);
    }
  });
}

function categoryLabel(category) {
  return category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderIncidentMarkers(reports) {
  if (!incidentLayer) return;
  incidentLayer.clearLayers();
  reports.forEach((report) => {
    const color = report.verification_status === "confirmed" ? "#a74b3d"
      : report.verification_status === "disputed" ? "#8b8f89" : "#bd7c32";
    const marker = L.circleMarker([report.latitude, report.longitude], {
      radius: 7, color: "#fffefa", weight: 2, fillColor: color, fillOpacity: .95,
    });
    const source = report.source_url
      ? `<a href="${escapeHtml(report.source_url)}" target="_blank" rel="noopener noreferrer">View source ↗</a>`
      : `${escapeHtml(report.source_type)} source`;
    const incidentTime = report.reported_at ? readableReportDate(report.reported_at) : "Event time not reported";
    const accuracy = report.location_accuracy_m == null ? "Location accuracy unknown" : `Approx. ±${report.location_accuracy_m} m`;
    const published = report.source_published_at ? readableReportDate(report.source_published_at) : "Publication time unknown";
    marker.bindPopup(`<strong>${escapeHtml(report.title)}</strong><br>${escapeHtml(categoryLabel(report.category))}<br>${escapeHtml(report.verification_status)} · event ${escapeHtml(incidentTime)}<br>Published ${escapeHtml(published)}<br>Received ${escapeHtml(readableReportDate(report.received_at))}<br>${escapeHtml(accuracy)}<br>${source}`);
    marker.addTo(incidentLayer);
  });
}

function renderIncidentFeed(reports) {
  incidentCount.textContent = reports.length;
  if (!reports.length) {
    incidentList.innerHTML = `<div class="empty-state">${journeys.length ? "No current reports match your saved journey routes." : "Create a journey to see current reports around or along its route."}</div>`;
    return;
  }
  incidentList.innerHTML = reports.map((report) => {
    const matchingReports = reports.filter((item) => item.category === report.category && item.id !== report.id);
    const controls = "";
    const legacyModeratorControls = appConfig.moderation_enabled ? `<div class="moderation-actions">
      <select data-field="status" aria-label="Set report status">
        ${["unverified", "under_review", "corroborated", "confirmed", "disputed", "expired"].map((status) => `<option value="${status}"${status === report.verification_status ? " selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}
      </select>
      <button type="button" data-report-action="update">Update</button>
      <button type="button" data-report-action="visibility">${report.is_visible ? "Hide" : "Show"}</button>
      ${matchingReports.length ? `<select data-field="duplicate" aria-label="Merge as duplicate"><option value="">Merge into…</option>${matchingReports.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}</select><button type="button" data-report-action="merge">Merge</button>` : ""}
      <button type="button" data-report-action="history">History</button>
      <details class="moderation-edit"><summary>Correct report</summary>
        <label>Title<input data-correction="title" value="${escapeHtml(report.title)}" maxlength="120"></label>
        <label>Description<textarea data-correction="description" maxlength="2000">${escapeHtml(report.description)}</textarea></label>
        <div class="correction-grid">
          <label>Category<select data-correction="category">${["robbery_report", "assault_report", "road_blockage", "civil_unrest", "flooding", "fire", "infrastructure_disruption", "other"].map((category) => `<option value="${category}"${category === report.category ? " selected" : ""}>${categoryLabel(category)}</option>`).join("")}</select></label>
          <label>Source<select data-correction="source_type">${["community", "news", "official", "field_team"].map((source) => `<option value="${source}"${source === report.source_type ? " selected" : ""}>${source.replaceAll("_", " ")}</option>`).join("")}</select></label>
        </div>
        <label>Source URL<input data-correction="source_url" type="url" value="${escapeHtml(report.source_url || "")}" maxlength="2000"></label>
        <label>Reported at<input data-correction="reported_at" type="datetime-local" value="${report.reported_at ? localInputDate(new Date(report.reported_at)) : ""}"></label>
        <label>Source published at<input data-correction="source_published_at" type="datetime-local" value="${report.source_published_at ? localInputDate(new Date(report.source_published_at)) : ""}"></label>
        <div class="correction-grid correction-coordinates">
          <label>Latitude<input data-correction="latitude" type="number" min="-90" max="90" step="any" value="${report.latitude}"></label>
          <label>Longitude<input data-correction="longitude" type="number" min="-180" max="180" step="any" value="${report.longitude}"></label>
          <label>Accuracy (m)<input data-correction="location_accuracy_m" type="number" min="0" max="100000" step="1" value="${report.location_accuracy_m ?? ""}"></label>
        </div>
        <button type="button" data-report-action="correct">Save corrections</button>
      </details>
      <pre class="moderation-history" hidden></pre>
    </div>` : "";
    const source = report.source_url
      ? `<a href="${escapeHtml(report.source_url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
      : `${escapeHtml(report.source_type)} source`;
    const eventTime = report.reported_at ? readableReportDate(report.reported_at) : "Event time unknown";
    const publicationTime = report.source_published_at ? readableReportDate(report.source_published_at) : "Publication time unknown";
    const accuracy = report.location_accuracy_m == null ? "Location accuracy unknown" : `Approx. ±${report.location_accuracy_m} m`;
    return `<article class="incident-card${report.is_visible ? "" : " is-hidden"}" data-incident-id="${escapeHtml(report.id)}" data-visible="${report.is_visible}">
      <div class="incident-card-top"><span class="report-status status-${escapeHtml(report.verification_status)}">${escapeHtml(report.verification_status.replaceAll("_", " "))}</span><span>${report.is_visible ? "Visible" : "Hidden"} · ${escapeHtml(categoryLabel(report.category))}</span></div>
      <h3>${escapeHtml(report.title)}</h3><p>${escapeHtml(report.description)}</p>
      <div class="incident-details"><span>Event · ${escapeHtml(eventTime)}</span>${report.source_published_at ? `<span>Published · ${escapeHtml(publicationTime)}</span>` : ""}<span>Received · ${escapeHtml(readableReportDate(report.received_at))}</span><span>${escapeHtml(accuracy)}</span></div>
      <div class="incident-source">${source}</div>
      ${report.duplicate_of ? '<p class="duplicate-note">Merged as a duplicate report.</p>' : ""}
      ${controls}
    </article>`;
  }).join("");
  incidentList.querySelectorAll("[data-report-action]").forEach((button) => {
    button.addEventListener("click", () => handleModerationAction(button));
  });
}

async function handleModerationAction(button) {
  const card = button.closest(".incident-card");
  const token = document.querySelector("#moderator-token").value.trim();
  if (!token) {
    setIncidentMessage("Enter the configured moderator token first.", true);
    return;
  }
  const action = button.dataset.reportAction;
  const payload = action === "visibility" ? { is_visible: card.dataset.visible !== "true" }
    : action === "merge" ? { duplicate_of: card.querySelector('[data-field="duplicate"]').value }
      : action === "correct" ? Object.fromEntries([...card.querySelectorAll("[data-correction]")].map((field) => {
        if (["latitude", "longitude", "location_accuracy_m"].includes(field.dataset.correction)) {
          return [field.dataset.correction, field.value === "" ? null : Number(field.value)];
        }
        if (field.dataset.correction === "reported_at") {
          return [field.dataset.correction, field.value ? new Date(field.value).toISOString() : null];
        }
        return [field.dataset.correction, field.value];
      }))
        : { verification_status: card.querySelector('[data-field="status"]').value };
  if (action === "merge" && !payload.duplicate_of) {
    setIncidentMessage("Choose the report to merge into.", true);
    return;
  }
  try {
    if (action === "history") {
      const history = await request(`/api/incidents/${card.dataset.incidentId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const output = card.querySelector(".moderation-history");
      output.textContent = JSON.stringify(history, null, 2);
      output.hidden = false;
      return;
    }
    await request(`/api/incidents/${card.dataset.incidentId}/moderation`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    setIncidentMessage(action === "visibility" ? `Report ${payload.is_visible ? "shown in" : "hidden from"} the public feed.`
      : action === "correct" ? "Corrections saved and added to the audit history."
        : "Moderation update recorded.");
    await loadJourneys();
  } catch (error) {
    setIncidentMessage(error.message, true);
  }
}

async function handleJourneyAction(button) {
  const item = button.closest(".journey-item");
  const journey = journeys.find((candidate) => candidate.id === item.dataset.id);
  if (!journey) return;
  button.disabled = true;
  try {
    if (button.dataset.action === "arrive") {
      let payload = {};
      if (navigator.geolocation) {
        try {
          const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8_000 }));
          payload = {
            location: { latitude: position.coords.latitude, longitude: position.coords.longitude },
            accuracy_meters: position.coords.accuracy,
          };
        } catch {
          payload = {};
        }
      }
      await request(`/api/journeys/${journey.id}/arrive`, { method: "POST", body: JSON.stringify(payload) });
      showMessage(payload.location
        ? "Arrival confirmed and your location was saved once for this journey. There is no live tracking."
        : "Arrival confirmed. Location was not saved; location access may have been unavailable.");
    } else if (button.dataset.action === "undo-arrive") {
      await request(`/api/journeys/${journey.id}/undo-arrive`, { method: "POST" });
      showMessage("Arrival confirmation undone. The journey is active again.");
    } else if (button.dataset.action === "share-location") {
      if (!navigator.geolocation) throw new Error("This browser does not support location access.");
      if (!window.confirm("Save your current location once? The latest point will be visible to anyone with this journey’s private link until you replace the link or cancel the journey.")) return;
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 }));
      await request(`/api/journeys/${journey.id}/location`, {
        method: "POST",
        body: JSON.stringify({
          location: { latitude: position.coords.latitude, longitude: position.coords.longitude },
          accuracy_meters: position.coords.accuracy,
        }),
      });
      showMessage("One location and its timestamp were saved to this journey. No live tracking or contact notification was started.");
    } else if (button.dataset.action === "extend") {
      const nextEta = new Date(new Date(journey.eta).getTime() + 30 * 60 * 1000);
      await request(`/api/journeys/${journey.id}/eta`, { method: "PATCH", body: JSON.stringify({ eta: nextEta.toISOString() }) });
      showMessage("ETA extended by 30 minutes.");
    } else if (button.dataset.action === "cancel") {
      if (!window.confirm(`Cancel the journey to ${journey.destination_label}?`)) return;
      await request(`/api/journeys/${journey.id}/cancel`, { method: "POST" });
      showMessage("Journey cancelled.");
    }
    await loadJourneys();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) {
    showMessage("Sign in to create a private journey.", true);
    showAuthDialog("login");
    return;
  }
  if (!points.origin || !points.destination) {
    showMessage("Select a starting point and destination on the map first.", true);
    return;
  }
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  showMessage("Creating your journey…");
  const values = new FormData(form);
  const payload = {
    origin: points.origin,
    destination: points.destination,
    destination_label: values.get("destination_label"),
    departure_at: new Date(values.get("departure_at")).toISOString(),
    contact_name: values.get("contact_name"),
    contact_email: values.get("contact_email"),
  };
  try {
    await request("/api/journeys", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    document.querySelector("#departure-at").value = localInputDate(new Date());
    tripEstimate.textContent = "Choose a starting point and destination to calculate the arrival time and extended time.";
    points.destination = null;
    points.origin = null;
    ["origin", "destination"].forEach((key) => {
      if (markers[key] && map) map.removeLayer(markers[key]);
      markers[key] = null;
    });
    coordinateReadout.textContent = "No destination selected yet";
    coordinateReadout.classList.remove("has-point");
    await loadJourneys();
    showMessage("Journey created. Your contact will only be notified if the check-in becomes overdue.");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

function switchView(view) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document.querySelectorAll(".nav-tab, .report-nav-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  if (view === "report") {
    activePick = "incident";
    document.querySelectorAll("[data-pick]").forEach((button) => button.classList.toggle("is-selected", button.dataset.pick === activePick));
    searchTargetLabel.textContent = "Setting report location";
  }
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});
document.querySelector("#chat-trip-select").addEventListener("change", selectChatJourney);
document.querySelector("#chat-room .trip-chat-form").addEventListener("submit", sendTripMessage);

authTrigger.addEventListener("click", () => showAuthDialog("login"));
document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelectorAll("[data-close-auth]").forEach((button) => button.addEventListener("click", hideAuthDialog));
document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));

async function submitAuth(event, path) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = formElement.querySelector("[type=submit]");
  const payload = Object.fromEntries(new FormData(formElement));
  submit.disabled = true;
  authMessage.textContent = path.endsWith("signup") ? "Creating your account..." : "Signing you in...";
  authMessage.classList.remove("is-error");
  try {
    await establishSession(await request(path, { method: "POST", body: JSON.stringify(payload) }));
  } catch (error) {
    authMessage.textContent = error.message;
    authMessage.classList.add("is-error");
  } finally {
    submit.disabled = false;
  }
}

document.querySelector("#login-form").addEventListener("submit", (event) => submitAuth(event, "/api/auth/login"));
document.querySelector("#signup-form").addEventListener("submit", (event) => submitAuth(event, "/api/auth/signup"));

async function restoreSession() {
  renderAccount();
  if (authToken) {
    try {
      currentUser = await request("/api/auth/me");
    } catch {
      authToken = "";
      localStorage.removeItem("geopresence_auth_token");
    }
  }
  renderAccount();
  await loadJourneys();
}

initMap();
restoreSession().catch((error) => showMessage(`Could not load workspace: ${error.message}`, true));

