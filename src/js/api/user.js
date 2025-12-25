/* ======================================================
   GUYUB - /api/user.js (Vercel Serverless Function)
   - Requires Firebase Admin SDK
   - Env:
     FIREBASE_PROJECT_ID
     FIREBASE_CLIENT_EMAIL
     FIREBASE_PRIVATE_KEY  (replace \n properly)
   ====================================================== */

import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env vars.");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return admin.app();
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function pickAllowedPatch(body = {}) {
  // ✅ whitelist field yang boleh diupdate via API
  const allowed = [
    "name",
    "phone",
    "nik",
    "address",
    "neighborhoodId",
    "photoUrl",
    "role",     // ⚠️ sebaiknya hanya boleh diubah oleh super_admin (lihat check di bawah)
    "status"    // active/suspended/pending
  ];

  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

// OPTIONAL: very light token verification (recommended)
// If you want strict security, verify Firebase ID token from Authorization header.
// Example header: Authorization: Bearer <idToken>
async function verifyIdToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  initAdmin();
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return decoded; // { uid, ...claims }
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    initAdmin();
    const db = admin.firestore();

    const uid = (req.query.uid || "").toString().trim();
    if (!uid && req.method !== "POST") {
      return json(res, 400, { ok: false, error: "uid query param is required" });
    }

    // ✅ token verification (recommended)
    const decoded = await verifyIdToken(req);

    // Basic rule:
    // - user hanya boleh akses datanya sendiri
    // - super_admin boleh akses siapa saja
    // (kalau tidak kirim Authorization, kita tolak untuk keamanan)
    if (!decoded) {
      return json(res, 401, { ok: false, error: "Missing/invalid Authorization Bearer token" });
    }

    const requesterUid = decoded.uid;

    // Get requester profile to check role
    const requesterSnap = await db.collection("users").doc(requesterUid).get();
    const requesterRole = requesterSnap.exists ? (requesterSnap.data().role || "warga") : "warga";
    const isSuper = requesterRole === "super_admin";

    // For GET/PUT: if not super_admin, must be self
    if ((req.method === "GET" || req.method === "PUT") && !isSuper && uid !== requesterUid) {
      return json(res, 403, { ok: false, error: "Forbidden: only super_admin can access other users" });
    }

    if (req.method === "GET") {
      const snap = await db.collection("users").doc(uid).get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "User profile not found" });
      return json(res, 200, { ok: true, data: { uid: snap.id, ...snap.data() } });
    }

    if (req.method === "PUT") {
      const patch = pickAllowedPatch(req.body || {});

      // ⚠️ role/status hanya boleh diubah super_admin
      if (!isSuper) {
        delete patch.role;
        delete patch.status;
      }

      patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

      await db.collection("users").doc(uid).set(patch, { merge: true });

      const snap = await db.collection("users").doc(uid).get();
      return json(res, 200, { ok: true, data: { uid: snap.id, ...snap.data() } });
    }

    if (req.method === "POST") {
      // create/merge profile by requester only (no uid query)
      const body = req.body || {};
      const docRef = db.collection("users").doc(requesterUid);

      const data = pickAllowedPatch(body);
      // role/status tidak boleh dibuat sembarangan
      delete data.role;
      delete data.status;

      // default role/status
      const toWrite = {
        ...data,
        role: "warga",
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await docRef.set(toWrite, { merge: true });

      const snap = await docRef.get();
      return json(res, 201, { ok: true, data: { uid: snap.id, ...snap.data() } });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
