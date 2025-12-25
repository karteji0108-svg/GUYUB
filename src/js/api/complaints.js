/* ======================================================
   GUYUB - /api/complaints.js (Vercel Serverless)
   Collection: complaints
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

function pickAllowedCreate(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20), // rt|pkk|kt (target penanganan)
    category: cleanString(body.category, 40), // keamanan/kebersihan/infrastruktur/dll
    title: cleanString(body.title, 140),
    description: cleanString(body.description, 12000),
    locationText: cleanString(body.locationText, 180),
    photoUrls: Array.isArray(body.photoUrls)
      ? body.photoUrls.map((u) => cleanString(u, 1000)).filter(Boolean).slice(0, 6)
      : [],
    priority: cleanString(body.priority || "normal", 20), // low/normal/high/urgent
    isAnonymous: parseBool(body.isAnonymous),
  };
}

function canAdminScope(superAdmin, role, org, neighborhoodId, requesterNeighborhoodId) {
  if (superAdmin) return true;
  const myOrg = roleOrg(role || "");
  if (org && myOrg !== org) return false;
  if (requesterNeighborhoodId && neighborhoodId && requesterNeighborhoodId !== neighborhoodId) return false;
  return true;
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

    // requester profile
    const requesterSnap = await db.collection("users").doc(requesterUid).get();
    const requester = requesterSnap.exists ? requesterSnap.data() : null;
    const requesterRole = requester?.role || "warga";
    const requesterNeighborhoodId = requester?.neighborhoodId || "";

    const superAdmin = requesterRole === "super_admin";
    const requesterIsAdmin = isAdminRole(requesterRole);

    const action = cleanString(req.query.action || "", 30);

    /* =========================
       GET list
       ========================= */
    if (req.method === "GET") {
      const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
      const org = cleanString(req.query.org || "", 20);
      const status = cleanString(req.query.status || "open", 30); // open/in_progress/resolved/rejected/all
      const mine = parseBool(req.query.mine);
      const limit = Math.min(Number(req.query.limit || 30), 80);

      const fromD = parseDateOrMillis(req.query.from);
      const toD = parseDateOrMillis(req.query.to);
      const cursor = req.query.cursor ? Number(req.query.cursor) : null; // millis of createdAt

      if (!neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
      if (org && !["rt", "pkk", "kt"].includes(org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });

      // default: warga hanya bisa lihat milik sendiri, kecuali admin
      const forceMine = !requesterIsAdmin && !superAdmin;

      let q = db.collection("complaints").where("neighborhoodId", "==", neighborhoodId);

      if (org) q = q.where("org", "==", org);
      if (status && status !== "all") q = q.where("status", "==", status);

      const shouldMine = forceMine ? true : mine;
      if (shouldMine) q = q.where("createdBy", "==", requesterUid);

      if (fromD) q = q.where("createdAt", ">=", toTs(fromD));
      if (toD) q = q.where("createdAt", "<=", toTs(toD));

      q = q.orderBy("createdAt", "desc");
      if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const nextCursor = items.length
        ? (items[items.length - 1]?.createdAt?.toMillis ? items[items.length - 1].createdAt.toMillis() : null)
        : null;

      return json(res, 200, { ok: true, data: items, nextCursor });
    }

    /* =========================
       POST create complaint (all users)
       ========================= */
    if (req.method === "POST" && !action) {
      const payload = pickAllowedCreate(req.body || {});
      const occurredD = parseDateOrMillis((req.body || {}).occurredAt) || new Date();

      if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

      if (!payload.neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required (body or user profile)" });
      if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
      if (!payload.title) return json(res, 400, { ok: false, error: "title is required" });
      if (!payload.description) return json(res, 400, { ok: false, error: "description is required" });

      const ref = await db.collection("complaints").add({
        ...payload,
        occurredAt: toTs(occurredD),

        status: "open", // default
        assignment: {
          assignedTo: "",
          assignedRole: "",
          assignedAt: null
        },
        resolution: {
          note: "",
          resolvedAt: null,
          by: ""
        },

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: requesterUid,
        createdByName: cleanString(requester?.name || "", 120),
        createdByPhone: cleanString(requester?.phone || "", 40),

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid
      });

      const saved = await ref.get();
      return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
    }

    /* =========================
       PUT update complaint
       - owner can edit only while status=open
       - admin can edit and change status/assignment
       ========================= */
    if (req.method === "PUT") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("complaints").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Complaint not found" });

      const cur = snap.data();
      const isOwner = cur.createdBy === requesterUid;

      // Admin scope check
      if (requesterIsAdmin && !superAdmin) {
        const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });
      }

      // Warga (non admin) hanya boleh edit milik sendiri dan saat open
      if (!requesterIsAdmin && !superAdmin) {
        if (!isOwner) return json(res, 403, { ok: false, error: "Forbidden: not owner" });
        if (cur.status !== "open") return json(res, 403, { ok: false, error: "Only editable while status=open" });
      }

      const body = req.body || {};
      const update = {};

      // Field warga yang boleh diubah
      if (Object.prototype.hasOwnProperty.call(body, "title")) update.title = cleanString(body.title, 140);
      if (Object.prototype.hasOwnProperty.call(body, "description")) update.description = cleanString(body.description, 12000);
      if (Object.prototype.hasOwnProperty.call(body, "locationText")) update.locationText = cleanString(body.locationText, 180);
      if (Object.prototype.hasOwnProperty.call(body, "category")) update.category = cleanString(body.category, 40);
      if (Object.prototype.hasOwnProperty.call(body, "priority")) update.priority = cleanString(body.priority, 20);
      if (Object.prototype.hasOwnProperty.call(body, "photoUrls")) {
        update.photoUrls = Array.isArray(body.photoUrls)
          ? body.photoUrls.map((u) => cleanString(u, 1000)).filter(Boolean).slice(0, 6)
          : [];
      }

      // Admin boleh ubah status + resolution note (optional)
      if ((requesterIsAdmin || superAdmin) && Object.prototype.hasOwnProperty.call(body, "status")) {
        const st = cleanString(body.status, 30);
        const allowed = ["open", "in_progress", "resolved", "rejected"];
        if (allowed.includes(st)) update.status = st;

        if (st === "resolved") {
          update["resolution.note"] = cleanString(body.resolutionNote || "", 2000);
          update["resolution.resolvedAt"] = admin.firestore.FieldValue.serverTimestamp();
          update["resolution.by"] = requesterUid;
        }
        if (st === "rejected") {
          update["resolution.note"] = cleanString(body.resolutionNote || "Ditolak", 2000);
          update["resolution.resolvedAt"] = admin.firestore.FieldValue.serverTimestamp();
          update["resolution.by"] = requesterUid;
        }
      }

      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      update.updatedBy = requesterUid;

      await ref.set(update, { merge: true });
      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =========================
       POST action=assign (admin)
       POST /api/complaints?action=assign&id=...
       body: { assignedTo, assignedRole }
       ========================= */
    if (req.method === "POST" && action === "assign") {
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("complaints").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Complaint not found" });

      const cur = snap.data();
      const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
      if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

      const assignedTo = cleanString((req.body || {}).assignedTo || "", 200);
      const assignedRole = cleanString((req.body || {}).assignedRole || requesterRole, 60);

      await ref.set({
        status: cur.status === "open" ? "in_progress" : cur.status,
        assignment: {
          assignedTo,
          assignedRole,
          assignedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid
      }, { merge: true });

      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =========================
       POST action=updateStatus (admin)
       POST /api/complaints?action=updateStatus&id=...
       body: { status, note }
       ========================= */
    if (req.method === "POST" && action === "updateStatus") {
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("complaints").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Complaint not found" });

      const cur = snap.data();
      const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
      if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

      const st = cleanString((req.body || {}).status || "", 30);
      const note = cleanString((req.body || {}).note || "", 2000);
      const allowed = ["open", "in_progress", "resolved", "rejected"];
      if (!allowed.includes(st)) return json(res, 400, { ok: false, error: "Invalid status" });

      const update = {
        status: st,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid
      };

      if (st === "resolved" || st === "rejected") {
        update["resolution.note"] = note || (st === "rejected" ? "Ditolak" : "Selesai");
        update["resolution.resolvedAt"] = admin.firestore.FieldValue.serverTimestamp();
        update["resolution.by"] = requesterUid;
      }

      await ref.set(update, { merge: true });

      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =========================
       DELETE
       - Admin/super_admin boleh hapus
       - Owner boleh hapus jika masih open (optional)
       ========================= */
    if (req.method === "DELETE") {
      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("complaints").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Complaint not found" });

      const cur = snap.data();
      const isOwner = cur.createdBy === requesterUid;

      if (requesterIsAdmin || superAdmin) {
        const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });
        await ref.delete();
        return json(res, 200, { ok: true, deleted: true, id });
      }

      // owner delete (open only)
      if (isOwner && cur.status === "open") {
        await ref.delete();
        return json(res, 200, { ok: true, deleted: true, id });
      }

      return json(res, 403, { ok: false, error: "Forbidden" });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
