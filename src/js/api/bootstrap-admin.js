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

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  try {
    initAdmin();
    const db = admin.firestore();

    const decoded = await verifyIdToken(req);
    if (!decoded) return json(res, 401, { ok: false, error: "Missing/invalid Authorization Bearer token" });

    const uid = decoded.uid;

    const lockRef = db.collection("system").doc("bootstrap");
    const userRef = db.collection("users").doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);

      // jika sudah pernah di-bootstrap, tolak
      if (lockSnap.exists && lockSnap.data()?.superAdminUid) {
        return { upgraded: false, reason: "super_admin already exists", superAdminUid: lockSnap.data().superAdminUid };
      }

      // Pastikan user doc ada
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        // kalau user doc belum ada (misal client belum sempat setDoc), kita buat minimal
        tx.set(userRef, {
          uid,
          email: decoded.email || "",
          name: decoded.name || decoded.email || "Super Admin",
          role: "super_admin",
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          verifiedBy: uid,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        tx.set(userRef, {
          role: "super_admin",
          status: "active",
          verifiedBy: uid,
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // Lock system doc
      tx.set(lockRef, {
        superAdminUid: uid,
        bootstrappedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return { upgraded: true, reason: "bootstrapped" };
    });

    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
