/* =====================================================================
   STREET 0.3 — application logic
   Backend: Firebase (Authentication, Cloud Firestore, Cloud Storage)

   >>>>>>>>>>>>>>>>>> WHERE TO ADD DATABASE CONFIGURATION <<<<<<<<<<<<<<<<
   Paste your Firebase project config into FIREBASE_CONFIG below.
   Get it from: Firebase Console -> Project settings -> General ->
   "Your apps" -> Web app -> SDK setup and configuration -> Config.
   Firebase Storage (for photos/videos) is configured automatically
   from the same project — you just need to enable it in the console
   (Build -> Storage -> Get started).
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, startAt, endAt,
  onSnapshot, getDocs, serverTimestamp, increment, arrayUnion,
  arrayRemove, writeBatch, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

/* >>>>>>>>>>>>>>>>>> WHERE TO ADD DATABASE CONFIGURATION <<<<<<<<<<<<<<< */
const FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};
/* >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> */

const fbApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const storage = getStorage(fbApp);
setPersistence(auth, browserLocalPersistence); // keeps user logged in after refresh

const AUTH_EMAIL_DOMAIN = "@street.app"; // synthetic email so Firebase Auth (email-based) can work with plain usernames

/* ===================== STATE ===================== */
let currentUser = null;      // Firebase auth user
let currentUserDoc = null;   // Firestore users/{uid} data
let activeScreen = "home";
let activeChatConvId = null;
let activeChatOtherUser = null;
let viewingProfileUid = null;
let createMedia = { file: null, type: null };
let storiesCache = [];
let storyIndex = 0;
let storyTimer = null;
let unsubscribers = []; // live listeners to tear down on logout

/* ===================== HELPERS ===================== */
const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function usernameToEmail(u) { return `${u.toLowerCase()}${AUTH_EMAIL_DOMAIN}`; }
function timeAgo(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 604800) return Math.floor(s / 86400) + "d";
  return d.toLocaleDateString();
}
function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function convIdFor(a, b) { return [a, b].sort().join("_"); }
function placeholderAvatar(name) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23191927'/><text x='50%' y='55%' font-size='34' fill='%236c78ff' text-anchor='middle' font-family='Arial' dy='.1em'>${initial}</text></svg>`;
  return `data:image/svg+xml,${svg}`;
}

/* ===================== TAB / SCREEN NAVIGATION ===================== */
const screens = ["home", "search", "create", "messages", "profile", "connections", "edit-profile", "notifications", "admin"];
function showScreen(name, opts = {}) {
  activeScreen = name;
  screens.forEach((s) => $("screen-" + s)?.classList.toggle("hidden", s !== name));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.screen === name));
  if (name === "profile") openProfile(opts.uid || currentUser.uid);
  if (name === "messages") { $("conv-list-view").classList.remove("hidden"); $("chat-view").classList.add("hidden"); }
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.screen));
});
$("profile-shortcut").addEventListener("click", () => showScreen("profile", { uid: currentUser.uid }));
$("notif-btn").addEventListener("click", () => showScreen("notifications"));

/* ===================== AUTH: SIGNUP / LOGIN ===================== */
$("go-signup").addEventListener("click", () => { $("login-form").classList.add("hidden"); $("signup-form").classList.remove("hidden"); });
$("go-login").addEventListener("click", () => { $("signup-form").classList.add("hidden"); $("login-form").classList.remove("hidden"); });

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("signup-error"); err.textContent = "";
  const name = $("signup-name").value.trim();
  const contact = $("signup-contact").value.trim();
  const age = parseInt($("signup-age").value, 10);
  const usernameRaw = $("signup-username").value.trim();
  const username = usernameRaw.toLowerCase();
  const password = $("signup-password").value;
  const confirm = $("signup-confirm").value;

  if (!name || !contact || !usernameRaw || !password) { err.textContent = "Please fill in every field."; return; }
  if (!/^[a-zA-Z0-9._]{3,20}$/.test(usernameRaw)) { err.textContent = "Username must be 3-20 characters (letters, numbers, . or _)."; return; }
  if (!age || age < 13) { err.textContent = "You must be at least 13 years old."; return; }
  if (password.length < 6) { err.textContent = "Password must be at least 6 characters."; return; }
  if (password !== confirm) { err.textContent = "Passwords do not match."; return; }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    // 1. enforce unique username
    const unameRef = doc(db, "usernames", username);
    const unameSnap = await getDoc(unameRef);
    if (unameSnap.exists()) { err.textContent = "That username is already taken."; submitBtn.disabled = false; return; }

    // 2. enforce unique email/phone (contact)
    const contactQ = query(collection(db, "users"), where("contactLower", "==", contact.toLowerCase()), limit(1));
    const contactSnap = await getDocs(contactQ);
    if (!contactSnap.empty) { err.textContent = "That email/phone is already registered."; submitBtn.disabled = false; return; }

    // 3. create the auth account (Firebase Auth requires an email, so we
    //    derive one from the username; the real contact is stored in Firestore)
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    const uid = cred.user.uid;

    // 4. reserve the username
    await setDoc(unameRef, { uid });

    // 5. create the user profile document.
    //    NOTE: role is always "user" here on purpose — see
    //    "WHERE TO CREATE THE ADMIN ROLE" below for how to grant admin
    //    access safely, without checking usernames in frontend code.
    await setDoc(doc(db, "users", uid), {
      name, username: usernameRaw, usernameLower: username,
      nameLower: name.toLowerCase(),
      contact, contactLower: contact.toLowerCase(),
      age, bio: "", profilePhoto: "",
      role: "user", blocked: false,
      followersCount: 0, followingCount: 0,
      createdAt: serverTimestamp()
    });

    toast("Account created!");
  } catch (ex) {
    err.textContent = friendlyAuthError(ex);
    submitBtn.disabled = false;
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error"); err.textContent = "";
  const username = $("login-username").value.trim().toLowerCase();
  const password = $("login-password").value;
  if (!username || !password) { err.textContent = "Enter your username and password."; return; }
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    const udoc = await getDoc(doc(db, "users", cred.user.uid));
    if (udoc.exists() && udoc.data().blocked) {
      err.textContent = "This account has been disabled by an administrator.";
      await signOut(auth);
    }
  } catch (ex) {
    err.textContent = "Incorrect username or password.";
  } finally {
    submitBtn.disabled = false;
  }
});

function friendlyAuthError(ex) {
  const code = ex.code || "";
  if (code.includes("email-already-in-use")) return "That username is already taken.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("network-request-failed")) return "Network error — check your connection.";
  return "Something went wrong. Please try again.";
}

$("edit-logout").addEventListener("click", async () => { await signOut(auth); });

/* ===================== AUTH STATE ===================== */
onAuthStateChanged(auth, async (user) => {
  teardownListeners();
  if (!user) {
    currentUser = null; currentUserDoc = null;
    $("auth-screen").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }
  currentUser = user;
  const udoc = await getDoc(doc(db, "users", user.uid));
  if (!udoc.exists()) { await signOut(auth); return; }
  if (udoc.data().blocked) { toast("This account has been disabled."); await signOut(auth); return; }
  currentUserDoc = { uid: user.uid, ...udoc.data() };

  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("topbar-avatar").src = currentUserDoc.profilePhoto || placeholderAvatar(currentUserDoc.name);
  $("nav-admin") && $("nav-admin").remove();
  if (currentUserDoc.role === "admin") addAdminNavButton();

  showScreen("home");
  listenFeed();
  listenStories();
  listenNotifications();
  listenConversations();
});

function addAdminNavButton() {
  const nav = document.querySelector(".bottom-nav");
  const btn = document.createElement("button");
  btn.className = "nav-btn"; btn.id = "nav-admin"; btn.dataset.screen = "admin";
  btn.innerHTML = `<svg viewBox="0 0 24 24" class="icon"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 14c-2.5 0-4.7-1.2-6-3.1.03-2 4-3.1 6-3.1s5.97 1.1 6 3.1A7.9 7.9 0 0 1 12 20Z"/></svg><span>Admin</span>`;
  btn.addEventListener("click", () => { showScreen("admin"); loadAdminPanel(); });
  nav.appendChild(btn);
}

function teardownListeners() { unsubscribers.forEach((u) => u()); unsubscribers = []; }

/* ===================== HOME FEED ===================== */
function listenFeed() {
  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(150));
  const unsub = onSnapshot(q, async (snap) => {
    const followingIds = await getFollowingIds(currentUser.uid);
    const allowed = new Set([...followingIds, currentUser.uid]);
    const posts = [];
    snap.forEach((d) => { const p = d.data(); if (allowed.has(p.userId)) posts.push({ id: d.id, ...p }); });
    renderFeed(posts);
  });
  unsubscribers.push(unsub);
}

async function getFollowingIds(uid) {
  const snap = await getDocs(query(collection(db, "follows"), where("followerId", "==", uid)));
  return snap.docs.map((d) => d.data().followingId);
}

const userCache = new Map();
async function getUserDoc(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  const snap = await getDoc(doc(db, "users", uid));
  const data = snap.exists() ? { uid, ...snap.data() } : { uid, name: "Unknown", username: "unknown" };
  userCache.set(uid, data);
  return data;
}

async function renderFeed(posts) {
  const feed = $("feed");
  $("feed-empty").classList.toggle("hidden", posts.length > 0);
  if (!posts.length) { feed.innerHTML = ""; return; }
  const cards = await Promise.all(posts.map(renderPostCard));
  feed.innerHTML = cards.join("");
  attachPostHandlers(feed, posts);
}

async function renderPostCard(p) {
  const author = await getUserDoc(p.userId);
  const liked = (p.likes || []).includes(currentUser.uid);
  const isOwn = p.userId === currentUser.uid;
  const media = p.mediaType === "video"
    ? `<video class="post-media" src="${p.mediaUrl}" controls playsinline></video>`
    : `<img class="post-media" src="${p.mediaUrl}" alt="" loading="lazy" />`;
  return `
  <article class="post-card" data-post-id="${p.id}" data-owner="${p.userId}">
    <div class="post-head">
      <img class="avatar-img" src="${author.profilePhoto || placeholderAvatar(author.name)}" data-open-profile="${p.userId}" />
      <div class="names">
        <span class="username" data-open-profile="${p.userId}">${escapeHtml(author.username)}</span>
        <span class="time">${timeAgo(p.createdAt)}</span>
      </div>
      ${isOwn ? `<button class="icon-btn post-delete" data-delete-post="${p.id}" data-media="${p.mediaPath || ''}"><svg viewBox="0 0 24 24" class="icon"><path d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2H8l1-2Z"/></svg></button>` : `<button class="icon-btn post-delete" data-report-post="${p.id}"><svg viewBox="0 0 24 24" class="icon"><path d="M6 2h2v20H6V2Zm2 1h10l-2.5 4L18 11H8V3Z"/></svg></button>`}
    </div>
    ${media}
    <div class="post-actions">
      <button class="icon-btn ${liked ? "liked" : ""}" data-like="${p.id}">
        <svg viewBox="0 0 24 24" class="icon"><path d="M12 21s-7.5-4.9-10-9.3C.5 8 2.4 4.5 6 4.5c2.1 0 3.6 1.1 4.5 2.6C11.4 5.6 12.9 4.5 15 4.5c3.6 0 5.5 3.5 4 7.2C19.5 16.1 12 21 12 21Z"/></svg>
      </button>
      <button class="icon-btn" data-toggle-comments="${p.id}">
        <svg viewBox="0 0 24 24" class="icon"><path d="M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8l-5 4V5a1 1 0 0 1 1-1Z"/></svg>
      </button>
      <button class="icon-btn" data-share="${p.id}">
        <svg viewBox="0 0 24 24" class="icon"><path d="M18 16.1c-.8 0-1.4.3-2 .8l-6.2-3.6.1-.6-.1-.6L16 8.5c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3c0 .2 0 .4.1.6L8.9 10c-.5-.5-1.2-.8-2-.8a3 3 0 1 0 0 6c.8 0 1.5-.3 2-.8l6.2 3.6c0 .2-.1.3-.1.5a3 3 0 1 0 3-3.3Z"/></svg>
      </button>
    </div>
    <div class="post-body">
      <div class="likes-count">${(p.likes || []).length} likes</div>
      <div class="caption"><strong>${escapeHtml(author.username)}</strong>${escapeHtml(p.caption || "")}</div>
      <div class="post-comments-preview" data-toggle-comments="${p.id}">${p.commentsCount ? `View all ${p.commentsCount} comments` : "Add a comment"}</div>
    </div>
    <div class="comments-panel hidden" data-comments-for="${p.id}"></div>
  </article>`;
}

function attachPostHandlers(root) {
  root.querySelectorAll("[data-open-profile]").forEach((el) => el.addEventListener("click", () => showScreen("profile", { uid: el.dataset.openProfile })));
  root.querySelectorAll("[data-like]").forEach((el) => el.addEventListener("click", () => toggleLike(el.dataset.like)));
  root.querySelectorAll("[data-toggle-comments]").forEach((el) => el.addEventListener("click", () => toggleComments(el.dataset.toggleComments || el.closest("[data-toggle-comments]").dataset.toggleComments)));
  root.querySelectorAll("[data-share]").forEach((el) => el.addEventListener("click", () => sharePost(el.dataset.share)));
  root.querySelectorAll("[data-delete-post]").forEach((el) => el.addEventListener("click", () => deletePost(el.dataset.deletePost, el.dataset.media)));
  root.querySelectorAll("[data-report-post]").forEach((el) => el.addEventListener("click", () => reportPost(el.dataset.reportPost)));
}

async function toggleLike(postId) {
  const pRef = doc(db, "posts", postId);
  const snap = await getDoc(pRef);
  if (!snap.exists()) return;
  const likes = snap.data().likes || [];
  const liked = likes.includes(currentUser.uid);
  await updateDoc(pRef, { likes: liked ? arrayRemove(currentUser.uid) : arrayUnion(currentUser.uid) });
  if (!liked && snap.data().userId !== currentUser.uid) {
    notify(snap.data().userId, "like", { postId });
  }
}

async function deletePost(postId, mediaPath) {
  if (!confirm("Delete this post?")) return;
  await deleteDoc(doc(db, "posts", postId));
  if (mediaPath) { try { await deleteObject(ref(storage, mediaPath)); } catch (e) {} }
  toast("Post deleted");
}

async function reportPost(postId) {
  const reason = prompt("Why are you reporting this post?");
  if (!reason) return;
  const snap = await getDoc(doc(db, "posts", postId));
  await addDoc(collection(db, "reports"), {
    reporterId: currentUser.uid,
    reportedUserId: snap.exists() ? snap.data().userId : null,
    postId, reason, status: "open", createdAt: serverTimestamp()
  });
  toast("Report submitted");
}

async function sharePost(postId) {
  const url = `${location.origin}${location.pathname}#post-${postId}`;
  if (navigator.share) {
    try { await navigator.share({ title: "STREET", url }); } catch (e) {}
  } else {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  }
}

async function toggleComments(postId) {
  const panel = document.querySelector(`[data-comments-for="${postId}"]`);
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  if (isHidden && !panel.dataset.loaded) {
    panel.dataset.loaded = "1";
    const q = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"), limit(200));
    const unsub = onSnapshot(q, async (snap) => {
      const rows = await Promise.all(snap.docs.map(async (d) => {
        const c = d.data();
        const author = await getUserDoc(c.userId);
        return `<div class="comment-row"><strong>${escapeHtml(author.username)}</strong>${escapeHtml(c.text)}</div>`;
      }));
      panel.innerHTML = rows.join("") + `
        <form class="comment-add" data-comment-form="${postId}">
          <input type="text" placeholder="Add a comment..." required />
          <button type="submit" class="icon-btn send-btn"><svg viewBox="0 0 24 24" class="icon"><path d="M3 20 21 12 3 4l0 7 14 1-14 1 0 7Z"/></svg></button>
        </form>`;
      const form = panel.querySelector(`[data-comment-form="${postId}"]`);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        await addDoc(collection(db, "posts", postId, "comments"), { userId: currentUser.uid, text, createdAt: serverTimestamp() });
        const pRef = doc(db, "posts", postId);
        await updateDoc(pRef, { commentsCount: increment(1) });
        const pSnap = await getDoc(pRef);
        if (pSnap.exists() && pSnap.data().userId !== currentUser.uid) notify(pSnap.data().userId, "comment", { postId });
      });
    });
    unsubscribers.push(unsub);
  }
}

/* ===================== STORIES ===================== */
function listenStories() {
  const q = query(collection(db, "stories"), orderBy("createdAt", "desc"), limit(100));
  const unsub = onSnapshot(q, async (snap) => {
    const followingIds = await getFollowingIds(currentUser.uid);
    const allowed = new Set([...followingIds, currentUser.uid]);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const byUser = new Map();
    snap.forEach((d) => {
      const s = d.data();
      if (!allowed.has(s.userId)) return;
      const t = s.createdAt?.toDate ? s.createdAt.to