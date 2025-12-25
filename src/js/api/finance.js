/* ======================================================
   GUYUB - /api/finance.js (Vercel Serverless)
   Collection: finance_transactions
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

function pickAllowed(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20), // rt|pkk|kt
    type: cleanString(body.type, 20), // income|expense
    category: cleanString(body.category, 40),
    amount: Number(body.amount || 0),
    note: cleanString(body.note, 2000),
    method: cleanString(body.method || "", 24), // cash/transfer/...
    receiptUrl: cleanString(body.receiptUrl || "", 1000),
    // occurredAt di body bisa date/iso/millis
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => cleanString(t, 24)).filter(Boolean).slice(0, 12)
      : [],
  };
}

function canAdminWrite(superAdmin, role, org, neighborhoodId, requesterNeighborhoodId) {
  if (superAdmin) return true;
  const myOrg = roleOrg(role || "");
  if (myOrg !== org) return false;
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

    /* =================================================
       GET summary (optional)
       GET /api/finance?action=summary&...
       ================================================= */
    if (req.method === "GET" && action === "summary") {
      const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
      const org = cleanString(req.query.org || "", 20);
      const status = cleanString(req.query.status || "approved", 20); // default approved
      const limit = Math.min(Number(req.query.limit || 300), 500);

      const fromD = parseDateOrMillis(req.query.from);
      const toD = parseDateOrMillis(req.query.to);

      if (!neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
      if (org && !["rt", "pkk", "kt"].includes(org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });

      let q = db.collection("finance_transactions").where("neighborhoodId", "==", neighborhoodId);
      if (org) q = q.where("org", "==", org);
      if (status && status !== "all") q = q.where("status", "==", status);

      if (fromD) q = q.where("occurredAt", ">=", toTs(fromD));
      if (toD) q = q.where("occurredAt", "<=", toTs(toD));

      q = q.orderBy("occurredAt", "desc");

      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => d.data());

      const income = items.filter(x => x.type === "income").reduce((a,b)=>a + Number(b.amount||0), 0);
      const expense = items.filter(x => x.type === "expense").reduce((a,b)=>a + Number(b.amount||0), 0);

      return json(res, 200, {
        ok: true,
        data: {
          neighborhoodId,
          org: org || null,
          status,
          limitUsed: items.length,
          income,
          expense,
          balance: income - expense
        }
      });
    }

    /* =================================================
       GET list (all logged users)
       ================================================= */
    if (req.method === "GET") {
      const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
      const org = cleanString(req.query.org || "", 20); // optional
      const status = cleanString(req.query.status || "approved", 20); // approved|pending|rejected|all
      const limit = Math.min(Number(req.query.limit || 50), 100);

      const fromD = parseDateOrMillis(req.query.from);
      const toD = parseDateOrMillis(req.query.to);

      // cursor pagination: millis of occurredAt
      const cursor = req.query.cursor ? Number(req.query.cursor) : null;

      if (!neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required (query or user profile)" });
      if (org && !["rt", "pkk", "kt"].includes(org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });

      let q = db.collection("finance_transactions").where("neighborhoodId", "==", neighborhoodId);

      if (org) q = q.where("org", "==", org);
      if (status && status !== "all") q = q.where("status", "==", status);

      if (fromD) q = q.where("occurredAt", ">=", toTs(fromD));
      if (toD) q = q.where("occurredAt", "<=", toTs(toD));

      q = q.orderBy("occurredAt", "desc");

      if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const nextCursor = items.length
        ? (items[items.length - 1]?.occurredAt?.toMillis ? items[items.length - 1].occurredAt.toMillis() : null)
        : null;

      return json(res, 200, { ok: true, data: items, nextCursor });
    }

    /* =================================================
       POST action approve/reject (admin)
       POST /api/finance?action=approve&id=DOC_ID
       POST /api/finance?action=reject&id=DOC_ID
       ================================================= */
    if (req.method === "POST" && (action === "approve" || action === "reject")) {
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("finance_transactions").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Transaction not found" });

      const cur = snap.data();
      const allowed = canAdminWrite(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
      if (!allowed) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

      const reason = cleanString((req.body || {}).reason || "", 300);

      const nextStatus = action === "approve" ? "approved" : "rejected";
      await ref.set({
        status: nextStatus,
        approval: {
          status: nextStatus,
          by: requesterUid,
          at: admin.firestore.FieldValue.serverTimestamp(),
          reason
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid
      }, { merge: true });

      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =================================================
       POST create (all logged users)
       ================================================= */
    if (req.method === "POST") {
      const payload = pickAllowed(req.body || {});
      const occurredD = parseDateOrMillis((req.body || {}).occurredAt) || new Date();

      if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

      if (!payload.neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required (body or user profile)" });
      if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
      if (!payload.type || !["income", "expense"].includes(payload.type)) return json(res, 400, { ok: false, error: "type must be income|expense" });
      if (!Number.isFinite(payload.amount) || payload.amount <= 0) return json(res, 400, { ok: false, error: "amount must be > 0" });

      // default status
      let status = "pending";

      // Admin boleh langsung approved (kalau body.forceApproved true)
      const forceApproved = parseBool((req.body || {}).forceApproved);
      if (requesterIsAdmin && forceApproved) {
        const allowed = canAdminWrite(superAdmin, requesterRole, payload.org, payload.neighborhoodId, requesterNeighborhoodId);
        if (!allowed) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });
        status = "approved";
      }

      const docData = {
        ...payload,
        occurredAt: toTs(occurredD),
        status,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: requesterUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: requesterUid,
        approval: {
          status,
          by: status === "approved" ? requesterUid : "",
          at: status === "approved" ? admin.firestore.FieldValue.serverTimestamp() : null,
          reason: ""
        }
      };

      const ref = await db.collection("finance_transactions").add(docData);
      const saved = await ref.get();
      return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
    }

    /* =================================================
       PUT update (admin only)
       ================================================= */
    if (req.method === "PUT") {
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("finance_transactions").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Transaction not found" });

      const cur = snap.data();
      const allowed = canAdminWrite(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
      if (!allowed) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

      const patch = pickAllowed(req.body || {});
      const occurredD = parseDateOrMillis((req.body || {}).occurredAt);

      // Non-super admin tidak boleh ganti org/neighborhoodId
      if (!superAdmin) {
        delete patch.neighborhoodId;
        delete patch.org;
      }

      const update = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (typeof v === "string" && v === "") continue;
        if (k === "amount" && (!Number.isFinite(v) || v <= 0)) continue;
        update[k] = v;
      }
      if (occurredD) update.occurredAt = toTs(occurredD);

      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      update.updatedBy = requesterUid;

      await ref.set(update, { merge: true });
      const after = await ref.get();
      return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
    }

    /* =================================================
       DELETE (admin only)
       ================================================= */
    if (req.method === "DELETE") {
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      const id = cleanString(req.query.id || "", 200);
      if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

      const ref = db.collection("finance_transactions").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { ok: false, error: "Transaction not found" });

      const cur = snap.data();
      const allowed = canAdminWrite(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
      if (!allowed) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

      await ref.delete();
      return json(res, 200, { ok: true, deleted: true, id });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
