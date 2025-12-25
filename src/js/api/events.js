/* ======================================================
   GUYUB - /api/events.js (Vercel Serverless)
   Collection: events
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

function parseDateOrMillis(v) {
  // supports: "2025-12-25", ISO string, millis number
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toTs(d) {
  return admin.firestore.Timestamp.fromDate(d);
}

function pickAllowed(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20),
    title: cleanString(body.title, 140),
    description: cleanString(body.description, 12000),
    locationText: cleanString(body.locationText, 180),
    allDay: parseBool(body.allDay),
    status: cleanString(body.status || "published", 20), // published/draft/cancelled
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

    // requester profile (role + neighborhood)
    const requesterSnap = await db.collection("users").doc(requesterUid).get();
    const requester = requesterSnap.exists ? requesterSnap.data() : null;
    const requesterRole = requester?.role || "warga";
    const requesterNeighborhoodId = requester?.neighborhoodId || "";

    const superAdmin = requesterRole === "super_admin";
    const requesterIsAdmin = isAdminRole(requesterRole);

    /* =========================
       GET (all logged users)
       ========================= */
    if (req.method === "GET") {
      const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
      const org = cleanString(req.query.org || "", 20); // optional
      const limit = Math.min(Number(req.query.limit || 30), 80);

      const fromD = parseDateOrMillis(req.query.from);
      const toD = parseDateOrMillis(req.query.to);

      // cursor pagination: millis timestamp of startAt
      const cursor = req.query.cursor ? Number(req.query.cursor) : null;

      if (!neighborhoodId) {
        return json(res, 400, { ok: false, error: "neighborhoodId is required (query or user profile)" });
      }

      let q = db.collection("events").where("neighborhoodId", "==", neighborhoodId);

      // status filter default: published
      const st = cleanString(req.query.status || "published", 20);
      if (st && st !== "all") q = q.where("status", "==", st);

      if (org) q = q.where("org", "==", org);

      // time window
      if (fromD) q = q.where("startAt", ">=", toTs(fromD));
      if (toD) q = q.where("startAt", "<=", toTs(toD));

      q = q.orderBy("startAt", "asc");

      if (cursor) {
        q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));
      }

      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const nextCursor = items.length
        ? (items[items.length - 1]?.startAt?.toMillis ? items[items.length - 1].startAt.toMillis() : null)
        : null;

      return json(res, 200, { ok: true, data: items, nextCursor });
    }

    /* =========================
       Admin-only below
       ========================= */
    if (!requesterIsAdmin) {
      return json(res, 403, { ok: false, error: "Forbidden: admin only" });
    }

    /* =========================
       POST (create)
       ========================= */
    if (req.method === "POST") {
      const payload = pickAllowed(req.body || {});

      if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

      const startD = parseDateOrMillis((req.body || {}).startAt);
      const endD = parseDateOrMillis((req.body || {}).endAt);

      if (!payload.neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
      if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
      if (!payload.title) return json(res, 400, { ok: false, error: "title is required" });
      if (!startD) return json(res, 400, { ok: false, error: "startAt is required (date/iso/millis)" });

      // scope check (kecuali super_admin)
      if (!superAdmin) {
        const myOrg = roleOrg(requesterRole);
        if (myOrg !== payload.org) return json(res, 403, { ok: false, error: "Forbidden: org scope mismatch" });
        if (requesterNeighborhoodId && requesterNeighborhoodId !== payload.neighborhoodId) {
          return json(res, 403, { ok: false, error: "Forbidden: neighborhood scope mismatch" });
        }
      }

      const docData = {
        ...payload,
        startAt: toTs(startD),
        endAt: endD ? toTs(endD) : toTs(startD),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: requesterUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid,
      };

      const ref = await db.collection("events").add(docData);
      const saved = await ref.get();
      return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
    }

    /* =========================
       PUT (update)
       ========================= */
    if (req.method === "PUT") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("events").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Event not found" });

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
      const startD = parseDateOrMillis((req.body || {}).startAt);
      const endD = parseDateOrMillis((req.body || {}).endAt);

      // Non-super tidak boleh ubah neighborhoodId/org
      if (!superAdmin) {
        delete patch.neighborhoodId;
        delete patch.org;
      }

      const update = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (typeof v === "string" && v === "") continue;
        update[k] = v;
      }

      if (startD) update.startAt = toTs(startD);
      if (endD) update.endAt = toTs(endD);

      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      update.updatedBy = requesterUid;

      await ref.set(update, { merge: true });
      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =========================
       DELETE
       ========================= */
    if (req.method === "DELETE") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("events").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Event not found" });

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
