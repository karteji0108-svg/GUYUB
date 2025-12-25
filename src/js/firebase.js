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
    app = getApps().length
      ? getApps()[0]
      : initializeApp(firebaseConfig);

    auth = getAuth(app);
    db = getFirestore(app);
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
   5. USER PROFILE HELPERS
   Collection: users/{uid}
   ================================================= */
export async function getUserProfile(uid) {
  const db = getDbRef();
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
}

export async function getCurrentUserProfile() {
  const auth = getAuthRef();
  const user = auth.currentUser;
  if (!user) return { user: null, profile: null };

  const profile = await getUserProfile(user.uid);
  return { user, profile };
}

/* =================================================
   6. AUTH GUARDS
   ================================================= */
export function requireAuth({
  loginPath = ROUTES.login,
  registerPath = ROUTES.register,
  onReady = () => {}
} = {}) {

  const auth = getAuthRef();

  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        go(loginPath);
        return resolve(null);
      }

      const profile = await getUserProfile(user.uid);
      if (!profile) {
        go(registerPath);
        return resolve(null);
      }

      onReady({ user, profile });
      resolve({ user, profile });
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
   7. ROLE-BASED REDIRECT
   ================================================= */
export function routeByRole(role = "") {
  if (role === "super_admin") return ROUTES.verifikasi;
  if (role.startsWith("rt_")) return ROUTES.kasAdmin;
  if (role.startsWith("pkk_")) return ROUTES.home;
  if (role.startsWith("kt_")) return ROUTES.home;
  return ROUTES.home;
}

/* =================================================
   8. SESSION
   ================================================= */
export async function logout(redirect = ROUTES.login) {
  const auth = getAuthRef();
  await signOut(auth);
  go(redirect);
}

/* =================================================
   9. FIRESTORE UTILITIES
   ================================================= */
export const ts = () => serverTimestamp();
export const inc = (n) => increment(Number(n || 0));

export async function upsertUserProfile(uid, data) {
  const db = getDbRef();
  await setDoc(
    doc(db, "users", uid),
    {
      ...data,
      createdAt: ts(),
      updatedAt: ts(),
    },
    { merge: true }
  );
}

export async function patchUserProfile(uid, patch) {
  const db = getDbRef();
  await updateDoc(doc(db, "users", uid), {
    ...patch,
    updatedAt: ts(),
  });
}
