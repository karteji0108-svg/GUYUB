/* ======================================================
   GUYUB - /api/announcements.js (Vercel Serverless)
   Collection: announcements
   Auth: Firebase ID Token (Authorization: Bearer <token>)
   ====================================================== */

import admin from "firebase-admin";

/* ------------------ Admin init ------------------ */
function initAdmin() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env vars.");
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });

  return admin.app();
}

/* ------------------ Utils ------------------ */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

async function verifyIdToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  initAdmin();
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch {
    return null;
  }
}

function roleOrg(role = "") {
  if (role.startsWith("rt_")) return "rt";
  if (role.startsWith("pkk_")) return "pkk";
  if (role.startsWith("kt_")) return "kt";
  return null;
}

function isAdminRole(role = "") {
  return role === "super_admin" || role.startsWith("rt_") || role.startsWith("pkk_") || role.startsWith("kt_");
}

function cleanString(v, max = 5000) {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function pickAllowed(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20),
    title: cleanString(body.title, 140),
    body: cleanString(body.body, 10000),
    pinned: !!body.pinned,
    status: cleanString(body.status || "published", 20), // published/draft/archived
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => cleanString(t, 24)).filter(Boolean).slice(0, 12)
      : [],
  };
}

/* ------------------ Handler ------------------ */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    initAdmin();
    const db = admin.firestore();

    const decoded = await verifyIdToken(req);
    if (!decoded) return json(res, 401, { ok: false, error: "Missing/invalid Authorization Bearer token" });

    const requesterUid = decoded.uid;

    // requester profile for role + neighborhood
    const requesterSnap = await db.collection("users").doc(requesterUid).get();
    const requester = requesterSnap.exists ? requesterSnap.data() : null;
    const requesterRole = requester?.role || "warga";
    const requesterNeighborhoodId = requester?.neighborhoodId || "";

    const superAdmin = requesterRole === "super_admin";
    const requesterIsAdmin = isAdminRole(requesterRole);

    // =========================
    // GET (read-only for all logged users)
    // =========================
    if (req.method === "GET") {
      const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
      const org = cleanString(req.query.org || "", 20); // optional
      const limit = Math.min(Number(req.query.limit || 20), 50);

      // cursor = createdAt millis (atau ISO) untuk pagination sederhana
      const cursor = req.query.cursor ? Number(req.query.cursor) : null;

      if (!neighborhoodId) {
        return json(res, 400, { ok: false, error: "neighborhoodId is required (query or user profile)" });
      }

      let q = db.collection("announcements")
        .where("neighborhoodId", "==", neighborhoodId)
        .where("status", "==", "published");

      if (org) q = q.where("org", "==", org);

      q = q.orderBy("pinned", "desc").orderBy("createdAt", "desc");

      if (cursor) {
        // createdAt berupa Timestamp; kita pakai timestamp startAfter
        const cursorTs = admin.firestore.Timestamp.fromMillis(cursor);
        // karena ada orderBy pinned + createdAt, startAfter butuh kedua field
        // fallback: pakai createdAt saja (lebih simpel) -> gunakan query tanpa pinned pagination
        q = db.collection("announcements")
          .where("neighborhoodId", "==", neighborhoodId)
          .where("status", "==", "published")
          .orderBy("createdAt", "desc")
          .startAfter(cursorTs);

        if (org) q = q.where("org", "==", org);
      }

      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const nextCursor = items.length
        ? (items[items.length - 1]?.createdAt?.toMillis ? items[items.length - 1].createdAt.toMillis() : null)
        : null;

      return json(res, 200, { ok: true, data: items, nextCursor });
    }

    // =========================
    // Admin-only endpoints below
    // =========================
    if (!requesterIsAdmin) {
      return json(res, 403, { ok: false, error: "Forbidden: admin only" });
    }

    // =========================
    // POST (create)
    // =========================
    if (req.method === "POST") {
      const payload = pickAllowed(req.body || {});
      payload.pinned = parseBool((req.body || {}).pinned);
      payload.status = payload.status || "published";

      if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

      if (!payload.neighborhoodId) {
        return json(res, 400, { ok: false, error: "neighborhoodId is required (body or admin profile)" });
      }
      if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) {
        return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
      }
      if (!payload.title) return json(res, 400, { ok: false, error: "title is required" });
      if (!payload.body) return json(res, 400, { ok: false, error: "body is required" });

      // scope check (kecuali super_admin)
      if (!superAdmin) {
        const myOrg = roleOrg(requesterRole);
        if (myOrg !== payload.org) return json(res, 403, { ok: false, error: "Forbidden: org scope mismatch" });
        if (requesterNeighborhoodId && requesterNeighborhoodId !== payload.neighborhoodId) {
          return json(res, 403, { ok: false, error: "Forbidden: neighborhood scope mismatch" });
        }
      }

      const ref = await db.collection("announcements").add({
        ...payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: requesterUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid,
      });

      const saved = await ref.get();
      return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
    }

    // =========================
    // PUT (update)
    // =========================
    if (req.method === "PUT") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("announcements").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Announcement not found" });

      const current = snap.data();

      // scope check (kecuali super_admin)
      if (!superAdmin) {
        const myOrg = roleOrg(requesterRole);
        if (myOrg !== current.org) return json(res, 403, { ok: false, error: "Forbidden: org scope mismatch" });
        if (requesterNeighborhoodId && requesterNeighborhoodId !== current.neighborhoodId) {
          return json(res, 403, { ok: false, error: "Forbidden: neighborhood scope mismatch" });
        }
      }

      const patch = pickAllowed(req.body || {});
      patch.pinned = parseBool((req.body || {}).pinned);

      // Jangan izinkan ganti neighborhoodId/org oleh non-super
      if (!superAdmin) {
        delete patch.neighborhoodId;
        delete patch.org;
      }

      // Field kosong jangan overwrite jadi empty
      const update = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k === "tags" && Array.isArray(v)) update[k] = v;
        else if (typeof v === "string" && v === "") continue;
        else update[k] = v;
      }

      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      update.updatedBy = requesterUid;

      await ref.set(update, { merge: true });
      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    // =========================
    // DELETE
    // =========================
    if (req.method === "DELETE") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("announcements").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Announcement not found" });

      const current = snap.data();

      if (!superAdmin) {
        const myOrg = roleOrg(requesterRole);
        if (myOrg !== current.org) return json(res, 403, { ok: false, error: "Forbidden: org scope mismatch" });
        if (requesterNeighborhoodId && requesterNeighborhoodId !== current.neighborhoodId) {
          return json(res, 403, { ok: false, error: "Forbidden: neighborhood scope mismatch" });
        }
      }

      await ref.delete();
      return json(res, 200, { ok: true, deleted: true, id });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
