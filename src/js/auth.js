/* ==========================================
   GUYUB - auth.js
   Path: /public/assets/js/auth.js
   ========================================== */

import { initFirebase, ROUTES, go, routeByRole, upsertUserProfile } from "/assets/js/firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

/* =========================
   Init
   ========================= */
const { auth, db } = initFirebase();

/* =========================
   UI helper
   ========================= */
export function humanAuthError(err) {
  const code = err?.code || "";
  if (code.includes("auth/invalid-email")) return "Email tidak valid.";
  if (code.includes("auth/email-already-in-use")) return "Email sudah terdaftar. Silakan login.";
  if (code.includes("auth/weak-password")) return "Password terlalu lemah. Minimal 6 karakter.";
  if (code.includes("auth/wrong-password")) return "Password salah.";
  if (code.includes("auth/user-not-found")) return "Akun tidak ditemukan.";
  if (code.includes("auth/too-many-requests")) return "Terlalu banyak percobaan. Coba lagi beberapa saat.";
  if (code.includes("auth/network-request-failed")) return "Koneksi bermasalah. Coba lagi.";
  return "Terjadi kesalahan. Coba lagi.";
}

/* =========================
   Helpers
   ========================= */
export async function getMyProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
}

export function normalizePhone(phone = "") {
  const p = String(phone || "").trim();
  if (!p) return "";
  if (p.startsWith("0")) return "+62" + p.slice(1);
  if (p.startsWith("62")) return "+" + p;
  return p;
}

/**
 * Call server bootstrap:
 * - server akan set super admin untuk user PERTAMA SAJA (atomic)
 */
async function bootstrapAdminIfFirstUser(user) {
  try {
    const token = await user.getIdToken(true);
    const res = await fetch("/api/bootstrap-admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({}) // payload optional
    });

    const out = await res.json().catch(() => ({}));
    // out: { ok:true, upgraded:true|false, reason? }
    return out;
  } catch (e) {
    // kalau API gagal, jangan block register
    return { ok: false, error: e?.message || "bootstrap failed" };
  }
}

/* =========================
   REGISTER
   =========================
   profileData minimal disarankan:
   {
     name, phone, nik, address, neighborhoodId,
     status? (optional), role? (abaikan - role diputuskan server)
   }
*/
export async function registerWithEmail(email, password, profileData = {}) {
  const e = String(email || "").trim();
  const p = String(password || "");

  if (!e) throw new Error("Email wajib diisi.");
  if (p.length < 6) throw new Error("Password minimal 6 karakter.");
  if (!profileData?.name) throw new Error("Nama wajib diisi.");

  const cred = await createUserWithEmailAndPassword(auth, e, p);

  // Set displayName (optional)
  try {
    await updateProfile(cred.user, { displayName: profileData.name });
  } catch {}

  const uid = cred.user.uid;

  // 1) Simpan profile default (AMAN): warga
  await upsertUserProfile(uid, {
    name: profileData.name || "",
    phone: normalizePhone(profileData.phone || ""),
    nik: profileData.nik || "",
    address: profileData.address || "",
    neighborhoodId: profileData.neighborhoodId || "",

    role: "warga",
    status: profileData.status || "active"
  });

  // 2) Bootstrap super admin (server yang tentukan)
  await bootstrapAdminIfFirstUser(cred.user);

  // 3) Ambil profile terbaru (kalau upgraded, role sudah berubah)
  const profile = await getMyProfile(uid);

  return { user: cred.user, uid, profile };
}

/* =========================
   LOGIN
   ========================= */
export async function loginWithEmail(email, password) {
  const e = String(email || "").trim();
  const p = String(password || "");
  if (!e || !p) throw new Error("Email dan password wajib diisi.");

  const cred = await signInWithEmailAndPassword(auth, e, p);

  // Pastikan profile ada
  const profile = await getMyProfile(cred.user.uid);
  if (!profile) {
    go(ROUTES.register);
    return { user: cred.user, profile: null };
  }

  if (profile.status === "suspended") {
    throw new Error("Akun kamu sedang dinonaktifkan. Hubungi admin RT.");
  }

  return { user: cred.user, profile };
}

/* =========================
   LOGIN + REDIRECT BY ROLE
   ========================= */
export async function loginAndRedirect(email, password) {
  const { user, profile } = await loginWithEmail(email, password);
  if (!profile) return;

  const next = routeByRole(profile.role || "");
  go(next);
}

/* =========================
   LOGOUT
   ========================= */
export async function logoutNow() {
  const { auth } = initFirebase();
  await auth.signOut();
  go(ROUTES.login);
}

/* =========================
   RESET PASSWORD
   ========================= */
export async function resetPassword(email) {
  const e = String(email || "").trim();
  if (!e) throw new Error("Email wajib diisi.");

  await sendPasswordResetEmail(auth, e);
  return true;
}

/* =========================
   GUARD: jika sudah login -> redirect dashboard
   ========================= */
export function redirectIfLoggedIn() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const profile = await getMyProfile(user.uid);
    if (!profile) return go(ROUTES.register);
    if (profile.status === "suspended") return;
    go(routeByRole(profile.role || ""));
  });
}

/* =========================
   GUARD: wajib login
   ========================= */
export function requireLogin({ onReady } = {}) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return go(ROUTES.login);

    const profile = await getMyProfile(user.uid);
    if (!profile) return go(ROUTES.register);

    if (profile.status === "suspended") {
      throw new Error("Akun suspended.");
    }

    onReady && onReady({ user, profile });
  });
}
