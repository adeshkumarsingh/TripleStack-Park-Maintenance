// TripleStack Park Maintenance Tracker
// Configure the Supabase URL and anon/publishable key below.
// Never put a service_role or secret key in browser code.

const SUPABASE_URL = "https://xuwykworsckaonlhdjdx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_vSIGoQ-ZYQWTO1_TajgqBA_KhSGHMrR";
const STORAGE_BUCKET = "issue-photos";
const REPORTER_KEY_STORAGE = "triplestack.reporter-key.v1";
const FEEDBACK_TOKEN_PREFIX = "triplestack.feedback-token.";
const PAGE_SIZE = 500;
const SIGNED_URL_SECONDS = 600;

let db = null;
let parks = [];
let complaints = [];
let currentAdmin = null;
let feedbackRating = 0;
let siteFeedbackRating = 0;
let siteFeedbackRows = [];
let toastTimer = null;
let capturedLocation = null;
let previousFocusedElement = null;
let realtimeChannel = null;
let signedUrlCache = new Map();

const $ = (id) => document.getElementById(id);
const statusLabel = (status) => ({ submitted: "Submitted", assigned: "Assigned", in_progress: "In progress", resolved: "Resolved" }[status] || status);
const dateLabel = (value) => value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
const safe = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const safeHttpUrl = (value = "") => /^https:\/\//i.test(String(value)) ? safe(value) : "";

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
}

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  previousFocusedElement = document.activeElement;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modal.querySelector("input:not([type=hidden]), select, textarea, button")?.focus({ preventScroll: true });
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-backdrop.open")) {
    document.body.style.overflow = "";
    if (previousFocusedElement instanceof HTMLElement) previousFocusedElement.focus({ preventScroll: true });
    previousFocusedElement = null;
  }
}

function configured() {
  return SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20 && !SUPABASE_URL.includes("YOUR_");
}

function initSupabase() {
  if (!configured()) {
    toast("Setup needed: add your Supabase URL and anon key in app.js.");
    return false;
  }
  if (!window.supabase?.createClient) {
    toast("The database library could not load. Check your internet connection.");
    return false;
  }
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

async function fetchAllPages(queryFactory) {
  const allRows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data || [];
    allRows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return allRows;
}

async function signComplaintPhotos(rows) {
  const paths = [...new Set(rows.flatMap((row) => [row.photo_path, row.resolution_photo_path]).filter(Boolean))];
  const now = Date.now();
  const uncachedPaths = paths.filter((path) => {
    const cached = signedUrlCache.get(path);
    return !cached || cached.expiresAt <= now + 30_000;
  });
  for (let index = 0; index < uncachedPaths.length; index += 20) {
    const batch = uncachedPaths.slice(index, index + 20);
    await Promise.all(batch.map(async (path) => {
      try {
        const { data, error } = await db.storage.from(STORAGE_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
        if (error) {
          console.warn("Could not create a temporary photo URL:", error.message);
          signedUrlCache.delete(path);
          return;
        }
        signedUrlCache.set(path, {
          url: data.signedUrl,
          expiresAt: now + SIGNED_URL_SECONDS * 1000 - 30_000
        });
      } catch (error) {
        console.warn("Temporary photo URL request failed:", error);
        signedUrlCache.delete(path);
      }
    }));
  }

  return rows.map((row) => ({
    ...row,
    park_name: row.park_name || row.parks?.name || "Park",
    photo_url: row.photo_path ? signedUrlCache.get(row.photo_path)?.url || "" : "",
    resolution_photo_url: row.resolution_photo_path ? signedUrlCache.get(row.resolution_photo_path)?.url || "" : ""
  }));
}

async function loadData() {
  if (!db) {
    render();
    return;
  }

  try {
    const parkPromise = db.from("parks").select("id,name,description,active").eq("active", true).order("name");
    const complaintPromise = currentAdmin
      ? fetchAllPages(() => db.from("complaints")
          .select("id,park_id,park_name,category,title,location,description,photo_path,latitude,longitude,status,assigned_staff,resolution_notes,resolution_photo_path,created_at,resolved_at,parks(name)")
          .order("created_at", { ascending: false }).order("id", { ascending: true }))
      : fetchAllPages(() => db.from("public_complaints").select("*").order("created_at", { ascending: false }).order("id", { ascending: true }));

    const [parkResult, complaintRows] = await Promise.all([parkPromise, complaintPromise]);
    if (parkResult.error) throw parkResult.error;
    parks = parkResult.data || [];
    complaints = await signComplaintPhotos(complaintRows);
    render();
  } catch (error) {
    console.error("Data loading error:", error);
    toast("Could not load the latest data. Check Supabase permissions and schema.sql.");
    complaints = [];
    render();
  }
}

function filteredComplaints() {
  const status = $("statusFilter").value;
  const query = $("searchInput").value.trim().toLowerCase();
  return complaints.filter((complaint) => {
    const complaintPark = String(complaint.park_name || complaint.parks?.name || "").trim().toLowerCase();
    const haystack = [complaint.title, complaint.category, complaint.location, complaint.description, complaintPark].join(" ").toLowerCase();
    return (!status || complaint.status === status) && (!query || haystack.includes(query));
  });
}

function mapUrl(latitude, longitude) {
  if (latitude === null || latitude === undefined || latitude === "" ||
      longitude === null || longitude === undefined || longitude === "") return "";
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

function renderRequests() {
  const rows = filteredComplaints();
  $("visibleCount").textContent = `${rows.length} ${rows.length === 1 ? "request" : "requests"}`;
  const grid = $("requestGrid");

  if (!rows.length) {
    grid.innerHTML = '<div class="empty-state">No requests found. Try another filter or report the first issue.</div>';
    return;
  }

  grid.innerHTML = rows.map((complaint) => {
    const photoUrl = safeHttpUrl(complaint.photo_url);
    const photo = photoUrl ? `<img class="request-photo" src="${photoUrl}" alt="Photo evidence for this request" loading="lazy" />` : "";
    const resolutionPhotoUrl = safeHttpUrl(complaint.resolution_photo_url);
    const resolutionPhoto = resolutionPhotoUrl ? `<img class="request-photo" src="${resolutionPhotoUrl}" alt="Resolution evidence" loading="lazy" />` : "";
    const resolution = complaint.resolution_notes ? `<div class="resolution-note">✓ ${safe(complaint.resolution_notes)}</div>` : "";
    const staff = currentAdmin && complaint.assigned_staff ? `<div class="meta">Assigned to: ${safe(complaint.assigned_staff)}</div>` : "";
    const manageButton = currentAdmin ? `<button class="btn btn-quiet" data-manage="${safe(complaint.id)}" type="button">Manage</button>` : "";
    const feedbackButton = !currentAdmin && complaint.status === "resolved" && !complaint.has_feedback && hasFeedbackToken(complaint.id)
      ? `<button class="btn btn-primary" data-feedback="${safe(complaint.id)}" data-title="${safe(complaint.title)}" type="button">Give feedback</button>`
      : "";
    const url = mapUrl(complaint.latitude, complaint.longitude);
    const locationLink = currentAdmin && url ? `<a class="map-link" href="${safe(url)}" target="_blank" rel="noopener noreferrer">View pinned location ↗</a>` : "";
    return `<article class="request-card">
      <div class="card-top"><span class="category-pill">${safe(complaint.category)}</span><span class="status-pill ${safe(complaint.status)}">${safe(statusLabel(complaint.status))}</span></div>
      <h3>${safe(complaint.title)}</h3>
      <p>${safe(complaint.description)}</p>
      <div class="meta">${safe(complaint.park_name || complaint.parks?.name || "Park")} · ${safe(complaint.location)} · ${dateLabel(complaint.created_at)}</div>
      ${locationLink}${staff}${photo}${resolution}${resolutionPhoto}
      <div class="card-actions">${manageButton}${feedbackButton}</div>
    </article>`;
  }).join("");

  grid.querySelectorAll("[data-manage]").forEach((button) => button.addEventListener("click", () => showManage(button.dataset.manage)));
  grid.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", () => showFeedback(button.dataset.feedback, button.dataset.title)));
}

function renderAnalytics() {
  const total = complaints.length;
  const submitted = complaints.filter((item) => item.status === "submitted").length;
  const assigned = complaints.filter((item) => item.status === "assigned").length;
  const inProgress = complaints.filter((item) => item.status === "in_progress").length;
  const progress = assigned + inProgress;
  const resolved = complaints.filter((item) => item.status === "resolved").length;

  $("totalCount").textContent = total;
  $("submittedCount").textContent = submitted;
  $("progressCount").textContent = progress;
  $("resolvedCount").textContent = resolved;

  const counts = {};
  complaints.forEach((item) => { counts[item.category] = (counts[item.category] || 0) + 1; });
  const max = Math.max(1, ...Object.values(counts));
  $("categoryChart").innerHTML = Object.keys(counts).length
    ? Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([category, count]) => `<div class="bar-row"><span>${safe(category)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div><b>${count}</b></div>`).join("")
    : '<p class="muted">No request data yet.</p>';

  $("statusSummary").innerHTML = [["Submitted", submitted], ["Assigned", assigned], ["In progress", inProgress], ["Resolved", resolved]]
    .map(([label, count]) => `<div class="status-box"><b>${count}</b><small>${label}</small></div>`).join("");
}

function render() {
  renderRequests();
  renderAnalytics();
}

function createSecureToken() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("This browser does not support secure report tokens. Use an updated browser over HTTPS.");
  }
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

function getReporterKey() {
  try {
    let key = localStorage.getItem(REPORTER_KEY_STORAGE);
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem(REPORTER_KEY_STORAGE, key);
    }
    return key;
  } catch {
    throw new Error("Browser storage is unavailable. Enable site storage to submit and track a report.");
  }
}

function feedbackTokenFor(id) {
  try {
    return localStorage.getItem(`${FEEDBACK_TOKEN_PREFIX}${id}`);
  } catch {
    return null;
  }
}

function hasFeedbackToken(id) {
  return Boolean(feedbackTokenFor(id));
}

async function uploadPhoto(file, options = {}) {
  if (!file) return null;
  if (file.size > 5 * 1024 * 1024) throw new Error("Photo must be 5 MB or smaller.");
  const allowedTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = allowedTypes[file.type];
  if (!extension) throw new Error("Please select a JPG, PNG or WEBP image.");
  if (!db) throw new Error("The online database is not connected.");

  let path;
  if (options.admin) {
    if (!currentAdmin) throw new Error("An approved administrator account is required to upload resolution evidence.");
    path = `staff/${currentAdmin.id}/${crypto.randomUUID()}.${extension}`;
  } else {
    if (!options.reporterKey) throw new Error("A report identity is required before uploading a photo.");
    const { data, error } = await db.rpc("create_photo_upload_intent", {
      p_reporter_key: options.reporterKey,
      p_extension: extension
    });
    if (error) throw error;
    path = data;
  }

  const { error } = await db.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: "300", upsert: false, contentType: file.type
  });
  if (error) {
    if (!options.admin) {
      const { error: cleanupError } = await db.storage.from(STORAGE_BUCKET).remove([path]);
      if (!cleanupError) {
        await db.rpc("cancel_photo_upload_intent", {
          p_reporter_key: options.reporterKey,
          p_object_path: path
        });
      }
    }
    throw error;
  }
  return path;
}

function getCurrentLocation() {
  const button = $("useCurrentLocationBtn");
  const status = $("locationStatus");
  capturedLocation = null;
  if (!navigator.geolocation) {
    status.textContent = "This browser does not support GPS. You can still submit the park name.";
    status.className = "location-status error";
    return;
  }

  button.disabled = true;
  button.textContent = "Finding location…";
  status.textContent = "Waiting for browser permission and GPS…";
  status.className = "location-status";

  navigator.geolocation.getCurrentPosition((position) => {
    capturedLocation = {
      latitude: Number(position.coords.latitude.toFixed(6)),
      longitude: Number(position.coords.longitude.toFixed(6))
    };
    status.textContent = "GPS location captured and will be attached to your report.";
    status.className = "location-status success";
    button.disabled = false;
    button.innerHTML = '<span aria-hidden="true">✓</span> Location added';
  }, (error) => {
    const messages = {
      1: "GPS permission denied. You can still submit using the park name.",
      2: "GPS location unavailable. You can still submit your report.",
      3: "GPS timed out. You can still submit your report."
    };
    status.textContent = messages[error.code] || "GPS unavailable. You can still submit your report.";
    status.className = "location-status error";
    button.disabled = false;
    button.innerHTML = '<span aria-hidden="true">⌖</span> Try GPS again';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

async function submitComplaint(event) {
  event.preventDefault();
  if (!db) { toast("Connect Supabase first. Follow the setup guide in README."); return; }

  const button = $("submitReportBtn");
  let uploadedPath = null;
  let activeReporterKey = null;
  let complaintCreated = false;
  let feedbackTokenSaved = true;
  button.disabled = true;
  button.textContent = "Submitting…";

  try {
    const parkName = $("reportPark").value.trim();
    const category = $("reportCategory").value;
    const location = $("reportLocation").value.trim();
    const description = $("reportDescription").value.trim();
    if (parkName.length < 2 || parkName.length > 120) throw new Error("Enter a park name between 2 and 120 characters.");
    if (!category) throw new Error("Please select an issue category.");
    if (location.length > 140) throw new Error("Location details must be 140 characters or fewer.");
    if (description.length < 5 || description.length > 1200) throw new Error("Describe the issue using 5 to 1,200 characters.");

    const reporterKey = getReporterKey();
    activeReporterKey = reporterKey;
    const feedbackToken = createSecureToken();
    const file = $("reportPhoto").files[0];
    uploadedPath = await uploadPhoto(file, { reporterKey });

    const { data: complaintId, error } = await db.rpc("submit_public_complaint", {
      p_reporter_key: reporterKey,
      p_feedback_token: feedbackToken,
      p_park_id: parks.find((item) => item.name.trim().toLowerCase() === parkName.toLowerCase())?.id ?? null,
      p_park_name: parkName,
      p_category: category,
      p_location: location || (capturedLocation ? "GPS location" : "Not specified"),
      p_description: description,
      p_latitude: capturedLocation?.latitude ?? null,
      p_longitude: capturedLocation?.longitude ?? null,
      p_photo_path: uploadedPath
    });
    if (error) throw error;
    complaintCreated = true;

    try {
      localStorage.setItem(`${FEEDBACK_TOKEN_PREFIX}${complaintId}`, feedbackToken);
    } catch {
      feedbackTokenSaved = false;
    }

    $("reportForm").reset();
    capturedLocation = null;
    gpsRequestActive = false;
    $("locationStatus").textContent = "GPS is captured automatically when permission is granted. You can still report without GPS.";
    $("locationStatus").className = "location-status";
    $("useCurrentLocationBtn").disabled = false;
    $("useCurrentLocationBtn").innerHTML = '<span aria-hidden="true">⌖</span> Try GPS again';
    closeModal("reportModal");
    toast(feedbackTokenSaved
      ? "Your report has been submitted successfully."
      : "Report submitted. Browser storage could not save your feedback key, so feedback will not be available later.");
    await loadData();
  } catch (error) {
    console.error("Complaint submission error:", error);
    if (uploadedPath && !complaintCreated) {
      const { error: cleanupError } = await db.storage.from(STORAGE_BUCKET).remove([uploadedPath]);
      if (cleanupError) {
        console.warn("Temporary photo cleanup may be needed:", cleanupError.message);
      } else if (activeReporterKey) {
        await db.rpc("cancel_photo_upload_intent", { p_reporter_key: activeReporterKey, p_object_path: uploadedPath });
      }
    }
    toast(error.message || "Could not submit the report.");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Submit report <span aria-hidden="true">↗</span>';
  }
}

async function submitSiteFeedback(event) {
  event.preventDefault();
  if (!db) return toast("Connect Supabase first.");
  if (!siteFeedbackRating) return toast("Please select a star rating.");
  const comment = $("siteFeedbackComment").value.trim();
  if (!comment) return toast("Please enter your feedback.");
  try {
    const { error } = await db.rpc("submit_site_feedback", {
      p_reporter_key: getReporterKey(),
      p_topic: $("siteFeedbackTopic").value,
      p_rating: siteFeedbackRating,
      p_comment: comment
    });
    if (error) throw error;
    closeModal("siteFeedbackModal");
    $("siteFeedbackForm").reset();
    siteFeedbackRating = 0;
    document.querySelectorAll("#siteStarPicker button").forEach((star) => { star.classList.remove("active"); star.setAttribute("aria-checked", "false"); });
    toast("Thank you. Your feedback has been submitted.");
  } catch (error) {
    console.error("Website feedback submission error:", error);
    toast(error.message || "Could not submit feedback. Please try again.");
  }
}

async function loadSiteFeedback() {
  if (!db || !currentAdmin) return;
  $("siteFeedbackList").innerHTML = '<p class="muted">Loading feedback…</p>';
  const { data, error } = await db.from("site_feedback").select("id,topic,rating,comment,created_at").order("created_at", { ascending: false }).limit(100);
  if (error) {
    console.error("Admin feedback load error:", error);
    $("siteFeedbackList").innerHTML = '<p class="muted">Could not load feedback. Check that the latest schema.sql has been applied.</p>';
    return;
  }
  siteFeedbackRows = data || [];
  $("siteFeedbackList").innerHTML = siteFeedbackRows.length ? siteFeedbackRows.map((item) => `<article class="site-feedback-card"><div class="site-feedback-top"><strong>${safe(item.topic)}</strong><span class="site-feedback-stars" aria-label="${item.rating} out of 5 stars">${"★".repeat(item.rating)}${"☆".repeat(5-item.rating)}</span></div><p>${safe(item.comment)}</p><small>${dateLabel(item.created_at)}</small></article>`).join("") : '<p class="muted">No website feedback has been submitted yet.</p>';
}

function showFeedback(id, title) {
  if (!hasFeedbackToken(id)) {
    toast("For privacy, only the browser used to submit this report can leave feedback.");
    return;
  }
  feedbackRating = 0;
  $("feedbackComplaintId").value = id;
  $("feedbackIssueTitle").textContent = title;
  document.querySelectorAll("#starPicker button").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-checked", "false");
    button.tabIndex = Number(button.dataset.rating) === 1 ? 0 : -1;
  });
  openModal("feedbackModal");
}

async function submitFeedback(event) {
  event.preventDefault();
  if (!db) return toast("The database is not connected.");
  if (!feedbackRating) return toast("Please select a star rating.");
  const id = $("feedbackComplaintId").value;
  const token = feedbackTokenFor(id);
  if (!token) return toast("The private feedback key is unavailable in this browser.");

  try {
    const { error } = await db.rpc("submit_feedback", {
      p_complaint_id: id,
      p_feedback_token: token,
      p_rating: feedbackRating,
      p_comment: $("feedbackComment").value.trim()
    });
    if (error) throw error;
    try { localStorage.removeItem(`${FEEDBACK_TOKEN_PREFIX}${id}`); } catch { /* storage may be disabled */ }
    closeModal("feedbackModal");
    $("feedbackForm").reset();
    toast("Thank you for your feedback.");
    await loadData();
  } catch (error) {
    console.error("Feedback submission error:", error);
    toast(error.message || "Could not submit feedback. Please try again.");
  }
}

function showManage(id) {
  const complaint = complaints.find((item) => item.id === id);
  if (!complaint) return;
  $("manageComplaintId").value = id;
  $("manageIssueTitle").textContent = complaint.title;
  $("assignedStaff").value = complaint.assigned_staff || "";
  $("manageStatus").value = complaint.status;
  $("resolutionNotes").value = complaint.resolution_notes || "";
  $("resolutionPhoto").value = "";
  $("managementHistory").textContent = "Loading activity…";
  openModal("manageModal");
  loadManagementHistory(id);
}

async function loadManagementHistory(complaintId) {
  const target = $("managementHistory");
  if (!target || !currentAdmin) return;
  const { data, error } = await db.from("complaint_activity")
    .select("created_at,actor_user_id,old_status,new_status,changes")
    .eq("complaint_id", complaintId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    target.textContent = "Activity history is unavailable.";
    console.warn("Activity history error:", error);
    return;
  }
  if (!data?.length) {
    target.textContent = "No staff changes recorded yet.";
    return;
  }
  target.innerHTML = data.map((entry) => {
    const changeLabels = Object.keys(entry.changes || {}).map((key) => ({
      status: "Status updated",
      assigned_staff: "Staff assignment updated",
      resolution_notes: "Resolution notes updated",
      resolution_photo: "Resolution photo updated"
    }[key] || "Request updated"));
    const when = new Date(entry.created_at).toLocaleString();
    const status = entry.old_status !== entry.new_status
      ? ` · ${safe(statusLabel(entry.old_status))} → ${safe(statusLabel(entry.new_status))}`
      : "";
    return `<div class="history-entry"><b>${safe(changeLabels.join(", ") || "Request updated")}</b><small>${safe(when)}${status}</small></div>`;
  }).join("");
}

async function saveManagement(event) {
  event.preventDefault();
  if (!currentAdmin) return toast("Please sign in with an approved administrator account.");
  const id = $("manageComplaintId").value;
  const status = $("manageStatus").value;
  const existing = complaints.find((item) => item.id === id);
  let newPhotoPath = null;

  try {
    const file = $("resolutionPhoto").files[0];
    if (file) newPhotoPath = await uploadPhoto(file, { admin: true });
    const payload = {
      assigned_staff: $("assignedStaff").value.trim() || null,
      status,
      resolution_notes: $("resolutionNotes").value.trim() || null,
      resolved_at: status === "resolved" ? (existing?.resolved_at || new Date().toISOString()) : null
    };
    if (newPhotoPath) payload.resolution_photo_path = newPhotoPath;

    const { error } = await db.from("complaints").update(payload).eq("id", id);
    if (error) throw error;

    if (newPhotoPath && existing?.resolution_photo_path) {
      const { error: cleanupError } = await db.storage.from(STORAGE_BUCKET).remove([existing.resolution_photo_path]);
      if (cleanupError) console.warn("Old resolution photo could not be removed:", cleanupError.message);
    }
    closeModal("manageModal");
    toast("Request updated.");
    await loadData();
  } catch (error) {
    if (newPhotoPath) {
      const { error: cleanupError } = await db.storage.from(STORAGE_BUCKET).remove([newPhotoPath]);
      if (cleanupError) console.warn("Failed resolution upload may need cleanup:", cleanupError.message);
    }
    console.error("Request update error:", error);
    toast(error.message || "Could not update the request.");
  }
}

async function verifyAdmin(user) {
  if (!user || !db) return false;
  const { data, error } = await db.rpc("is_park_admin");
  if (error) {
    console.error("Admin verification error:", error);
    return false;
  }
  return data === true;
}

function updateAdminButton() {
  $("adminFeedbackSection").hidden = !currentAdmin;
  $("adminLoginBtn").textContent = currentAdmin ? "Admin sign out" : "Admin Login";
  $("adminLoginBtn").disabled = false;
  $("mobileAdminLogin").textContent = currentAdmin ? "Admin sign out" : "Admin Login";
}

async function adminLogin(event) {
  event.preventDefault();
  if (!db) return toast("Connect Supabase first.");
  try {
    const { data, error } = await db.auth.signInWithPassword({
      email: $("adminEmail").value,
      password: $("adminPassword").value
    });
    if (error) throw error;

    const allowed = await verifyAdmin(data.user);
    if (!allowed) {
      await db.auth.signOut();
      toast("This account is not approved for administrator access. Add its user ID to admin_users.");
      return;
    }

    currentAdmin = data.user;
    updateAdminButton();
    closeModal("adminModal");
    toast("Admin sign-in successful.");
    await loadData();
    await loadSiteFeedback();
    startAdminRealtime();
  } catch (error) {
    console.error("Admin sign-in error:", error);
    toast(error.message || "Could not sign in. Check your connection and try again.");
  }
}

async function adminLogout() {
  if (db) {
    const { error } = await db.auth.signOut();
    if (error) return toast(error.message);
  }
  await stopAdminRealtime();
  currentAdmin = null;
  updateAdminButton();
  closeModal("manageModal");
  await loadData();
  $("adminFeedbackSection").hidden = true;
  toast("Signed out.");
}

async function refreshOneComplaint(payload) {
  const changed = payload.eventType === "DELETE" ? payload.old : payload.new;
  const id = changed?.id;
  if (!id) return;
  if (payload.eventType === "DELETE") {
    complaints = complaints.filter((item) => item.id !== id);
    render();
    return;
  }

  const source = db.from("complaints").select(
    "id,park_id,category,title,location,description,photo_path,latitude,longitude,status,assigned_staff,resolution_notes,resolution_photo_path,created_at,resolved_at,parks(name)"
  ).eq("id", id).maybeSingle();
  const { data, error } = await source;
  if (error) {
    console.warn("Realtime row refresh failed:", error);
    return;
  }
  if (!data) return;
  const [hydrated] = await signComplaintPhotos([data]);
  const index = complaints.findIndex((item) => item.id === id);
  if (index >= 0) complaints[index] = hydrated;
  else complaints.unshift(hydrated);
  complaints.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  render();
}

function startAdminRealtime() {
  if (!db || !currentAdmin || realtimeChannel) return;
  realtimeChannel = db.channel("admin-complaint-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "complaints" }, refreshOneComplaint)
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.warn("Admin realtime subscription failed.");
    });
}

async function stopAdminRealtime() {
  if (!db || !realtimeChannel) return;
  const channel = realtimeChannel;
  realtimeChannel = null;
  await db.removeChannel(channel);
}

function bindEvents() {
  ["reportTopBtn", "reportHeroBtn"].forEach((id) => $(id).addEventListener("click", () => {
    openModal("reportModal");
    getCurrentLocation();
  }));
  $("siteFeedbackBtn").addEventListener("click", () => openModal("siteFeedbackModal"));
  $("mobileFeedbackLink").addEventListener("click", (event) => { event.preventDefault(); $("topbar").classList.remove("menu-open"); openModal("siteFeedbackModal"); });
  $("refreshSiteFeedbackBtn").addEventListener("click", loadSiteFeedback);
  $("adminLoginBtn").addEventListener("click", () => currentAdmin ? adminLogout() : openModal("adminModal"));
  $("useCurrentLocationBtn").addEventListener("click", getCurrentLocation);

  $("mobileMenu").addEventListener("click", () => {
    const open = $("topbar").classList.toggle("menu-open");
    $("mobileMenu").setAttribute("aria-expanded", String(open));
    $("mobileMenu").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  document.querySelectorAll("#mainNav a").forEach((link) => link.addEventListener("click", (event) => {
    if (link.id === "mobileAdminLogin") {
      event.preventDefault();
      if (currentAdmin) adminLogout();
      else openModal("adminModal");
    }
    $("topbar").classList.remove("menu-open");
    $("mobileMenu").setAttribute("aria-expanded", "false");
  }));

  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  document.querySelectorAll(".modal-backdrop").forEach((modal) => modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal(modal.id);
  }));
  document.addEventListener("keydown", (event) => {
    const openModalElement = document.querySelector(".modal-backdrop.open");
    if (event.key === "Escape") {
      document.querySelectorAll(".modal-backdrop.open").forEach((modal) => closeModal(modal.id));
      $("topbar").classList.remove("menu-open");
      $("mobileMenu").setAttribute("aria-expanded", "false");
      return;
    }
    if (event.key === "Tab" && openModalElement) {
      const focusable = [...openModalElement.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  });

  $("reportForm").addEventListener("submit", submitComplaint);
  $("feedbackForm").addEventListener("submit", submitFeedback);
  $("siteFeedbackForm").addEventListener("submit", submitSiteFeedback);
  $("manageForm").addEventListener("submit", saveManagement);
  $("adminLoginForm").addEventListener("submit", adminLogin);
  $("adminLogoutBtn").addEventListener("click", adminLogout);
  ["statusFilter", "searchInput"].forEach((id) => $(id).addEventListener(id === "searchInput" ? "input" : "change", renderRequests));
  document.querySelectorAll("#siteStarPicker button").forEach((button) => button.addEventListener("click", () => {
    siteFeedbackRating = Number(button.dataset.siteRating);
    document.querySelectorAll("#siteStarPicker button").forEach((star) => {
      const selected = Number(star.dataset.siteRating) <= siteFeedbackRating;
      star.classList.toggle("active", selected);
      star.setAttribute("aria-checked", String(Number(star.dataset.siteRating) === siteFeedbackRating));
    });
  }));
  document.querySelectorAll("#starPicker button").forEach((button) => button.addEventListener("click", () => {
    feedbackRating = Number(button.dataset.rating);
    document.querySelectorAll("#starPicker button").forEach((star) => {
      const selected = Number(star.dataset.rating) <= feedbackRating;
      star.classList.toggle("active", selected);
      const isSelected = Number(star.dataset.rating) === feedbackRating;
      star.setAttribute("aria-checked", String(isSelected));
      star.tabIndex = isSelected ? 0 : -1;
    });
  }));
  document.querySelectorAll("#starPicker button").forEach((button) => button.addEventListener("keydown", (event) => {
    const current = Number(button.dataset.rating);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(5, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(1, current - 1);
    else if (event.key === "Home") next = 1;
    else if (event.key === "End") next = 5;
    else return;
    event.preventDefault();
    const target = document.querySelector(`#starPicker button[data-rating="${next}"]`);
    target?.click();
    target?.focus();
  }));
}

async function restoreAdminSession() {
  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    const user = data?.session?.user;
    if (user && await verifyAdmin(user)) currentAdmin = user;
    else if (user) await db.auth.signOut();
  } catch (error) {
    console.error("Session restore error:", error);
    toast("Could not restore the admin session. Please sign in again.");
  }
  updateAdminButton();
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  if (!initSupabase()) {
    renderAnalytics();
    $("visibleCount").textContent = "Database setup needed";
    $("requestGrid").innerHTML = '<div class="empty-state">Connect your Supabase project to load and save live requests. Follow the setup guide in README.</div>';
    return;
  }

  await restoreAdminSession();
  updateAdminButton();
  await loadData();
  if (currentAdmin) { await loadSiteFeedback(); startAdminRealtime(); }
  // Public visitors refresh the safe projection periodically. They never subscribe
  // to raw complaint row events, which contain staff-only fields. This timer also
  // remains available if an administrator signs out later in the same page session.
  window.setInterval(() => {
    if (!document.hidden && !currentAdmin) loadData();
  }, 60_000);
});
