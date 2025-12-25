/* ==========================================
   GUYUB - ui.js
   Path: /public/assets/js/ui.js
   ========================================== */

/* =========================
   1) Utils dasar
   ========================= */
export function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

export function fmtRp(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

export function fmtDate(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("id-ID", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "—";
  }
}

/* =========================
   2) Inline Alert helper
   ========================= */
export function setAlert(el, msg = "", type = "info") {
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = msg;

  // style ringan (boleh diganti via Tailwind class di HTML)
  el.dataset.type = type;
}

/* =========================
   3) Loader Overlay
   ========================= */
let _loaderEl = null;

function ensureLoader() {
  if (_loaderEl) return _loaderEl;

  const wrap = document.createElement("div");
  wrap.id = "guyubLoader";
  wrap.className = "hidden fixed inset-0 z-[999]";

  wrap.innerHTML = `
    <div class="absolute inset-0 bg-black/60"></div>
    <div class="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto max-w-md px-5">
      <div class="rounded-3xl border border-white/10 bg-slate-950/80 backdrop-blur-xl p-5">
        <div class="flex items-center gap-3">
          <div class="h-10 w-10 rounded-2xl border border-white/10 bg-white/10 animate-pulse"></div>
          <div class="min-w-0">
            <div class="text-sm font-extrabold text-white">Memproses…</div>
            <div id="guyubLoaderText" class="mt-1 text-xs text-white/70 truncate">Mohon tunggu sebentar</div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  _loaderEl = wrap;
  return _loaderEl;
}

export function showLoader(text = "Mohon tunggu sebentar") {
  const el = ensureLoader();
  el.classList.remove("hidden");
  const t = document.getElementById("guyubLoaderText");
  if (t) t.textContent = text;
}

export function hideLoader() {
  const el = ensureLoader();
  el.classList.add("hidden");
}

/* =========================
   4) Toast
   ========================= */
let _toastTimer = null;

function ensureToast() {
  let el = document.getElementById("guyubToast");
  if (el) return el;

  el = document.createElement("div");
  el.id = "guyubToast";
  el.className = "hidden fixed left-1/2 -translate-x-1/2 z-[1000] w-[min(520px,calc(100%-24px))]";
  el.style.bottom = "calc(env(safe-area-inset-bottom, 0px) + 86px)";
  el.innerHTML = `
    <div id="guyubToastCard" class="rounded-2xl border border-white/10 bg-slate-950/80 backdrop-blur-xl px-4 py-3 shadow-2xl">
      <div class="flex items-start gap-3">
        <div id="guyubToastDot" class="mt-1 h-2.5 w-2.5 rounded-full bg-white/60"></div>
        <div class="min-w-0">
          <div id="guyubToastMsg" class="text-sm font-semibold text-white">—</div>
          <div id="guyubToastSub" class="mt-0.5 text-xs text-white/70 hidden">—</div>
        </div>
        <button id="guyubToastClose" class="ml-auto rounded-xl border border-white/10 bg-white/5 px-3 py-1 text-xs font-extrabold text-white/90 hover:bg-white/10">
          OK
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById("guyubToastClose").addEventListener("click", () => toastHide());
  return el;
}

export function toast(msg, type = "info", sub = "") {
  const el = ensureToast();
  const card = document.getElementById("guyubToastCard");
  const dot = document.getElementById("guyubToastDot");
  const tMsg = document.getElementById("guyubToastMsg");
  const tSub = document.getElementById("guyubToastSub");

  tMsg.textContent = msg || "—";
  if (sub) {
    tSub.textContent = sub;
    tSub.classList.remove("hidden");
  } else {
    tSub.classList.add("hidden");
  }

  // gaya berdasarkan type (tanpa set warna spesifik di tailwind config)
  card.classList.remove("border-emerald-400/20", "border-rose-400/20", "border-white/10");
  dot.classList.remove("bg-emerald-300", "bg-rose-300", "bg-white/60");

  if (type === "success") {
    card.classList.add("border-emerald-400/20");
    dot.classList.add("bg-emerald-300");
  } else if (type === "error") {
    card.classList.add("border-rose-400/20");
    dot.classList.add("bg-rose-300");
  } else {
    card.classList.add("border-white/10");
    dot.classList.add("bg-white/60");
  }

  el.classList.remove("hidden");

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastHide(), 2600);
}

export function toastHide() {
  const el = ensureToast();
  el.classList.add("hidden");
  clearTimeout(_toastTimer);
}

/* =========================
   5) Confirm Modal (async)
   ========================= */
let _confirmResolve = null;

function ensureConfirm() {
  let el = document.getElementById("guyubConfirm");
  if (el) return el;

  el = document.createElement("div");
  el.id = "guyubConfirm";
  el.className = "hidden fixed inset-0 z-[1001]";
  el.innerHTML = `
    <div class="absolute inset-0 bg-black/60"></div>
    <div class="absolute inset-x-0 bottom-0 mx-auto max-w-md px-5 pb-5">
      <div class="rounded-3xl border border-white/10 bg-slate-950/85 backdrop-blur-xl p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div id="guyubConfirmTitle" class="text-base font-extrabold text-white">Konfirmasi</div>
            <div id="guyubConfirmMsg" class="mt-1 text-sm text-white/80">—</div>
          </div>
          <button id="guyubConfirmX" class="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-extrabold text-white hover:bg-white/10">Tutup</button>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3">
          <button id="guyubConfirmCancel" class="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-extrabold text-white hover:bg-white/10">
            Batal
          </button>
          <button id="guyubConfirmOk" class="rounded-2xl bg-white px-4 py-3 text-sm font-extrabold text-slate-950">
            Ya, Lanjut
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  const close = (val) => {
    el.classList.add("hidden");
    if (_confirmResolve) _confirmResolve(val);
    _confirmResolve = null;
  };

  document.getElementById("guyubConfirmOk").addEventListener("click", () => close(true));
  document.getElementById("guyubConfirmCancel").addEventListener("click", () => close(false));
  document.getElementById("guyubConfirmX").addEventListener("click", () => close(false));
  el.addEventListener("click", (e) => { if (e.target === el) close(false); });

  return el;
}

export function confirmModal(message, title = "Konfirmasi") {
  const el = ensureConfirm();
  document.getElementById("guyubConfirmTitle").textContent = title;
  document.getElementById("guyubConfirmMsg").textContent = message || "—";
  el.classList.remove("hidden");

  return new Promise((resolve) => {
    _confirmResolve = resolve;
  });
}

/* =========================
   6) Tabs binder (simple)
   HTML pattern:
   - button.tabBtn[data-tab="x"]
   - section#tab_x
   ========================= */
export function bindTabs({ btnSelector = ".tabBtn", prefix = "tab_" } = {}) {
  const btns = Array.from(document.querySelectorAll(btnSelector));
  if (!btns.length) return;

  const setTab = (name) => {
    btns.forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle("bg-white/10", active);
      b.classList.toggle("font-extrabold", active);
      b.classList.toggle("text-slate-300/80", !active);
    });

    btns.forEach((b) => {
      const tab = b.dataset.tab;
      const el = document.getElementById(prefix + tab);
      if (el) el.classList.toggle("hidden", tab !== name);
    });
  };

  btns.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  setTab(btns[0].dataset.tab);
  return { setTab };
}

/* =========================
   7) Safe-area bottom padding helper
   ========================= */
export function applySafeAreaPadding(el, extra = 16) {
  if (!el) return;
  el.style.paddingBottom = `calc(env(safe-area-inset-bottom, 0px) + ${extra}px)`;
}
