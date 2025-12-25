/* =================================================
   GUYUB - firebase.js (Firebase v9 Modular)
   ================================================= */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

/* =================================================
   0. DEBUG
   ================================================= */
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[GUYUB]", ...a);

/* =================================================
   1. FIREBASE CONFIG (GUYUB – VALID)
   ================================================= */
export const firebaseConfig = {
  apiKey: "AIzaSyC3gE3huegvn3-PDG9KHqrpiGXOF2SH2JA",
  authDomain: "guyub-fff38.firebaseapp.com",
  projectId: "guyub-fff38",
  storageBucket: "guyub-fff38.firebasestorage.app",
  messagingSenderId: "319458310192",
  appId: "1:319458310192:web:e34b595a5fe93dfd2ad5f5",
  measurementId: "G-2EPEKR65KK"
};

/* =================================================
   2. ROUTES (GLOBAL NAVIGATION)
   ================================================= */
export const ROUTES = {
  index: "/index.html",
  onboarding: "/onboarding.html",
  login: "/login.html",
  register: "/register.html",

  home: "/app/home.html",
  profil: "/app/profil.html",
  surat: "/app/surat.html",
  inventaris: "/app/inventaris.html",

  // Admin
  kasAdmin: "/app/admin/kas-admin.html",
  verifikasi: "/app/admin/verifikasi.html",
};

/* =================================================
   3. INIT FIREBASE (SINGLETON)
   ================================================= */
let app;
let auth;
let db;

export function initFirebase() {
  if (!app) {
    app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    log("Firebase inited", { projectId: firebaseConfig.projectId });
  }
  return { app, auth, db };
}

export const getAuthRef = () => {
  if (!auth) initFirebase();
  return auth;
};

export const getDbRef = () => {
  if (!db) initFirebase();
  return db;
};

/* =================================================
   4. NAV & ROLE HELPERS
   ================================================= */
export const go = (path) => window.location.replace(path);

export const roleOrg = (role = "") => {
  if (role.startsWith("rt_")) return "rt";
  if (role.startsWith("pkk_")) return "pkk";
  if (role.startsWith("kt_")) return "kt";
  return null;
};

export const isAdmin = (role = "") =>
  role === "super_admin" ||
  role.startsWith("rt_") ||
  role.startsWith("pkk_") ||
  role.startsWith("kt_");

export const isRtAdmin = (role = "") =>
  role === "super_admin" || role.startsWith("rt_");

/* =================================================
   5. SAFE HELPERS (ANTI STUCK)
   ================================================= */
function withTimeout(promise, ms = 7000, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

export function humanFirestoreError(e) {
  const msg = String(e?.message || "");
  if (msg.includes("Missing or insufficient permissions")) {
    return "Akses ditolak (Firestore Rules).";
  }
  if (msg.toLowerCase().includes("timeout")) return "Request timeout. Cek koneksi.";
  return "Gagal memuat data. Cek koneksi / konfigurasi.";
}

/* =================================================
   6. USER PROFILE HELPERS
   Collection: users/{uid}
   ================================================= */
export async function getUserProfile(uid) {
  try {
    const db = getDbRef();
    const snap = await withTimeout(getDoc(doc(db, "users", uid)), 7000, "getUserProfile timeout");
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
  } catch (e) {
    log("getUserProfile error:", e);
    throw e;
  }
}

export async function getCurrentUserProfile() {
  const auth = getAuthRef();
  const user = auth.currentUser;
  if (!user) return { user: null, profile: null };

  const profile = await getUserProfile(user.uid);
  return { user, profile };
}

/* =================================================
   7. AUTH GUARDS (ANTI STUCK)
   ================================================= */
export function requireAuth({
  loginPath = ROUTES.login,
  registerPath = ROUTES.register,
  onReady = () => {},
  onError = () => {},
} = {}) {

  const auth = getAuthRef();

  return new Promise((resolve) => {
    let settled = false;

    // watchdog kalau callback auth gak pernah terpanggil (jarang, tapi aman)
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      log("requireAuth watchdog fired");
      onError(new Error("auth watchdog"));
      go(loginPath);
      resolve(null);
    }, 9000);

    onAuthStateChanged(auth, async (user) => {
      try {
        clearTimeout(watchdog);
        if (settled) return;
        settled = true;

        log("auth state:", user ? "LOGGED_IN" : "LOGGED_OUT", user?.uid);

        if (!user) {
          go(loginPath);
          return resolve(null);
        }

        let profile = null;
        try {
          profile = await getUserProfile(user.uid);
        } catch (e) {
          // Firestore error → jangan stuck, fallback ke login
          onError(e);
          go(loginPath);
          return resolve(null);
        }

        if (!profile) {
          go(registerPath);
          return resolve(null);
        }

        onReady({ user, profile });
        resolve({ user, profile });

      } catch (e) {
        clearTimeout(watchdog);
        log("requireAuth fatal:", e);
        onError(e);
        go(loginPath);
        resolve(null);
      }
    });
  });
}

export async function requireRole(predicate, options = {}) {
  const { fallbackPath = ROUTES.home } = options;
  const result = await requireAuth(options);
  if (!result) return null;

  const { profile } = result;
  const ok = predicate(profile.role || "");
  if (!ok) go(fallbackPath);

  return result;
}

/* =================================================
   8. ROLE-BASED REDIRECT
   ================================================= */
export function routeByRole(role = "") {
  if (role === "super_admin") return ROUTES.verifikasi;
  if (role.startsWith("rt_")) return ROUTES.kasAdmin;
  if (role.startsWith("pkk_")) return ROUTES.home;
  if (role.startsWith("kt_")) return ROUTES.home;
  return ROUTES.home;
}

/* =================================================
   9. SESSION
   ================================================= */
export async function logout(redirect = ROUTES.login) {
  const auth = getAuthRef();
  await signOut(auth);
  go(redirect);
}

/* =================================================
   10. FIRESTORE UTILITIES
   ================================================= */
export const ts = () => serverTimestamp();
export const inc = (n) => increment(Number(n || 0));

/**
 * upsertUserProfile:
 * - createdAt hanya di-set kalau doc belum ada
 * - update berikutnya tidak menimpa createdAt
 */
export async function upsertUserProfile(uid, data) {
  const db = getDbRef();
  const ref = doc(db, "users", uid);

  // cek ada doc atau belum (biar createdAt tidak ketimpa)
  const snap = await getDoc(ref);
  const exists = snap.exists();

  if (!exists) {
    await setDoc(ref, {
      ...data,
      createdAt: ts(),
      updatedAt: ts(),
    }, { merge: true });
    return;
  }

  // kalau sudah ada, jangan overwrite createdAt
  await setDoc(ref, {
    ...data,
    updatedAt: ts(),
  }, { merge: true });
}

export async function patchUserProfile(uid, patch) {
  const db = getDbRef();
  await updateDoc(doc(db, "users", uid), {
    ...patch,
    updatedAt: ts(),
  });
}
