/* ==========================================
   GUYUB - role-guard.js
   Path: /public/assets/js/role-guard.js
   ========================================== */

import { requireAuth, ROUTES, go, roleOrg, isAdmin, isRtAdmin } from "/assets/js/firebase.js";

/**
 * Helper: tampilkan message ringan (fallback kalau belum ada toast)
 */
function showBlockMessage(msg) {
  // kalau kamu punya elemen #guardMsg, isi di sana
  const el = document.getElementById("guardMsg");
  if (el) {
    el.textContent = msg;
    el.classList.remove("hidden");
    return;
  }
  alert(msg);
}

/**
 * Guard dasar: wajib login + wajib punya profile
 * return { user, profile }
 */
export async function guardAuth(options = {}) {
  return await requireAuth({
    loginPath: ROUTES.login,
    registerPath: ROUTES.register,
    ...options,
  });
}

/**
 * Guard: admin saja
 * role: super_admin / rt_* / pkk_* / kt_*
 */
export async function guardAdmin(options = {}) {
  const res = await guardAuth(options);
  if (!res) return null;

  const { profile } = res;
  if (!isAdmin(profile.role || "")) {
    showBlockMessage("Akses ditolak. Halaman ini khusus admin.");
    go(options.fallbackPath || ROUTES.home);
    return null;
  }
  return res;
}

/**
 * Guard: admin RT saja (super_admin atau rt_*)
 */
export async function guardRtAdmin(options = {}) {
  const res = await guardAuth(options);
  if (!res) return null;

  const { profile } = res;
  if (!isRtAdmin(profile.role || "")) {
    showBlockMessage("Akses ditolak. Halaman ini khusus admin RT.");
    go(options.fallbackPath || ROUTES.home);
    return null;
  }
  return res;
}

/**
 * Guard: hanya role tertentu
 * roles: array string exact, contoh ["super_admin","rt_ketua","rt_sekretaris"]
 */
export async function guardRoles(roles = [], options = {}) {
  const res = await guardAuth(options);
  if (!res) return null;

  const r = res.profile?.role || "";
  if (!roles.includes(r)) {
    showBlockMessage("Akses ditolak. Role kamu tidak sesuai.");
    go(options.fallbackPath || ROUTES.home);
    return null;
  }
  return res;
}

/**
 * Guard: hanya org tertentu (rt/pkk/kt)
 * - super_admin selalu lolos
 * - admin biasa harus roleOrg(role) === org
 *
 * contoh:
 *   await guardOrg("rt")
 *   await guardOrg("pkk")
 *   await guardOrg("kt")
 */
export async function guardOrg(org, options = {}) {
  const res = await guardAuth(options);
  if (!res) return null;

  const role = res.profile?.role || "";
  if (role === "super_admin") return res;

  const myOrg = roleOrg(role);
  if (myOrg !== org) {
    showBlockMessage(`Akses ditolak. Halaman ini khusus ${String(org).toUpperCase()}.`);
    go(options.fallbackPath || ROUTES.home);
    return null;
  }
  return res;
}

/**
 * Guard: wajib neighborhoodId ada (buat modul kas/surat/inventaris)
 */
export async function guardNeighborhood(options = {}) {
  const res = await guardAuth(options);
  if (!res) return null;

  if (!res.profile?.neighborhoodId) {
    showBlockMessage("neighborhoodId belum diatur. Lengkapi dulu di Profil.");
    go(options.fallbackPath || ROUTES.profil);
    return null;
  }
  return res;
}

/**
 * Guard: org + neighborhood sekaligus
 */
export async function guardOrgNeighborhood(org, options = {}) {
  const res = await guardOrg(org, options);
  if (!res) return null;

  if (!res.profile?.neighborhoodId) {
    showBlockMessage("neighborhoodId belum diatur. Lengkapi dulu di Profil.");
    go(options.fallbackPath || ROUTES.profil);
    return null;
  }
  return res;
}

/**
 * Guard: admin + scope neighborhood sama (berguna untuk halaman admin yang sensitif)
 * - super_admin lolos
 * - admin biasa: harus punya neighborhoodId
 */
export async function guardAdminWithNeighborhood(options = {}) {
  const res = await guardAdmin(options);
  if (!res) return null;

  const role = res.profile?.role || "";
  if (role === "super_admin") return res;

  if (!res.profile?.neighborhoodId) {
    showBlockMessage("neighborhoodId admin belum diatur. Set dulu lewat Profil atau Verifikasi.");
    go(options.fallbackPath || ROUTES.profil);
    return null;
  }
  return res;
}
