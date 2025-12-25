/* ======================================================
   GUYUB - /api/inventory.js (Vercel Serverless)
   Collections:
     - inventory_items
     - inventory_loans
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

function canAdminScope(superAdmin, role, org, neighborhoodId, requesterNeighborhoodId) {
  if (superAdmin) return true;
  const myOrg = roleOrg(role || "");
  if (org && myOrg !== org) return false;
  if (requesterNeighborhoodId && neighborhoodId && requesterNeighborhoodId !== neighborhoodId) return false;
  return true;
}

/* ------------------ Payload pickers ------------------ */
function pickItem(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20), // rt|pkk|kt
    name: cleanString(body.name, 140),
    category: cleanString(body.category || "", 40),
    description: cleanString(body.description || "", 2000),
    photoUrl: cleanString(body.photoUrl || "", 1000),
    locationText: cleanString(body.locationText || "", 180),
    condition: cleanString(body.condition || "baik", 30), // baik/rusak ringan/rusak berat
    unit: cleanString(body.unit || "unit", 20),
    qtyTotal: Number(body.qtyTotal || 0),
    qtyAvailable: Number(body.qtyAvailable ?? body.qtyTotal ?? 0),
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => cleanString(t, 24)).filter(Boolean).slice(0, 12)
      : [],
    status: cleanString(body.status || "active", 20) // active/inactive
  };
}

function pickLoan(body = {}) {
  return {
    neighborhoodId: cleanString(body.neighborhoodId, 120),
    org: cleanString(body.org, 20),
    itemId: cleanString(body.itemId, 200),
    qty: Number(body.qty || 1),
    note: cleanString(body.note || "", 2000),
    purpose: cleanString(body.purpose || "", 140),
    needFrom: parseDateOrMillis(body.needFrom),
    needTo: parseDateOrMillis(body.needTo),
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

    // requester profile
    const requesterSnap = await db.collection("users").doc(requesterUid).get();
    const requester = requesterSnap.exists ? requesterSnap.data() : null;
    const requesterRole = requester?.role || "warga";
    const requesterNeighborhoodId = requester?.neighborhoodId || "";

    const superAdmin = requesterRole === "super_admin";
    const requesterIsAdmin = isAdminRole(requesterRole);

    const kind = cleanString(req.query.kind || "items", 20); // items|loans
    const action = cleanString(req.query.action || "", 30);

    /* =================================================
       INVENTORY ITEMS
       ================================================= */
    if (kind === "items") {
      // GET list (all logged users)
      if (req.method === "GET") {
        const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
        const org = cleanString(req.query.org || "", 20);
        const status = cleanString(req.query.status || "active", 20); // active|inactive|all
        const limit = Math.min(Number(req.query.limit || 50), 100);
        const cursor = req.query.cursor ? Number(req.query.cursor) : null; // millis of createdAt

        if (!neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
        if (org && !["rt", "pkk", "kt"].includes(org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });

        let q = db.collection("inventory_items").where("neighborhoodId", "==", neighborhoodId);
        if (org) q = q.where("org", "==", org);
        if (status && status !== "all") q = q.where("status", "==", status);

        q = q.orderBy("createdAt", "desc");
        if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

        const snap = await q.limit(limit).get();
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const nextCursor = items.length
          ? (items[items.length - 1]?.createdAt?.toMillis ? items[items.length - 1].createdAt.toMillis() : null)
          : null;

        return json(res, 200, { ok: true, data: items, nextCursor });
      }

      // Admin-only below
      if (!requesterIsAdmin) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

      // POST create item
      if (req.method === "POST") {
        const payload = pickItem(req.body || {});
        if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

        if (!payload.neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
        if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
        if (!payload.name) return json(res, 400, { ok: false, error: "name is required" });
        if (!Number.isFinite(payload.qtyTotal) || payload.qtyTotal < 0) return json(res, 400, { ok: false, error: "qtyTotal must be >= 0" });

        const okScope = canAdminScope(superAdmin, requesterRole, payload.org, payload.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

        // qtyAvailable clamp
        payload.qtyAvailable = Number.isFinite(payload.qtyAvailable) ? payload.qtyAvailable : payload.qtyTotal;
        if (payload.qtyAvailable > payload.qtyTotal) payload.qtyAvailable = payload.qtyTotal;
        if (payload.qtyAvailable < 0) payload.qtyAvailable = 0;

        const ref = await db.collection("inventory_items").add({
          ...payload,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: requesterUid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: requesterUid,
        });

        const saved = await ref.get();
        return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
      }

      // PUT update item
      if (req.method === "PUT") {
        const id = cleanString(req.query.id || "", 200);
        if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

        const ref = db.collection("inventory_items").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, error: "Item not found" });

        const cur = snap.data();
        const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

        const patch = pickItem(req.body || {});

        // Non-super cannot change org/neighborhoodId
        if (!superAdmin) {
          delete patch.neighborhoodId;
          delete patch.org;
        }

        // Build update
        const update = {};
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          if (typeof v === "string" && v === "") continue;
          if ((k === "qtyTotal" || k === "qtyAvailable") && (!Number.isFinite(v) || v < 0)) continue;
          update[k] = v;
        }

        // Clamp qtyAvailable to qtyTotal if both exist
        const nextQtyTotal = Number.isFinite(update.qtyTotal) ? update.qtyTotal : cur.qtyTotal;
        let nextQtyAvailable = Number.isFinite(update.qtyAvailable) ? update.qtyAvailable : cur.qtyAvailable;

        if (Number.isFinite(nextQtyTotal)) {
          if (nextQtyAvailable > nextQtyTotal) nextQtyAvailable = nextQtyTotal;
          if (nextQtyAvailable < 0) nextQtyAvailable = 0;
          update.qtyAvailable = nextQtyAvailable;
        }

        update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        update.updatedBy = requesterUid;

        await ref.set(update, { merge: true });
        const after = await ref.get();
        return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
      }

      // DELETE item
      if (req.method === "DELETE") {
        const id = cleanString(req.query.id || "", 200);
        if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

        const ref = db.collection("inventory_items").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, error: "Item not found" });

        const cur = snap.data();
        const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

        await ref.delete();
        return json(res, 200, { ok: true, deleted: true, id });
      }

      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* =================================================
       INVENTORY LOANS
       ================================================= */
    if (kind === "loans") {
      // GET list
      if (req.method === "GET") {
        const neighborhoodId = cleanString(req.query.neighborhoodId || requesterNeighborhoodId, 120);
        const org = cleanString(req.query.org || "", 20);
        const status = cleanString(req.query.status || "requested", 30); // requested|approved|returned|rejected|all
        const mine = parseBool(req.query.mine);
        const limit = Math.min(Number(req.query.limit || 30), 80);
        const cursor = req.query.cursor ? Number(req.query.cursor) : null; // millis of createdAt

        if (!neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
        if (org && !["rt", "pkk", "kt"].includes(org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });

        // Warga default hanya lihat milik sendiri
        const forceMine = !requesterIsAdmin && !superAdmin;
        const shouldMine = forceMine ? true : mine;

        let q = db.collection("inventory_loans").where("neighborhoodId", "==", neighborhoodId);
        if (org) q = q.where("org", "==", org);
        if (status && status !== "all") q = q.where("status", "==", status);
        if (shouldMine) q = q.where("createdBy", "==", requesterUid);

        q = q.orderBy("createdAt", "desc");
        if (cursor) q = q.startAfter(admin.firestore.Timestamp.fromMillis(cursor));

        const snap = await q.limit(limit).get();
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const nextCursor = items.length
          ? (items[items.length - 1]?.createdAt?.toMillis ? items[items.length - 1].createdAt.toMillis() : null)
          : null;

        return json(res, 200, { ok: true, data: items, nextCursor });
      }

      // POST request loan (all users)
      if (req.method === "POST" && !action) {
        const payload = pickLoan(req.body || {});
        if (!payload.neighborhoodId) payload.neighborhoodId = requesterNeighborhoodId;

        if (!payload.neighborhoodId) return json(res, 400, { ok: false, error: "neighborhoodId is required" });
        if (!payload.org || !["rt", "pkk", "kt"].includes(payload.org)) return json(res, 400, { ok: false, error: "org must be rt|pkk|kt" });
        if (!payload.itemId) return json(res, 400, { ok: false, error: "itemId is required" });
        if (!Number.isFinite(payload.qty) || payload.qty <= 0) return json(res, 400, { ok: false, error: "qty must be > 0" });

        // Check item exists + scope + stock
        const itemRef = db.collection("inventory_items").doc(payload.itemId);
        const itemSnap = await itemRef.get();
        if (!itemSnap.exists) return json(res, 404, { ok: false, error: "Item not found" });

        const item = itemSnap.data();
        if (item.neighborhoodId !== payload.neighborhoodId || item.org !== payload.org) {
          return json(res, 403, { ok: false, error: "Forbidden: item scope mismatch" });
        }
        if ((item.status || "active") !== "active") return json(res, 400, { ok: false, error: "Item inactive" });
        if (Number(item.qtyAvailable || 0) < payload.qty) return json(res, 400, { ok: false, error: "Stok tidak cukup" });

        const needFrom = payload.needFrom ? toTs(payload.needFrom) : null;
        const needTo = payload.needTo ? toTs(payload.needTo) : null;

        // Create loan request (status requested)
        const ref = await db.collection("inventory_loans").add({
          neighborhoodId: payload.neighborhoodId,
          org: payload.org,
          itemId: payload.itemId,
          itemName: cleanString(item.name || "", 140),

          qty: payload.qty,
          note: payload.note,
          purpose: payload.purpose,

          needFrom,
          needTo,

          status: "requested",
          approval: { status: "requested", by: "", at: null, reason: "" },
          returnedAt: null,

          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: requesterUid,
          createdByName: cleanString(requester?.name || "", 120),
          createdByPhone: cleanString(requester?.phone || "", 40),

          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: requesterUid,
        });

        const saved = await ref.get();
        return json(res, 201, { ok: true, data: { id: saved.id, ...saved.data() } });
      }

      // Admin-only actions approve/reject/return + admin edits/deletes
      const adminOnly = requesterIsAdmin || superAdmin;

      // action=approve / reject / return
      if (req.method === "POST" && (action === "approve" || action === "reject" || action === "return")) {
        if (!adminOnly) return json(res, 403, { ok: false, error: "Forbidden: admin only" });

        const id = cleanString(req.query.id || "", 200);
        if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

        const loanRef = db.collection("inventory_loans").doc(id);
        const loanSnap = await loanRef.get();
        if (!loanSnap.exists) return json(res, 404, { ok: false, error: "Loan not found" });

        const loan = loanSnap.data();

        // scope check
        const okScope = canAdminScope(superAdmin, requesterRole, loan.org, loan.neighborhoodId, requesterNeighborhoodId);
        if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });

        const reason = cleanString((req.body || {}).reason || "", 300);

        // transaction for stock integrity
        await db.runTransaction(async (tx) => {
          const itemRef = db.collection("inventory_items").doc(loan.itemId);
          const itemSnap = await tx.get(itemRef);
          if (!itemSnap.exists) throw new Error("Item not found");

          const item = itemSnap.data();
          const avail = Number(item.qtyAvailable || 0);
          const qty = Number(loan.qty || 0);

          if (action === "approve") {
            if (loan.status !== "requested") throw new Error("Only requested loan can be approved");
            if (avail < qty) throw new Error("Stok tidak cukup untuk approve");

            tx.update(itemRef, {
              qtyAvailable: avail - qty,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: requesterUid
            });

            tx.update(loanRef, {
              status: "approved",
              approval: { status: "approved", by: requesterUid, at: admin.firestore.FieldValue.serverTimestamp(), reason: "" },
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: requesterUid
            });
          }

          if (action === "reject") {
            if (loan.status !== "requested") throw new Error("Only requested loan can be rejected");

            tx.update(loanRef, {
              status: "rejected",
              approval: { status: "rejected", by: requesterUid, at: admin.firestore.FieldValue.serverTimestamp(), reason },
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: requesterUid
            });
          }

          if (action === "return") {
            if (loan.status !== "approved") throw new Error("Only approved loan can be returned");

            // return stock
            tx.update(itemRef, {
              qtyAvailable: avail + qty,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: requesterUid
            });

            tx.update(loanRef, {
              status: "returned",
              returnedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: requesterUid
            });
          }
        });

        const after = await db.collection("inventory_loans").doc(id).get();
        return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
      }

      // PUT loan update
      if (req.method === "PUT") {
        const id = cleanString(req.query.id || "", 200);
        if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

        const ref = db.collection("inventory_loans").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, error: "Loan not found" });

        const cur = snap.data();
        const isOwner = cur.createdBy === requesterUid;

        // scope admin check
        if (adminOnly && !superAdmin) {
          const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
          if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });
        }

        // warga boleh edit saat requested dan hanya miliknya
        if (!adminOnly && (!isOwner || cur.status !== "requested")) {
          return json(res, 403, { ok: false, error: "Forbidden: only owner can edit while requested" });
        }

        const body = req.body || {};
        const update = {};

        if (Object.prototype.hasOwnProperty.call(body, "note")) update.note = cleanString(body.note, 2000);
        if (Object.prototype.hasOwnProperty.call(body, "purpose")) update.purpose = cleanString(body.purpose, 140);

        const needFrom = parseDateOrMillis(body.needFrom);
        const needTo = parseDateOrMillis(body.needTo);
        if (needFrom) update.needFrom = toTs(needFrom);
        if (needTo) update.needTo = toTs(needTo);

        // admin boleh ubah status manual (opsional)
        if (adminOnly && Object.prototype.hasOwnProperty.call(body, "status")) {
          const st = cleanString(body.status, 30);
          const allowed = ["requested", "approved", "returned", "rejected"];
          if (allowed.includes(st)) update.status = st;
        }

        update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        update.updatedBy = requesterUid;

        await ref.set(update, { merge: true });
        const after = await ref.get();
        return json(res, 200, { ok: true, data: { id: after.id, ...after.data() } });
      }

      // DELETE loan
      if (req.method === "DELETE") {
        const id = cleanString(req.query.id || "", 200);
        if (!id) return json(res, 400, { ok: false, error: "id query param is required" });

        const ref = db.collection("inventory_loans").doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, error: "Loan not found" });

        const cur = snap.data();
        const isOwner = cur.createdBy === requesterUid;

        // admin scope check
        if (adminOnly) {
          const okScope = canAdminScope(superAdmin, requesterRole, cur.org, cur.neighborhoodId, requesterNeighborhoodId);
          if (!okScope) return json(res, 403, { ok: false, error: "Forbidden: scope mismatch" });
          await ref.delete();
          return json(res, 200, { ok: true, deleted: true, id });
        }

        // owner delete (requested only)
        if (isOwner && cur.status === "requested") {
          await ref.delete();
          return json(res, 200, { ok: true, deleted: true, id });
        }

        return json(res, 403, { ok: false, error: "Forbidden" });
      }

      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    return json(res, 400, { ok: false, error: "Invalid kind. Use kind=items or kind=loans" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
