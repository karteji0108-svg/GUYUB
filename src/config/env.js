/* ==========================================
   GUYUB - config/env.js
   Path: /config/env.js
   Note: Jangan taruh secret di sini!
   ========================================== */

/**
 * Cara pakai di FE:
 * import { ENV, apiUrl } from "/config/env.js";
 * fetch(apiUrl("/api/events"))
 */

const isBrowser = typeof window !== "undefined";

function readMeta(name) {
  if (!isBrowser) return "";
  const el = document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute("content") || "";
}

/**
 * OPSI 1 (disarankan untuk FE):
 * - set API base via meta tag di HTML:
 *   <meta name="guyub-api-base" content="">
 *   atau "https://domainmu.vercel.app"
 */
const metaApiBase = readMeta("guyub-api-base");

/**
 * OPSI 2:
 * - fallback otomatis: same-origin
 */
const defaultApiBase = isBrowser ? "" : process.env.API_BASE || "";

/**
 * MODE detection
 */
const host = isBrowser ? window.location.hostname : "";
const isLocal = isBrowser ? (host === "localhost" || host === "127.0.0.1") : false;

export const ENV = {
  APP_NAME: "GUYUB",
  APP_TAGLINE: "Satu Warga, Satu Suara, Sejuta Karya.",
  APP_VERSION: "1.0.0",

  // runtime flags
  IS_BROWSER: isBrowser,
  IS_LOCAL: isLocal,
  IS_PROD: isBrowser ? !isLocal : (process.env.NODE_ENV === "production"),

  // base API url (same-origin by default)
  API_BASE: metaApiBase || defaultApiBase,

  // default paging
  DEFAULT_LIMIT: 30,

  // cache keys
  LS_PREFIX: "guyub:",
};

/**
 * Build full API URL
 * - apiUrl("/api/events") -> `${API_BASE}/api/events` (API_BASE bisa kosong)
 */
export function apiUrl(path = "") {
  const p = String(path || "");
  if (!p.startsWith("/")) return (ENV.API_BASE || "") + "/" + p;
  return (ENV.API_BASE || "") + p;
}

/**
 * LocalStorage helper
 */
export const storage = {
  get(key, fallback = null) {
    if (!isBrowser) return fallback;
    try {
      const v = localStorage.getItem(ENV.LS_PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    if (!isBrowser) return;
    try {
      localStorage.setItem(ENV.LS_PREFIX + key, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    if (!isBrowser) return;
    try {
      localStorage.removeItem(ENV.LS_PREFIX + key);
    } catch {}
  },
};

/**
 * Tiny logger (biar rapi)
 */
export function log(...args) {
  if (!ENV.IS_PROD) console.log("[GUYUB]", ...args);
}
export function warn(...args) {
  if (!ENV.IS_PROD) console.warn("[GUYUB]", ...args);
}
export function err(...args) {
  console.error("[GUYUB]", ...args);
}
