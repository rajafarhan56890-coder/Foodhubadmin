import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, getDoc, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
// Firebase Storage is no longer used anywhere in this file. Product photos
// and payment QR codes are uploaded directly to Cloudinary (unsigned upload
// preset) via plain fetch() below — see uploadToCloudinary(). Firestore is
// still the source of truth for all data: only the resulting secure_url
// coming back from Cloudinary is ever saved, into the existing imageUrl /
// *QrUrl fields, exactly as before.
const CLOUDINARY_CLOUD_NAME = 'f3gcn0it';
const CLOUDINARY_UPLOAD_PRESET = 'foodhub_upload';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

// firebase-config.js is normally one folder above this file (this page is
// meant to live at admin/index.html, next to firebase-config.js at the site
// root). A STATIC `import ... from '../firebase-config.js'` here would mean
// that if this file ever ends up in a different folder, that one failed
// import silently kills the ENTIRE module — nothing below it runs at all,
// not even the login form's submit handler — with just a console error and
// no visible sign of what went wrong. Loading it dynamically with a couple
// of fallback locations avoids that trap and gives a clear on-screen reason
// instead of a page that just "does nothing".
let configModule = null;
let configLoadError = null;
const CONFIG_PATHS = ['../firebase-config.js', './firebase-config.js', '/firebase-config.js'];
for (const path of CONFIG_PATHS) {
  try {
    configModule = await import(path);
    break;
  } catch (err) {
    configLoadError = err;
  }
}

// The Admin Panel cannot do anything useful without Firebase, so a missing
// or invalid config gets a blocking, full-screen notice (replacing the
// login card) rather than a half-broken login form or a console crash.
let auth = null;
let db = null;
let firebaseReady = false;

if (!configModule) {
  console.error('FoodHub Admin: could not load firebase-config.js from any of', CONFIG_PATHS, configLoadError);
  document.getElementById('login-screen').innerHTML = `
    <div class="login-card" style="max-width:440px;">
      <div class="login-brand"><div class="login-brand-mark" style="background:var(--chili);">!</div><div class="login-brand-name">SETUP NEEDED</div></div>
      <p class="login-sub" style="margin-top:10px;">Couldn't load <code style="background:rgba(250,246,238,.1);padding:1px 5px;border-radius:4px;">firebase-config.js</code>.</p>
      <p class="cell-muted" style="text-align:left;line-height:1.6;">This page expects <code style="background:rgba(250,246,238,.1);padding:1px 5px;border-radius:4px;">firebase-config.js</code> one folder above it — e.g. if this file is saved as <code style="background:rgba(250,246,238,.1);padding:1px 5px;border-radius:4px;">admin/index.html</code>, then <code style="background:rgba(250,246,238,.1);padding:1px 5px;border-radius:4px;">firebase-config.js</code> should sit next to your main <code style="background:rgba(250,246,238,.1);padding:1px 5px;border-radius:4px;">index.html</code> at the site root. Move the file so that layout matches, then reload this page.</p>
    </div>`;
} else {
  const { initializeFirebaseApp, renderFirebaseConfigError } = configModule;
  try {
    const app = initializeFirebaseApp();
    auth = getAuth(app);
    db = getFirestore(app);
    firebaseReady = true;
  } catch (err) {
    console.error('FoodHub Admin: Firebase is not configured.', err);
    renderFirebaseConfigError(err.message || 'Firebase is not configured.', {
      mode: 'fullscreen',
      targetSelector: '#login-screen',
    });
  }
}


/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
let ADMIN_CURRENCY = 'Rs ';
function money(n) { return `${ADMIN_CURRENCY}${(Number(n) || 0).toFixed(2)}`; }
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
let toastTimer = null;
function toast(msg) {
  const el = $('admin-toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}
function statusBadgeClass(status) { return 'badge-' + String(status || '').toLowerCase().replace(/\s+/g, ''); }
function confirmAction(message) { return window.confirm(message); }

/* ---------- Auth ---------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  if (!firebaseReady) {
    $('login-error').textContent = 'Firebase is not configured — see the notice above, then reload this page.';
    return;
  }
  $('login-submit').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-password').value);
  } catch (err) {
    $('login-error').textContent = 'Sign-in failed — check your email and password.';
    console.warn(err);
  }
  $('login-submit').disabled = false;
});

$('logout-btn').addEventListener('click', () => { if (auth) signOut(auth); });

let unsubscribers = [];
function teardownListeners() { unsubscribers.forEach((u) => u()); unsubscribers = []; settingsFormPopulated = false; paymentsFormPopulated = false; websiteContentFormPopulated = false; }

function showLoginScreen() {
  $('login-screen').style.display = 'flex';
  $('access-check-screen').style.display = 'none';
  $('app-shell').classList.remove('visible');
}
function showAccessCheckScreen() {
  $('login-screen').style.display = 'none';
  $('access-check-screen').style.display = 'flex';
  $('app-shell').classList.remove('visible');
}
function showDashboard(user) {
  $('login-screen').style.display = 'none';
  $('access-check-screen').style.display = 'none';
  $('app-shell').classList.add('visible');
  $('admin-email').textContent = user.email;
  startListeners();
}

// Runs the admins/{uid} authorization check for the currently signed-in
// user and updates the UI accordingly. Split out from the auth listener so
// the Access Check screen's "Retry" button can re-run it without a full
// sign-out/sign-in round trip.
async function verifyAdminAccess(user) {
  let adminDoc;
  try {
    adminDoc = await getDoc(doc(db, 'admins', user.uid));
  } catch (err) {
    console.error('FoodHub Admin: admins/{uid} read failed.', err);
    $('access-check-title').textContent = 'Could not verify admin access.';
    $('access-check-detail').textContent = err && err.code
      ? `Firestore error: ${err.code}. This almost always means firestore.rules hasn't been published yet, or doesn't match the "admins" collection rule.`
      : 'An unexpected error occurred while checking your access.';
    $('access-check-email').value = user.email || '';
    $('access-check-uid').value = user.uid;
    showAccessCheckScreen();
    return false;
  }
  if (!adminDoc.exists()) {
    $('access-check-title').textContent = 'This account is not authorized as an admin.';
    $('access-check-detail').textContent = '';
    $('access-check-email').value = user.email || '';
    $('access-check-uid').value = user.uid;
    showAccessCheckScreen();
    return false;
  }
  return true;
}

$('access-check-retry-btn').addEventListener('click', async () => {
  if (!auth.currentUser) return;
  $('access-check-detail').textContent = 'Checking…';
  const ok = await verifyAdminAccess(auth.currentUser);
  if (ok) showDashboard(auth.currentUser);
});
$('access-check-signout-btn').addEventListener('click', () => { if (auth) signOut(auth); });
$('access-check-copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('access-check-uid').value);
    toast('UID copied.');
  } catch (err) {
    $('access-check-uid').select();
  }
});

// Only wired up when Firebase actually initialized — otherwise the login
// screen already shows the full-screen configuration notice and there is
// nothing further to set up.
if (firebaseReady) {
  onAuthStateChanged(auth, async (user) => {
    teardownListeners();
    if (!user) {
      showLoginScreen();
      return;
    }
    const authorized = await verifyAdminAccess(user); // paints the access-check screen itself on failure
    if (authorized) showDashboard(user);
  });
}

/* ---------- Sidebar navigation ---------- */
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(`view-${btn.getAttribute('data-view')}`).classList.add('active');
    $('sidebar').classList.remove('open');
  });
});
$('mobile-menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

/* ---------- Generic modal ---------- */
let modalOnSave = null;
function openModal(title, bodyHtml, onSave) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  modalOnSave = onSave;
  $('modal-overlay').classList.add('visible');
}
function closeModal() { $('modal-overlay').classList.remove('visible'); modalOnSave = null; }
$('modal-close').addEventListener('click', closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });
$('modal-save').addEventListener('click', async () => {
  if (!modalOnSave) return;
  const btn = $('modal-save');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // BUG FIX: this used to race modalOnSave() (which awaits the image
    // upload, then the Firestore write) against a bare 45s setTimeout via
    // Promise.race(). Whichever settled first won — so on a slow upload,
    // a big photo, or just an unlucky moment, the timeout fired first and
    // its generic "Save request timed out — the network may be blocking
    // Firebase" message replaced whatever the *real* Storage/Firestore
    // error was (or wasn't — the save might still complete a moment
    // later, invisibly, after the modal already reported failure).
    // Awaiting modalOnSave() directly means we always see the actual
    // outcome: it resolves when the real save finishes, or rejects with
    // whatever error Storage/Firestore actually threw.
    await modalOnSave();
    closeModal();
  } catch (err) {
    console.error(err);
    const code = err && err.code ? ` (${err.code})` : '';
    const reason = err && err.message === 'validation' ? '' : (err && err.message ? `: ${err.message}${code}` : code);
    toast(`Save failed${reason || ' — check the console for details.'}`);
  } finally {
    // Guarantees the button is always re-enabled once the save attempt
    // settles, on every path (success, validation throw, real error) —
    // no path through this handler can leave "Saving…" stuck.
    btn.disabled = false; btn.textContent = originalLabel;
  }
});

/* =========================================================
   PRODUCTS
   ========================================================= */
let productsCache = [];
let categoriesCache = [];

function renderProductsTable() {
  const q = ($('products-search').value || '').toLowerCase();
  const rows = productsCache.filter((p) => !q || (p.name || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  $('products-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="7">No products yet — click "Add Product" to create your first dish.</td></tr>`
    : rows.map((p) => `
      <tr>
        <td>${p.imageUrl ? `<img class="cell-thumb" src="${esc(p.imageUrl)}" alt="" />` : '<div class="cell-thumb"></div>'}</td>
        <td><div class="cell-name">${esc(p.name)}${p.vegetarian ? ' 🌱' : ''}</div><div class="cell-muted">${esc(p.restaurant || '')}</div></td>
        <td>${esc(p.category)}</td>
        <td class="mono">${money(p.price)}</td>
        <td class="mono">★ ${(Number(p.rating) || 4.5).toFixed(1)}</td>
        <td><span class="badge ${p.active ? 'badge-active' : 'badge-inactive'}">${p.active ? 'Active' : 'Hidden'}</span></td>
        <td>
          <button class="icon-btn" data-edit-product="${p.id}">✎</button>
          <button class="icon-btn" data-delete-product="${p.id}">🗑</button>
        </td>
      </tr>`).join('');
}
$('products-search').addEventListener('input', renderProductsTable);

function categoryOptionsHTML(selected) {
  if (categoriesCache.length === 0) return `<option value="">No categories yet — add one first</option>`;
  return categoriesCache.map((c) => `<option value="${esc(c.filterKey)}" ${c.filterKey === selected ? 'selected' : ''}>${esc(c.name)} (${esc(c.filterKey)})</option>`).join('');
}

// Lists every homepage section (in display order) so a product can be
// assigned to one directly from the Products page. Reads from
// sectionsCache, which is kept live by the Homepage Sections listener
// (see startListeners()) — new sections show up here automatically as
// soon as they're saved, with no page reload needed.
function sectionOptionsHTML(selected) {
  const none = `<option value="" ${!selected ? 'selected' : ''}>— None —</option>`;
  if (sectionsCache.length === 0) return none + `<option value="" disabled>No homepage sections yet — create one first</option>`;
  const sorted = sectionsCache.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return none + sorted.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.icon || '')} ${esc(s.title)}</option>`).join('');
}

function productFormHTML(p = {}) {
  const sizes = p.sizePrices || {};
  const isPizzaCategory = String(p.category || '').trim().toLowerCase() === 'pizza';
  const sizesOn = p.hasSizeOptions === true || (p.hasSizeOptions === undefined && isPizzaCategory);
  return `
    <div class="field"><label>Dish Name</label><input id="pf-name" value="${esc(p.name || '')}" /></div>
    <div class="field"><label>Description</label><textarea id="pf-description" rows="2">${esc(p.description || '')}</textarea></div>
    <div class="form-row">
      <div class="field"><label>Category</label><select id="pf-category">${categoryOptionsHTML(p.category)}</select></div>
      <div class="field"><label>Price (PKR)</label><input id="pf-price" type="number" step="0.01" value="${p.price ?? ''}" /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Restaurant / Kitchen</label><input id="pf-restaurant" value="${esc(p.restaurant || '')}" /></div>
      <div class="field"><label>Rating (0–5)</label><input id="pf-rating" type="number" step="0.1" min="0" max="5" value="${p.rating ?? 4.5}" /></div>
    </div>
    <div class="field"><label>Homepage Section</label><select id="pf-section">${sectionOptionsHTML(p.sectionId)}</select></div>
    <div class="field"><label>Badge (optional, e.g. BESTSELLER, NEW)</label><input id="pf-badge" value="${esc(p.badge || '')}" /></div>
    <div class="field">
      <label>Product Image</label>
      <img class="image-preview ${p.imageUrl ? 'visible' : ''}" id="pf-image-preview" src="${esc(p.imageUrl || '')}" />
      <input type="file" id="pf-image-file" accept="image/*" />
      <div class="cell-muted" style="margin-top:6px;">Leave empty to keep the current image, or to fall back to a live stock photo for the category.</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="pf-vegetarian" ${p.vegetarian ? 'checked' : ''} /><label for="pf-vegetarian">Vegetarian (drives the storefront's "Vegetarian mode" filter)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="pf-active" ${p.active !== false ? 'checked' : ''} /><label for="pf-active">Active (visible on storefront)</label></div>

    <!-- ---- Size Options (Pizza and beyond) ----
         Any product can opt into a size popup on the storefront (Small/
         Medium/Large/Extra Large), each with its own price. Pizza gets this
         on by default; any other product can turn it on too — the same
         mechanism will work for future product types without code changes. -->
    <div class="checkbox-row" style="margin-top:16px;">
      <input type="checkbox" id="pf-has-sizes" ${sizesOn ? 'checked' : ''} />
      <label for="pf-has-sizes">Offer Size Options (Small / Medium / Large / Extra Large, each with its own price)</label>
    </div>
    <div id="pf-size-pricing" class="form-row" style="${sizesOn ? '' : 'display:none;'} flex-wrap:wrap; gap:10px; margin-top:8px;">
      <div class="field" style="min-width:110px;"><label>Small (PKR)</label><input id="pf-size-small" type="number" step="0.01" value="${sizes.small ?? ''}" placeholder="auto" /></div>
      <div class="field" style="min-width:110px;"><label>Medium (PKR)</label><input id="pf-size-medium" type="number" step="0.01" value="${sizes.medium ?? ''}" placeholder="auto" /></div>
      <div class="field" style="min-width:110px;"><label>Large (PKR)</label><input id="pf-size-large" type="number" step="0.01" value="${sizes.large ?? ''}" placeholder="auto" /></div>
      <div class="field" style="min-width:110px;"><label>Extra Large (PKR)</label><input id="pf-size-xlarge" type="number" step="0.01" value="${sizes.xlarge ?? ''}" placeholder="auto" /></div>
    </div>
    <div class="cell-muted" id="pf-size-pricing-hint" style="${sizesOn ? '' : 'display:none;'} margin-top:4px;">Leave any size blank to fall back to a sensible multiple of the base Price above.</div>
  `;
}

// Reads the four size-price inputs into a sparse {small,medium,large,xlarge}
// map — only sizes the admin actually typed a number into are included, so
// any left blank keep using the storefront's default multiplier fallback.
function readSizePricesFromForm() {
  const map = {};
  [['small', 'pf-size-small'], ['medium', 'pf-size-medium'], ['large', 'pf-size-large'], ['xlarge', 'pf-size-xlarge']].forEach(([key, id]) => {
    const el = $(id);
    if (!el) return;
    const raw = el.value.trim();
    if (raw === '') return;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) map[key] = n;
  });
  return map;
}

// Wires the "Offer Size Options" checkbox to show/hide the four price
// fields. Safe to call every time the modal opens (mirrors
// wireSectionFormEvents' pattern for the Homepage Sections form).
function wireProductSizeFormEvents() {
  const checkbox = $('pf-has-sizes');
  const panel = $('pf-size-pricing');
  const hint = $('pf-size-pricing-hint');
  if (!checkbox || !panel) return;
  checkbox.addEventListener('change', () => {
    panel.style.display = checkbox.checked ? '' : 'none';
    if (hint) hint.style.display = checkbox.checked ? '' : 'none';
  });
}

$('add-product-btn').addEventListener('click', () => {
  openModal('Add Product', productFormHTML(), async () => {
    const file = $('pf-image-file').files[0];
    const name = $('pf-name').value.trim();
    const category = $('pf-category').value;
    if (!name || !category) { toast('Name and category are required.'); throw new Error('validation'); }
    const data = {
      name,
      description: $('pf-description').value.trim(),
      category,
      price: parseFloat($('pf-price').value) || 0,
      restaurant: $('pf-restaurant').value.trim(),
      rating: parseFloat($('pf-rating').value) || 4.5,
      badge: $('pf-badge').value.trim(),
      sectionId: $('pf-section').value || '',
      vegetarian: $('pf-vegetarian').checked,
      active: $('pf-active').checked,
      hasSizeOptions: $('pf-has-sizes').checked,
      sizePrices: $('pf-has-sizes').checked ? readSizePricesFromForm() : {},
      imageUrl: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    // Pre-generate the document ID so the photo (if any) can be uploaded to
    // its final path and included in the SAME write as the rest of the
    // details — avoids the old "product saved, photo upload fails/timeouts
    // separately" split-write problem.
    const ref = doc(collection(db, 'products'));
    if (file) data.imageUrl = await uploadToCloudinary(file);
    await setDoc(ref, data);
    toast(file ? 'Product added with photo.' : 'Product added.');
  });
  $('pf-image-file').addEventListener('change', previewImage);
  wireProductSizeFormEvents();
});

document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-product]')?.getAttribute('data-edit-product');
  if (editId) {
    const p = productsCache.find((x) => x.id === editId);
    openModal('Edit Product', productFormHTML(p), async () => {
      const file = $('pf-image-file').files[0];
      const name = $('pf-name').value.trim();
      const category = $('pf-category').value;
      if (!name || !category) { toast('Name and category are required.'); throw new Error('validation'); }
      const data = {
        name,
        description: $('pf-description').value.trim(),
        category,
        price: parseFloat($('pf-price').value) || 0,
        restaurant: $('pf-restaurant').value.trim(),
        rating: parseFloat($('pf-rating').value) || 4.5,
        badge: $('pf-badge').value.trim(),
        sectionId: $('pf-section').value || '',
        vegetarian: $('pf-vegetarian').checked,
        active: $('pf-active').checked,
        hasSizeOptions: $('pf-has-sizes').checked,
        sizePrices: $('pf-has-sizes').checked ? readSizePricesFromForm() : {},
        updatedAt: serverTimestamp(),
      };
      // Upload the new photo (if one was picked) BEFORE writing, so the
      // image URL lands in the same update as every other field.
      if (file) data.imageUrl = await uploadToCloudinary(file);
      await updateDoc(doc(db, 'products', editId), data);
      // Note: unlike Firebase Storage's deleteObject(), Cloudinary's unsigned
      // upload API has no client-safe way to delete the old image (deleting
      // requires a signed request using your API secret, which must stay
      // server-side). The old photo is intentionally left alone here — it
      // will remain in your Cloudinary media library and can be cleaned up
      // there manually or via a server-side job if desired.
      toast(file ? 'Product updated with new photo.' : 'Product updated.');
    });
    $('pf-image-file').addEventListener('change', previewImage);
    wireProductSizeFormEvents();
  }
  const delId = e.target.closest('[data-delete-product]')?.getAttribute('data-delete-product');
  if (delId && confirmAction('Delete this product? This cannot be undone.')) {
    deleteDoc(doc(db, 'products', delId))
      .then(() => {
        toast('Product deleted.');
        // Cloudinary's unsigned upload API has no client-safe delete (that
        // requires a signed, server-side request), so the photo — if any —
        // is intentionally left in your Cloudinary media library rather
        // than attempting a Firebase Storage deleteObject() that no longer
        // applies here.
      })
      .catch((err) => { toast('Delete failed.'); console.error(err); });
  }
});

function previewImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const preview = $('pf-image-preview');
  preview.src = URL.createObjectURL(file);
  preview.classList.add('visible');
}
// Bounds ONLY the network upload itself — not the whole save. This is
// deliberately narrower than an outer Promise.race() around the entire
// save flow: it can never clobber a real Firestore error or a
// slow-but-successful write, because it only wraps the Cloudinary POST
// itself via AbortController, and returns/throws before setDoc/updateDoc
// are ever reached.
//
// ROOT CAUSE OF THE ORIGINAL "stuck Saving…" BUG: this project used to
// upload to Firebase Storage here, but Storage was never actually wired
// up for this project (see firebase-config.js / SETUP.md) — the fetch to
// firebasestorage.googleapis.com just hung until the browser's own socket
// timeout eventually fired, ~30s later, with a vague error. Cloudinary is
// now the ONLY image host used by this file (product photos AND payment
// QR codes), and every upload is wrapped in an explicit, bounded timeout
// below so Save always settles one way or another well within 30s.
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 30000;

// A Cloudinary secure_url should always be a valid https:// URL. We verify
// this before ever writing it into Firestore, so a malformed or missing
// URL (e.g. from a corrupted response) can never end up saved.
function isValidImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !!parsed.hostname;
  } catch (_) {
    return false;
  }
}

async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOUDINARY_UPLOAD_TIMEOUT_MS);

  console.log('[Cloudinary] POST', CLOUDINARY_UPLOAD_URL, '| preset:', CLOUDINARY_UPLOAD_PRESET, '| file:', file?.name, file?.type, file?.size, 'bytes');

  let response;
  try {
    response = await fetch(CLOUDINARY_UPLOAD_URL, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    console.error('[Cloudinary] Request to', CLOUDINARY_UPLOAD_URL, 'failed before a response was received:', err);
    if (err.name === 'AbortError') {
      throw new Error(`Image upload timed out after ${CLOUDINARY_UPLOAD_TIMEOUT_MS / 1000}s — Cloudinary never responded. Check your internet connection, or that ${CLOUDINARY_UPLOAD_URL} isn't being blocked by an ad-blocker, browser extension, or firewall.`);
    }
    // A fetch() that rejects with a plain TypeError before any response
    // arrives is almost always either no network connectivity, a DNS
    // failure on the cloud name, or the browser blocking the request as a
    // CORS violation (Cloudinary's own endpoint sends permissive CORS
    // headers, so a CORS error here usually means the request never
    // reached Cloudinary at all — e.g. it was blocked locally first).
    throw new Error(`Image upload failed — could not reach Cloudinary (${err.message || 'network error'}). This is typically a network/CORS issue rather than a problem with your Cloudinary account.`);
  } finally {
    clearTimeout(timeoutId);
  }

  console.log('[Cloudinary] Response status:', response.status, response.statusText);
  const bodyText = await response.text().catch(() => '');
  console.log('[Cloudinary] Response body:', bodyText);

  let result = null;
  try {
    result = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    // Non-JSON body — fall through, handled below.
  }

  if (!response.ok) {
    const cloudinaryMessage = result?.error?.message;
    const detail = cloudinaryMessage
      || (response.status === 400 ? 'Bad request — the Upload Preset is likely missing, misspelled, or not configured as "Unsigned" in your Cloudinary settings.'
        : response.status === 401 ? 'Unauthorized — check that the Cloud Name is correct.'
        : response.status === 404 ? 'Not found — the Cloud Name is likely incorrect.'
        : `HTTP ${response.status} ${response.statusText}`);
    throw new Error(`Image upload failed: ${detail}`);
  }

  if (!result) {
    throw new Error('Image upload failed — Cloudinary returned a response that could not be parsed as JSON.');
  }
  if (!isValidImageUrl(result.secure_url)) {
    // Never let an invalid/missing URL reach Firestore.
    throw new Error('Image upload failed — Cloudinary did not return a valid secure_url.');
  }

  return result.secure_url;
}

/* =========================================================
   CATEGORIES
   ========================================================= */
function renderCategoriesTable() {
  $('categories-table-body').innerHTML = categoriesCache.length === 0
    ? `<tr class="empty-row"><td colspan="6">No categories yet — click "Add Category".</td></tr>`
    : categoriesCache.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((c) => `
      <tr>
        <td style="font-size:18px;">${esc(c.emoji || '🍽️')}</td>
        <td class="cell-name">${esc(c.name)}</td>
        <td class="mono">${esc(c.filterKey)}</td>
        <td class="mono">${c.order ?? 0}</td>
        <td><span class="badge ${c.active !== false ? 'badge-active' : 'badge-inactive'}">${c.active !== false ? 'Active' : 'Hidden'}</span></td>
        <td><button class="icon-btn" data-edit-category="${c.id}">✎</button><button class="icon-btn" data-delete-category="${c.id}">🗑</button></td>
      </tr>`).join('');
}
function categoryFormHTML(c = {}) {
  return `
    <div class="form-row">
      <div class="field"><label>Name</label><input id="cf-name" value="${esc(c.name || '')}" /></div>
      <div class="field"><label>Emoji</label><input id="cf-emoji" value="${esc(c.emoji || '')}" maxlength="4" /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Filter Key (slug, e.g. "pizza")</label><input id="cf-filterKey" value="${esc(c.filterKey || '')}" /></div>
      <div class="field"><label>Order</label><input id="cf-order" type="number" value="${c.order ?? 0}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cf-active" ${c.active !== false ? 'checked' : ''} /><label for="cf-active">Active (visible on storefront)</label></div>
  `;
}
$('add-category-btn').addEventListener('click', () => {
  openModal('Add Category', categoryFormHTML(), async () => {
    const filterKey = $('cf-filterKey').value.trim().toLowerCase().replace(/\s+/g, '-');
    const name = $('cf-name').value.trim();
    if (!name || !filterKey) { toast('Name and filter key are required.'); throw new Error('validation'); }
    await addDoc(collection(db, 'categories'), {
      name, filterKey, emoji: $('cf-emoji').value.trim(), order: parseInt($('cf-order').value, 10) || 0,
      active: $('cf-active').checked, createdAt: serverTimestamp(),
    });
    toast('Category added.');
  });
});
document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-category]')?.getAttribute('data-edit-category');
  if (editId) {
    const c = categoriesCache.find((x) => x.id === editId);
    openModal('Edit Category', categoryFormHTML(c), async () => {
      const filterKey = $('cf-filterKey').value.trim().toLowerCase().replace(/\s+/g, '-');
      await updateDoc(doc(db, 'categories', editId), {
        name: $('cf-name').value.trim(), filterKey, emoji: $('cf-emoji').value.trim(),
        order: parseInt($('cf-order').value, 10) || 0, active: $('cf-active').checked,
      });
      toast('Category updated.');
    });
  }
  const delId = e.target.closest('[data-delete-category]')?.getAttribute('data-delete-category');
  if (delId && confirmAction('Delete this category? Products using it will keep the old category text.')) {
    deleteDoc(doc(db, 'categories', delId)).then(() => toast('Category deleted.'));
  }
});

/* =========================================================
   HOMEPAGE SECTIONS
   ---------------------------------------------------------
   Lets the admin manage the rails shown on the storefront homepage
   (Trending, Popular, Recommended, Chef's Special, etc.) without
   touching code: add/edit/delete sections, reorder them, show/hide
   them, and — for "Manual" sections — hand-pick exactly which
   products appear. "Automatic" sections keep using the storefront's
   existing algorithm (e.g. trending/recommended logic); the admin
   here just controls their title, icon, order and visibility.
   Stored in the `homepageSections` Firestore collection.
   ========================================================= */
let sectionsCache = [];

// The rails already live on the homepage today — seeded here so the
// admin sees a fully-populated list on first visit instead of an
// empty table. "Add Default Sections" only adds whichever of these
// don't already exist yet (matched by key), so it's safe to click
// more than once.
const DEFAULT_HOMEPAGE_SECTIONS = [
  { key: 'trending', title: 'Trending', icon: '🔥', subtitle: "What everyone's ordering right now", type: 'auto', order: 0 },
  { key: 'popular', title: 'Popular', icon: '⭐', subtitle: 'Customer favorites', type: 'auto', order: 1 },
  { key: 'recommended', title: 'Recommended For You', icon: '✨', subtitle: 'Picked based on taste and order history', type: 'auto', order: 2 },
  { key: 'chefs-special', title: "Chef's Special", icon: '👨\u200d🍳', subtitle: 'Handpicked by our kitchens', type: 'manual', order: 3 },
  { key: 'best-sellers', title: 'Best Sellers', icon: '🏆', subtitle: 'Our all-time top dishes', type: 'auto', order: 4 },
  { key: 'new-arrivals', title: 'New Arrivals', icon: '🆕', subtitle: 'Freshly added to the menu', type: 'auto', order: 5 },
];

function renderSectionsTable() {
  const sorted = sectionsCache.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('sections-table-body').innerHTML = sorted.length === 0
    ? `<tr class="empty-row"><td colspan="8">No homepage sections yet — click "Add Section", or "Add Default Sections" to start from the current homepage rails.</td></tr>`
    : sorted.map((s, idx) => `
      <tr>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-move-section-up="${s.id}" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button class="icon-btn" data-move-section-down="${s.id}" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        </td>
        <td style="font-size:18px;">${esc(s.icon || '🍽️')}</td>
        <td><div class="cell-name">${esc(s.title)}</div>${s.subtitle ? `<div class="cell-muted">${esc(s.subtitle)}</div>` : ''}</td>
        <td class="mono">${esc(s.key)}</td>
        <td>${s.type === 'manual' ? 'Manual' : 'Automatic'}</td>
        <td class="mono">${s.type === 'manual' ? (s.productIds || []).length : '—'}</td>
        <td><span class="badge ${s.active !== false ? 'badge-active' : 'badge-inactive'}">${s.active !== false ? 'Active' : 'Hidden'}</span></td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-edit-section="${s.id}">✎</button>
          <button class="icon-btn" data-toggle-section="${s.id}">${s.active !== false ? 'Hide' : 'Show'}</button>
          <button class="icon-btn" data-delete-section="${s.id}">🗑</button>
        </td>
      </tr>`).join('');
}

function sectionProductPickerHTML(selectedIds) {
  if (productsCache.length === 0) return `<p class="cell-muted">No products yet — add products first, then come back to pick them for this section.</p>`;
  return productsCache.map((p) => `
    <label class="sf-product-row" data-name="${esc((p.name || '').toLowerCase())}">
      <input type="checkbox" class="sf-product-check" value="${p.id}" ${selectedIds.includes(p.id) ? 'checked' : ''} />
      <span class="sf-product-name">${esc(p.name)}</span>
      <span class="cell-muted">${esc(p.category || '')}</span>
    </label>`).join('');
}

function sectionFormHTML(s = {}) {
  const selectedIds = Array.isArray(s.productIds) ? s.productIds : [];
  const isManual = s.type === 'manual';
  return `
    <div class="form-row">
      <div class="field"><label>Section Title</label><input id="sf-title" value="${esc(s.title || '')}" placeholder="e.g. Chef's Special" /></div>
      <div class="field"><label>Icon (emoji, optional)</label><input id="sf-icon" value="${esc(s.icon || '')}" maxlength="4" /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Key (slug used by the storefront)</label><input id="sf-key" value="${esc(s.key || '')}" placeholder="auto-generated from title if left blank" /></div>
      <div class="field"><label>Order</label><input id="sf-order" type="number" value="${s.order ?? 0}" /></div>
    </div>
    <div class="field"><label>Subtitle (optional)</label><input id="sf-subtitle" value="${esc(s.subtitle || '')}" placeholder="Short line shown under the title" /></div>
    <div class="field">
      <label>Source</label>
      <select id="sf-type">
        <option value="auto" ${!isManual ? 'selected' : ''}>Automatic (storefront's existing ranking logic)</option>
        <option value="manual" ${isManual ? 'selected' : ''}>Manual (hand-pick the products)</option>
      </select>
    </div>
    <div id="sf-manual-picker" style="${isManual ? '' : 'display:none;'}">
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px;letter-spacing:.02em;text-transform:uppercase;">Products in this section</label>
      <input class="search-input" id="sf-product-search" placeholder="Search products…" style="width:100%;margin-bottom:8px;" />
      <div id="sf-product-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px;">
        ${sectionProductPickerHTML(selectedIds)}
      </div>
      <label style="display:block;font-size:12px;color:var(--text-muted);margin:14px 0 6px;letter-spacing:.02em;text-transform:uppercase;">Order shown on homepage (drag to reorder)</label>
      <div id="sf-product-order-list" style="max-height:220px;overflow-y:auto;"></div>
    </div>
    <div class="checkbox-row" style="margin-top:16px;"><input type="checkbox" id="sf-active" ${s.active !== false ? 'checked' : ''} /><label for="sf-active">Active (visible on homepage)</label></div>
  `;
}

// Tracks the manual-section product order while the form is open. Separate
// from the checkbox list (which only tracks inclusion, not order) so a
// product's position can be preserved across edits and changed by drag
// and drop. Reset every time the form is (re)opened — see
// wireSectionFormEvents().
let sfSelectedOrder = [];

// Renders the "drag to reorder" list from sfSelectedOrder. Called on open
// and after every add/remove/reorder so it always reflects current state.
function renderSectionOrderList() {
  const container = $('sf-product-order-list');
  if (!container) return;
  if (sfSelectedOrder.length === 0) {
    container.innerHTML = `<p class="cell-muted" style="margin:0;">No products selected yet — check products above to add them here, then drag to reorder.</p>`;
    return;
  }
  container.innerHTML = sfSelectedOrder.map((id) => {
    const p = productsCache.find((x) => x.id === id);
    const name = p ? p.name : '(deleted product)';
    return `
      <div class="sf-order-row" draggable="true" data-order-id="${esc(id)}">
        <span class="sf-order-handle" aria-hidden="true">⠿</span>
        <span class="sf-product-name">${esc(name)}</span>
        <button type="button" class="icon-btn sf-order-remove" data-remove-order="${esc(id)}" aria-label="Remove from section">✕</button>
      </div>`;
  }).join('');
}

// Keeps sfSelectedOrder in sync when a checkbox is toggled in the picker
// above: newly-checked products are appended to the end of the order;
// unchecked ones are dropped from it.
function syncOrderFromCheckbox(id, checked) {
  if (checked) {
    if (!sfSelectedOrder.includes(id)) sfSelectedOrder.push(id);
  } else {
    sfSelectedOrder = sfSelectedOrder.filter((x) => x !== id);
  }
  renderSectionOrderList();
}

// Removing a product from the order list also unchecks it in the picker
// above, so the two stay consistent.
function removeFromSectionOrder(id) {
  sfSelectedOrder = sfSelectedOrder.filter((x) => x !== id);
  const checkbox = $('sf-product-list')?.querySelector(`.sf-product-check[value="${CSS.escape(id)}"]`);
  if (checkbox) checkbox.checked = false;
  renderSectionOrderList();
}

// Wires up the parts of the section form that only exist once its HTML is
// actually in the DOM (the modal body is set via innerHTML by openModal),
// mirroring how the Product form wires its image-preview listener after
// opening. Safe to call every time the modal opens. `s` is the section
// being edited (or {} when adding), used to seed the initial product order.
function wireSectionFormEvents(s = {}) {
  sfSelectedOrder = Array.isArray(s.productIds) ? s.productIds.slice() : [];
  renderSectionOrderList();

  $('sf-type').addEventListener('change', () => {
    $('sf-manual-picker').style.display = $('sf-type').value === 'manual' ? '' : 'none';
  });
  const searchEl = $('sf-product-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.trim().toLowerCase();
      $('sf-product-list').querySelectorAll('.sf-product-row').forEach((row) => {
        row.style.display = !q || row.getAttribute('data-name').includes(q) ? '' : 'none';
      });
    });
  }

  const listEl = $('sf-product-list');
  if (listEl) {
    listEl.addEventListener('change', (e) => {
      if (!e.target.classList.contains('sf-product-check')) return;
      syncOrderFromCheckbox(e.target.value, e.target.checked);
    });
  }

  const orderEl = $('sf-product-order-list');
  if (orderEl) {
    let dragSourceId = null;
    orderEl.addEventListener('click', (e) => {
      const removeId = e.target.closest('[data-remove-order]')?.getAttribute('data-remove-order');
      if (removeId) removeFromSectionOrder(removeId);
    });
    orderEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.sf-order-row');
      if (!row) return;
      dragSourceId = row.getAttribute('data-order-id');
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    orderEl.addEventListener('dragend', (e) => {
      const row = e.target.closest('.sf-order-row');
      if (row) row.classList.remove('dragging');
      dragSourceId = null;
    });
    orderEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragSourceId) return;
      const row = e.target.closest('.sf-order-row');
      if (!row) return;
      const targetId = row.getAttribute('data-order-id');
      if (!targetId || targetId === dragSourceId) return;
      const fromIdx = sfSelectedOrder.indexOf(dragSourceId);
      const toIdx = sfSelectedOrder.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      sfSelectedOrder.splice(fromIdx, 1);
      sfSelectedOrder.splice(toIdx, 0, dragSourceId);
      renderSectionOrderList();
      orderEl.querySelector(`[data-order-id="${CSS.escape(dragSourceId)}"]`)?.classList.add('dragging');
    });
  }
}

function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function readSectionFormData() {
  const title = $('sf-title').value.trim();
  if (!title) { toast('Section title is required.'); throw new Error('validation'); }
  const key = slugify($('sf-key').value) || slugify(title);
  const type = $('sf-type').value === 'manual' ? 'manual' : 'auto';
  // Uses sfSelectedOrder (kept in sync with the checkboxes and with any
  // drag-and-drop reordering) rather than reading checkbox DOM order, so
  // the admin's chosen product order is what actually gets saved.
  const productIds = type === 'manual' ? sfSelectedOrder.slice() : [];
  return {
    title, key, type, productIds,
    icon: $('sf-icon').value.trim(),
    subtitle: $('sf-subtitle').value.trim(),
    order: parseInt($('sf-order').value, 10) || 0,
    active: $('sf-active').checked,
  };
}

$('add-section-btn').addEventListener('click', () => {
  const blank = { order: sectionsCache.length };
  openModal('Add Homepage Section', sectionFormHTML(blank), async () => {
    const data = readSectionFormData();
    await addDoc(collection(db, 'homepageSections'), { ...data, createdAt: serverTimestamp() });
    toast('Homepage section added.');
  });
  wireSectionFormEvents(blank);
});

$('seed-sections-btn').addEventListener('click', async () => {
  const existingKeys = new Set(sectionsCache.map((s) => s.key));
  const toAdd = DEFAULT_HOMEPAGE_SECTIONS.filter((d) => !existingKeys.has(d.key));
  if (toAdd.length === 0) { toast('All default sections already exist.'); return; }
  if (!confirmAction(`Add ${toAdd.length} default section${toAdd.length === 1 ? '' : 's'} that don't exist yet?`)) return;
  try {
    await Promise.all(toAdd.map((d) => addDoc(collection(db, 'homepageSections'), {
      ...d, productIds: [], active: true, createdAt: serverTimestamp(),
    })));
    toast('Default sections added.');
  } catch (err) {
    toast('Could not add default sections.');
    console.error(err);
  }
});

// Reorders by swapping `order` values with the section currently above/below
// in the sorted list, then persisting both — keeps ordering stable without
// needing to renumber every section on each move.
function moveSection(id, direction) {
  const sorted = sectionsCache.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = sorted.findIndex((s) => s.id === id);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
  const a = sorted[idx];
  const b = sorted[swapIdx];
  const aOrder = a.order ?? 0;
  const bOrder = b.order ?? 0;
  Promise.all([
    updateDoc(doc(db, 'homepageSections', a.id), { order: bOrder }),
    updateDoc(doc(db, 'homepageSections', b.id), { order: aOrder }),
  ]).catch((err) => { toast('Reorder failed.'); console.error(err); });
}

document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-section]')?.getAttribute('data-edit-section');
  if (editId) {
    const s = sectionsCache.find((x) => x.id === editId);
    openModal('Edit Homepage Section', sectionFormHTML(s), async () => {
      const data = readSectionFormData();
      await updateDoc(doc(db, 'homepageSections', editId), { ...data, updatedAt: serverTimestamp() });
      toast('Homepage section updated.');
    });
    wireSectionFormEvents(s);
  }

  const toggleId = e.target.closest('[data-toggle-section]')?.getAttribute('data-toggle-section');
  if (toggleId) {
    const s = sectionsCache.find((x) => x.id === toggleId);
    if (s) {
      const nowActive = !(s.active !== false);
      updateDoc(doc(db, 'homepageSections', toggleId), { active: nowActive })
        .then(() => toast(nowActive ? 'Section shown on homepage.' : 'Section hidden from homepage.'))
        .catch((err) => { toast('Update failed.'); console.error(err); });
    }
  }

  const delId = e.target.closest('[data-delete-section]')?.getAttribute('data-delete-section');
  if (delId && confirmAction('Delete this homepage section? Products assigned to it will NOT be deleted — they will just be unassigned from this section.')) {
    (async () => {
      try {
        // Deleting the section and clearing sectionId off every product that
        // pointed at it happen in one atomic batch, so a product can never be
        // left referencing a homepage section that no longer exists.
        const affected = productsCache.filter((p) => p.sectionId === delId);
        const batch = writeBatch(db);
        batch.delete(doc(db, 'homepageSections', delId));
        affected.forEach((p) => batch.update(doc(db, 'products', p.id), { sectionId: '' }));
        await batch.commit();
        toast('Section deleted.');
      } catch (err) {
        toast('Delete failed.');
        console.error(err);
      }
    })();
  }

  const upId = e.target.closest('[data-move-section-up]')?.getAttribute('data-move-section-up');
  if (upId) moveSection(upId, -1);
  const downId = e.target.closest('[data-move-section-down]')?.getAttribute('data-move-section-down');
  if (downId) moveSection(downId, 1);
});

/* =========================================================
   COMBO MEALS
   ---------------------------------------------------------
   Bundles of existing products at a special combined price.
   Storefront reads this same "comboMeals" collection (active
   combos only) to render the Combo Meals section that replaced
   the old Sort By filter — see index.html's Firebase module.
   ========================================================= */
let combosCache = [];

function renderCombosTable() {
  const q = ($('combos-search').value || '').toLowerCase();
  const rows = combosCache.filter((c) => !q || (c.name || '').toLowerCase().includes(q));
  $('combos-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="9">No combo meals yet — click "Add Combo Meal" to create your first bundle.</td></tr>`
    : rows.map((c) => {
      const originalPrice = Number(c.originalPrice) || 0;
      const comboPrice = Number(c.comboPrice) || 0;
      const savings = Math.max(0, originalPrice - comboPrice);
      const itemCount = (c.productIds || []).length;
      return `
      <tr>
        <td>${c.imageUrl ? `<img class="cell-thumb" src="${esc(c.imageUrl)}" alt="" />` : '<div class="cell-thumb"></div>'}</td>
        <td><div class="cell-name">${esc(c.name)}</div>${c.description ? `<div class="cell-muted">${esc(c.description)}</div>` : ''}</td>
        <td class="mono">${itemCount} item${itemCount === 1 ? '' : 's'}</td>
        <td class="mono">${money(originalPrice)}</td>
        <td class="mono">${money(comboPrice)}</td>
        <td class="mono" style="color:var(--herb);">${money(savings)}</td>
        <td><span class="badge ${c.featured ? 'badge-active' : 'badge-inactive'}">${c.featured ? 'Featured' : '—'}</span></td>
        <td><span class="badge ${c.active !== false ? 'badge-active' : 'badge-inactive'}">${c.active !== false ? 'Active' : 'Hidden'}</span></td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-edit-combo="${c.id}">✎</button>
          <button class="icon-btn" data-toggle-combo="${c.id}">${c.active !== false ? 'Hide' : 'Show'}</button>
          <button class="icon-btn" data-delete-combo="${c.id}">🗑</button>
        </td>
      </tr>`;
    }).join('');
}
$('combos-search').addEventListener('input', renderCombosTable);

// Same multi-select checkbox picker UX as Homepage Sections' manual product
// picker (search box + checkbox list), minus drag-to-reorder — a combo's
// "Included Items" line just lists everything, so order doesn't matter.
function comboProductPickerHTML(selectedIds) {
  if (productsCache.length === 0) return `<p class="cell-muted">No products yet — add products first, then come back to build a combo.</p>`;
  return productsCache.map((p) => `
    <label class="sf-product-row" data-name="${esc((p.name || '').toLowerCase())}">
      <input type="checkbox" class="cm-product-check" value="${p.id}" ${selectedIds.includes(p.id) ? 'checked' : ''} />
      <span class="sf-product-name">${esc(p.name)}</span>
      <span class="cell-muted">${esc(p.category || '')} · ${money(p.price)}</span>
    </label>`).join('');
}

// Live-updates the "You Save Rs. X" preview in the modal as the admin types
// the original/combo price. Safe to call on every keystroke.
function updateComboSavingsPreview() {
  const preview = $('cm-savings-preview');
  if (!preview) return;
  const originalPrice = parseFloat($('cm-original-price').value) || 0;
  const comboPrice = parseFloat($('cm-combo-price').value) || 0;
  const savings = originalPrice - comboPrice;
  preview.textContent = savings > 0
    ? `You Save ${money(savings)}`
    : (originalPrice > 0 || comboPrice > 0 ? 'Combo price should be lower than the original price to show savings.' : '—');
  preview.className = 'cell-muted';
  preview.style.color = savings > 0 ? 'var(--herb)' : '';
}

function comboFormHTML(c = {}) {
  const selectedIds = Array.isArray(c.productIds) ? c.productIds : [];
  return `
    <div class="field"><label>Combo Name</label><input id="cm-name" value="${esc(c.name || '')}" placeholder="e.g. Family Feast Combo" /></div>
    <div class="field"><label>Combo Description</label><textarea id="cm-description" rows="2">${esc(c.description || '')}</textarea></div>
    <div class="form-row">
      <div class="field"><label>Original Price (sum of items, PKR)</label><input id="cm-original-price" type="number" step="0.01" value="${c.originalPrice ?? ''}" /></div>
      <div class="field"><label>Combo Price (PKR)</label><input id="cm-combo-price" type="number" step="0.01" value="${c.comboPrice ?? ''}" /></div>
    </div>
    <div class="cell-muted" id="cm-savings-preview" style="margin:-6px 0 4px;">—</div>
    <div class="field">
      <label>Combo Image</label>
      <img class="image-preview ${c.imageUrl ? 'visible' : ''}" id="cm-image-preview" src="${esc(c.imageUrl || '')}" />
      <input type="file" id="cm-image-file" accept="image/*" />
      <div class="cell-muted" style="margin-top:6px;">Leave empty to keep the current image.</div>
    </div>
    <div>
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px;letter-spacing:.02em;text-transform:uppercase;">Products in this combo</label>
      <input class="search-input" id="cm-product-search" placeholder="Search products…" style="width:100%;margin-bottom:8px;" />
      <div id="cm-product-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px;">
        ${comboProductPickerHTML(selectedIds)}
      </div>
    </div>
    <div class="checkbox-row" style="margin-top:16px;"><input type="checkbox" id="cm-featured" ${c.featured ? 'checked' : ''} /><label for="cm-featured">Featured (highlighted on the storefront)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cm-active" ${c.active !== false ? 'checked' : ''} /><label for="cm-active">Active (visible on storefront)</label></div>
  `;
}

// Wires the parts of the combo form that only exist once its HTML is in the
// DOM (search filter, live savings preview) — mirrors wireSectionFormEvents.
// Safe to call every time the modal opens.
function wireComboFormEvents() {
  updateComboSavingsPreview();
  $('cm-original-price').addEventListener('input', updateComboSavingsPreview);
  $('cm-combo-price').addEventListener('input', updateComboSavingsPreview);

  const searchEl = $('cm-product-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.trim().toLowerCase();
      $('cm-product-list').querySelectorAll('.sf-product-row').forEach((row) => {
        row.style.display = !q || row.getAttribute('data-name').includes(q) ? '' : 'none';
      });
    });
  }
}

function readComboFormData() {
  const name = $('cm-name').value.trim();
  const productIds = Array.from($('cm-product-list').querySelectorAll('.cm-product-check:checked')).map((el) => el.value);
  if (!name) { toast('Combo name is required.'); throw new Error('validation'); }
  if (productIds.length === 0) { toast('Select at least one product for this combo.'); throw new Error('validation'); }
  const originalPrice = parseFloat($('cm-original-price').value) || 0;
  const comboPrice = parseFloat($('cm-combo-price').value) || 0;
  return {
    name,
    description: $('cm-description').value.trim(),
    productIds,
    originalPrice,
    comboPrice,
    // Stored (not just computed on the storefront) so the admin table and
    // any future reporting can read it directly without recomputing.
    savings: Math.max(0, originalPrice - comboPrice),
    featured: $('cm-featured').checked,
    active: $('cm-active').checked,
  };
}

$('add-combo-btn').addEventListener('click', () => {
  openModal('Add Combo Meal', comboFormHTML(), async () => {
    const file = $('cm-image-file').files[0];
    const data = readComboFormData();
    data.imageUrl = '';
    const ref = doc(collection(db, 'comboMeals'));
    if (file) data.imageUrl = await uploadToCloudinary(file);
    data.createdAt = serverTimestamp();
    data.updatedAt = serverTimestamp();
    await setDoc(ref, data);
    toast(file ? 'Combo meal added with photo.' : 'Combo meal added.');
  });
  $('cm-image-file').addEventListener('change', previewComboImage);
  wireComboFormEvents();
});

function previewComboImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const preview = $('cm-image-preview');
  preview.src = URL.createObjectURL(file);
  preview.classList.add('visible');
}

document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-combo]')?.getAttribute('data-edit-combo');
  if (editId) {
    const c = combosCache.find((x) => x.id === editId);
    openModal('Edit Combo Meal', comboFormHTML(c), async () => {
      const file = $('cm-image-file').files[0];
      const data = readComboFormData();
      if (file) data.imageUrl = await uploadToCloudinary(file);
      data.updatedAt = serverTimestamp();
      await updateDoc(doc(db, 'comboMeals', editId), data);
      // Same Cloudinary limitation noted under Products: the old photo (if
      // replaced) is intentionally left in your Cloudinary media library.
      toast(file ? 'Combo meal updated with new photo.' : 'Combo meal updated.');
    });
    $('cm-image-file').addEventListener('change', previewComboImage);
    wireComboFormEvents();
  }

  const toggleId = e.target.closest('[data-toggle-combo]')?.getAttribute('data-toggle-combo');
  if (toggleId) {
    const c = combosCache.find((x) => x.id === toggleId);
    if (c) {
      const nowActive = !(c.active !== false);
      updateDoc(doc(db, 'comboMeals', toggleId), { active: nowActive })
        .then(() => toast(nowActive ? 'Combo shown on storefront.' : 'Combo hidden from storefront.'))
        .catch((err) => { toast('Update failed.'); console.error(err); });
    }
  }

  const delId = e.target.closest('[data-delete-combo]')?.getAttribute('data-delete-combo');
  if (delId && confirmAction('Delete this combo meal? This cannot be undone. (The individual products it includes will NOT be deleted.)')) {
    deleteDoc(doc(db, 'comboMeals', delId))
      .then(() => toast('Combo meal deleted.'))
      .catch((err) => { toast('Delete failed.'); console.error(err); });
  }
});

/* =========================================================
   ORDERS
   ========================================================= */
let ordersCache = [];
const STATUS_OPTIONS = ['Pending', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

function statusSelectHTML(orderId, current) {
  return `<select class="status-select" data-status-select="${orderId}">
    ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`).join('')}
  </select>`;
}
function paymentMethodLabel(method) {
  if (method === 'jazzcash') return 'JazzCash';
  if (method === 'easypaisa') return 'Easypaisa';
  if (method === 'cod') return 'Cash on Delivery';
  return method || '—';
}
function paymentStatusBadgeClass(status) {
  if (status === 'Payment Verified' || status === 'Cash on Delivery') return 'badge-active';
  if (status === 'Payment Pending') return 'badge-pending';
  return 'badge-inactive';
}
// Only Easypaisa / JazzCash orders need manual verification — Cash on Delivery
// has nothing to verify, so no toggle button is shown for it.
function paymentStatusCellHTML(o) {
  const isOnlineWallet = o.paymentMethod === 'easypaisa' || o.paymentMethod === 'jazzcash';
  const status = o.paymentStatus || (isOnlineWallet ? 'Payment Pending' : 'Cash on Delivery');
  const badge = `<span class="badge ${paymentStatusBadgeClass(status)}">${esc(status)}</span>`;
  if (!isOnlineWallet) return `<div class="cell-muted">${esc(paymentMethodLabel(o.paymentMethod))}</div>${badge}`;
  const nextStatus = status === 'Payment Verified' ? 'Payment Pending' : 'Payment Verified';
  const btnLabel = status === 'Payment Verified' ? 'Mark Pending' : 'Mark Verified';
  return `<div class="cell-muted">${esc(paymentMethodLabel(o.paymentMethod))}</div>${badge}
    <div style="margin-top:6px;"><button class="btn btn-outline btn-sm" data-toggle-payment-status="${o.id}" data-next-status="${nextStatus}">${btnLabel}</button></div>`;
}
function renderOrdersTable() {
  const q = ($('orders-search').value || '').toLowerCase();
  const statusFilter = $('orders-status-filter').value;
  const rows = ordersCache.filter((o) =>
    (!statusFilter || o.status === statusFilter) &&
    (!q || (o.orderNumber || '').toLowerCase().includes(q) || (o.customer?.phone || '').includes(q) || (o.customer?.name || '').toLowerCase().includes(q))
  );
  $('orders-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="8">No orders match your filters.</td></tr>`
    : rows.map((o) => `
      <tr>
        <td class="mono cell-name" style="cursor:pointer;" data-open-order="${o.id}">${esc(o.orderNumber)}</td>
        <td>${esc(o.customer?.name || '—')}</td>
        <td class="mono">${esc(o.customer?.phone || '—')}</td>
        <td class="mono">${money(o.total)}</td>
        <td>${paymentStatusCellHTML(o)}</td>
        <td>${statusSelectHTML(o.id, o.status)}</td>
        <td class="cell-muted">${fmtDate(o.createdAt)}</td>
        <td><button class="icon-btn" data-open-order="${o.id}">View</button> <button class="icon-btn" data-delete-order="${o.id}">🗑</button></td>
      </tr>`).join('');
}
document.addEventListener('click', (e) => {
  const delId = e.target.closest('[data-delete-order]')?.getAttribute('data-delete-order');
  if (delId && confirmAction('Delete this order permanently? This cannot be undone.')) {
    deleteDoc(doc(db, 'orders', delId)).then(() => toast('Order deleted.')).catch((err) => { toast('Delete failed.'); console.error(err); });
  }
  const payToggleId = e.target.closest('[data-toggle-payment-status]')?.getAttribute('data-toggle-payment-status');
  if (payToggleId) {
    const nextStatus = e.target.closest('[data-toggle-payment-status]').getAttribute('data-next-status');
    updateDoc(doc(db, 'orders', payToggleId), { paymentStatus: nextStatus, updatedAt: serverTimestamp() })
      .then(() => toast(`Payment marked "${nextStatus}".`))
      .catch((err) => { toast('Could not update payment status.'); console.error(err); });
  }
});
$('orders-search').addEventListener('input', renderOrdersTable);
$('orders-status-filter').addEventListener('change', renderOrdersTable);

/* ---------- Manual order creation (phone-in orders) ---------- */
function manualOrderRowHTML(rowId) {
  const opts = productsCache.filter((p) => p.active !== false)
    .map((p) => `<option value="${p.id}" data-price="${p.price}">${esc(p.name)} — ${money(p.price)}</option>`).join('');
  return `<div class="form-row" data-order-row="${rowId}" style="align-items:end;margin-bottom:8px;">
    <div class="field" style="margin-bottom:0;"><label>Item</label><select class="mo-item">${opts || '<option value="">No active products</option>'}</select></div>
    <div class="field" style="margin-bottom:0;max-width:90px;"><label>Qty</label><input class="mo-qty" type="number" min="1" value="1" /></div>
  </div>`;
}
function manualOrderFormHTML() {
  return `
    <div class="form-row">
      <div class="field"><label>Customer Name</label><input id="mo-name" /></div>
      <div class="field"><label>Phone</label><input id="mo-phone" /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>City</label><input id="mo-city" /></div>
      <div class="field"><label>Address</label><input id="mo-address" /></div>
    </div>
    <div id="mo-items">${manualOrderRowHTML(0)}</div>
    <button type="button" class="btn btn-outline btn-sm" id="mo-add-item" style="margin-bottom:14px;">+ Add Item</button>
    <div class="field"><label>Payment Method</label>
      <select id="mo-payment">
        <option value="cod">Cash on Delivery</option>
        <option value="easypaisa">EasyPaisa</option>
        <option value="jazzcash">JazzCash</option>
      </select>
    </div>
    <div class="cell-muted" style="margin-top:4px;">Tax and delivery are calculated from current Settings. Coupons aren't applied to manually created orders.</div>
  `;
}
$('add-order-btn').addEventListener('click', () => {
  let rowCount = 1;
  openModal('Add Order (phone-in)', manualOrderFormHTML(), async () => {
    const name = $('mo-name').value.trim();
    const phone = $('mo-phone').value.trim();
    if (!name || !phone) { toast('Customer name and phone are required.'); throw new Error('validation'); }
    const items = [];
    document.querySelectorAll('[data-order-row]').forEach((row) => {
      const sel = row.querySelector('.mo-item');
      const qty = parseInt(row.querySelector('.mo-qty').value, 10) || 0;
      if (!sel.value || qty <= 0) return;
      const price = parseFloat(sel.selectedOptions[0].getAttribute('data-price')) || 0;
      const productName = sel.selectedOptions[0].textContent.split(' — ')[0];
      items.push({ id: sel.value, name: productName, price, qty });
    });
    if (items.length === 0) { toast('Add at least one item.'); throw new Error('validation'); }
    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const delivery = subtotal >= (settingsCache.freeDeliveryThreshold ?? 25) ? 0 : (settingsCache.deliveryFee ?? 2.99);
    const tax = subtotal * (settingsCache.taxRate ?? 0.08);
    const total = subtotal + delivery + tax;
    const orderNumber = `FH-${Math.floor(10000 + Math.random() * 89999)}`;
    const moPaymentMethod = $('mo-payment').value;
    await addDoc(collection(db, 'orders'), {
      orderNumber,
      customer: { name, phone, city: $('mo-city').value.trim(), address: $('mo-address').value.trim() },
      items,
      subtotal: round2(subtotal), discount: 0, delivery: round2(delivery), tax: round2(tax), total: round2(total),
      couponCode: null, paymentMethod: moPaymentMethod,
      paymentStatus: moPaymentMethod === 'cod' ? 'Cash on Delivery' : 'Payment Pending',
      status: 'Pending',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    const customerId = phone.replace(/[^0-9]/g, '');
    if (customerId) {
      const ref = doc(db, 'customers', customerId);
      const existing = customersCache.find((c) => c.id === customerId);
      await setDoc(ref, {
        name, phone, city: $('mo-city').value.trim(), address: $('mo-address').value.trim(),
        ordersCount: (existing?.ordersCount || 0) + 1, totalSpent: round2((existing?.totalSpent || 0) + total),
        createdAt: existing ? existing.createdAt : serverTimestamp(), lastOrderAt: serverTimestamp(),
      }, { merge: true });
    }
    toast('Order created.');
  });
  document.getElementById('mo-add-item').addEventListener('click', () => {
    document.getElementById('mo-items').insertAdjacentHTML('beforeend', manualOrderRowHTML(rowCount));
    rowCount += 1;
  });
});
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }


document.addEventListener('change', (e) => {
  const orderId = e.target.getAttribute?.('data-status-select');
  if (orderId) {
    updateDoc(doc(db, 'orders', orderId), { status: e.target.value, updatedAt: serverTimestamp() })
      .then(() => toast(`Order status updated to "${e.target.value}".`))
      .catch((err) => { toast('Could not update status.'); console.error(err); });
  }
});

let openDrawerOrderId = null;
function openOrderDrawer(orderId) {
  const o = ordersCache.find((x) => x.id === orderId);
  if (!o) return;
  openDrawerOrderId = orderId;
  $('order-drawer-title').textContent = `Order ${o.orderNumber}`;
  $('order-drawer-body').innerHTML = `
    <div class="drawer-section">
      <h4>Status</h4>
      ${statusSelectHTML(o.id, o.status)}
    </div>
    <div class="drawer-section">
      <h4>Customer</h4>
      <div>${esc(o.customer?.name || '—')}</div>
      <div class="cell-muted mono">${esc(o.customer?.phone || '—')}</div>
      <div class="cell-muted">${esc(o.customer?.city || '')} · ${esc(o.customer?.address || '')}</div>
    </div>
    <div class="drawer-section">
      <h4>Items</h4>
      ${(o.items || []).map((i) => `<div class="order-item-row"><span>${i.qty} × ${esc(i.name)}</span><span class="mono">${money(i.price * i.qty)}</span></div>`).join('')}
      <div class="order-item-row"><span>Subtotal</span><span class="mono">${money(o.subtotal)}</span></div>
      ${o.discount ? `<div class="order-item-row"><span>Discount (${esc(o.couponCode || '')})</span><span class="mono">−${money(o.discount)}</span></div>` : ''}
      <div class="order-item-row"><span>Delivery</span><span class="mono">${o.delivery === 0 ? 'FREE' : money(o.delivery)}</span></div>
      <div class="order-item-row"><span>Tax</span><span class="mono">${money(o.tax)}</span></div>
      <div class="order-total-row"><span>Total</span><span class="mono">${money(o.total)}</span></div>
    </div>
    <div class="drawer-section">
      <h4>Payment</h4>
      ${paymentStatusCellHTML(o)}
    </div>
    <div class="drawer-section">
      <h4>Placed</h4>
      <div class="cell-muted">${fmtDate(o.createdAt)}</div>
    </div>
  `;
  $('order-drawer').classList.add('open');
  $('order-drawer-overlay').classList.add('visible');
}
document.addEventListener('click', (e) => {
  const id = e.target.closest('[data-open-order]')?.getAttribute('data-open-order');
  if (id) openOrderDrawer(id);
});
$('order-drawer-close').addEventListener('click', closeOrderDrawer);
$('order-drawer-overlay').addEventListener('click', closeOrderDrawer);
function closeOrderDrawer() { $('order-drawer').classList.remove('open'); $('order-drawer-overlay').classList.remove('visible'); openDrawerOrderId = null; }

/* =========================================================
   CUSTOMERS
   ========================================================= */
let customersCache = [];
function normalizePhoneForId(phone) { return String(phone || '').replace(/[^0-9]/g, ''); }

function renderCustomersTable() {
  const q = ($('customers-search').value || '').toLowerCase();
  const rows = customersCache.filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q));
  $('customers-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="7">No customers yet — they're created automatically when an order is placed, or click "Add Customer".</td></tr>`
    : rows.map((c) => `
      <tr>
        <td class="cell-name">${esc(c.name)}</td>
        <td class="mono">${esc(c.phone)}</td>
        <td>${esc(c.city || '—')}</td>
        <td class="mono">${c.ordersCount || 0}</td>
        <td class="mono">${money(c.totalSpent)}</td>
        <td class="cell-muted">${fmtDate(c.lastOrderAt)}</td>
        <td><button class="icon-btn" data-edit-customer="${c.id}">✎</button><button class="icon-btn" data-delete-customer="${c.id}">🗑</button></td>
      </tr>`).join('');
}
$('customers-search').addEventListener('input', renderCustomersTable);

function customerFormHTML(c = {}, phoneEditable = true) {
  return `
    <div class="form-row">
      <div class="field"><label>Name</label><input id="cuf-name" value="${esc(c.name || '')}" /></div>
      <div class="field"><label>Phone</label><input id="cuf-phone" value="${esc(c.phone || '')}" ${phoneEditable ? '' : 'disabled'} /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>City</label><input id="cuf-city" value="${esc(c.city || '')}" /></div>
      <div class="field"><label>Address</label><input id="cuf-address" value="${esc(c.address || '')}" /></div>
    </div>
    <div class="field"><label>Total Spent (USD)</label><input id="cuf-totalSpent" type="number" step="0.01" value="${c.totalSpent ?? 0}" /></div>
    <div class="cell-muted">Orders Count updates automatically as this customer places real orders.</div>
  `;
}
$('add-customer-btn').addEventListener('click', () => {
  openModal('Add Customer', customerFormHTML(), async () => {
    const phone = $('cuf-phone').value.trim();
    const name = $('cuf-name').value.trim();
    const id = normalizePhoneForId(phone);
    if (!name || !id) { toast('Name and a valid phone number are required.'); throw new Error('validation'); }
    await setDoc(doc(db, 'customers', id), {
      name, phone, city: $('cuf-city').value.trim(), address: $('cuf-address').value.trim(),
      totalSpent: parseFloat($('cuf-totalSpent').value) || 0, ordersCount: 0,
      createdAt: serverTimestamp(), lastOrderAt: serverTimestamp(),
    }, { merge: true });
    toast('Customer added.');
  });
});
document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-customer]')?.getAttribute('data-edit-customer');
  if (editId) {
    const c = customersCache.find((x) => x.id === editId);
    openModal('Edit Customer', customerFormHTML(c, false), async () => {
      await updateDoc(doc(db, 'customers', editId), {
        name: $('cuf-name').value.trim(), city: $('cuf-city').value.trim(),
        address: $('cuf-address').value.trim(), totalSpent: parseFloat($('cuf-totalSpent').value) || 0,
      });
      toast('Customer updated.');
    });
  }
  const delId = e.target.closest('[data-delete-customer]')?.getAttribute('data-delete-customer');
  if (delId && confirmAction('Delete this customer record? Their past orders are not affected.')) {
    deleteDoc(doc(db, 'customers', delId)).then(() => toast('Customer deleted.')).catch((err) => { toast('Delete failed.'); console.error(err); });
  }
});

/* =========================================================
   USERS (Firebase Authentication accounts)
   ---------------------------------------------------------
   Reads the `users/{uid}` Firestore docs the storefront creates on sign-up
   (see buildUserProfile()/signUp() there) — one doc per real account.
   Orders/Total Spent are computed here from ordersCache (matched by uid),
   not stored on the user doc, so they're always accurate against the live
   orders list.
   No password is ever shown or stored in plaintext anywhere in this app —
   "Reset Password" sends the customer Firebase's standard reset-link email,
   the same flow the storefront's own "Forgot password?" link uses.
   ========================================================= */
let usersCache = [];

function userOrderStats(uid) {
  const theirs = ordersCache.filter((o) => o.uid === uid);
  return {
    count: theirs.length,
    totalSpent: theirs.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
  };
}

function renderUsersTable() {
  const q = ($('users-search').value || '').toLowerCase();
  const verifiedFilter = $('users-verified-filter').value;
  const statusFilter = $('users-status-filter').value;
  const rows = usersCache.filter((u) => {
    if (q && !((u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))) return false;
    if (verifiedFilter === 'verified' && !u.emailVerified) return false;
    if (verifiedFilter === 'unverified' && u.emailVerified) return false;
    if (statusFilter === 'enabled' && u.disabled) return false;
    if (statusFilter === 'disabled' && !u.disabled) return false;
    return true;
  });
  $('users-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="10">No users match your search/filters.</td></tr>`
    : rows.map((u) => {
      const stats = userOrderStats(u.id);
      return `
      <tr>
        <td class="cell-name">${esc(u.name || '—')}</td>
        <td class="mono">${esc(u.email || '—')}</td>
        <td class="mono">${esc(u.phone || '—')}</td>
        <td><span class="badge ${u.emailVerified ? 'badge-active' : 'badge-inactive'}">${u.emailVerified ? '✓ Verified' : 'Unverified'}</span></td>
        <td class="cell-muted">${fmtDate(u.createdAt)}</td>
        <td class="cell-muted">${u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</td>
        <td class="mono">${stats.count}</td>
        <td class="mono">${money(stats.totalSpent)}</td>
        <td><span class="badge ${u.disabled ? 'badge-inactive' : 'badge-active'}">${u.disabled ? 'Disabled' : 'Enabled'}</span></td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-toggle-user="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="icon-btn" data-reset-user-password="${esc(u.email || '')}" ${u.email ? '' : 'disabled'}>Reset Password</button>
        </td>
      </tr>`;
    }).join('');
}
$('users-search').addEventListener('input', renderUsersTable);
$('users-verified-filter').addEventListener('change', renderUsersTable);
$('users-status-filter').addEventListener('change', renderUsersTable);

document.addEventListener('click', (e) => {
  const toggleId = e.target.closest('[data-toggle-user]')?.getAttribute('data-toggle-user');
  if (toggleId) {
    const u = usersCache.find((x) => x.id === toggleId);
    if (!u) return;
    const nowDisabled = !u.disabled;
    if (nowDisabled && !confirmAction(`Disable ${u.name || u.email}'s account? They will be signed out and blocked from signing in or checking out until re-enabled.`)) return;
    updateDoc(doc(db, 'users', toggleId), { disabled: nowDisabled })
      .then(() => toast(nowDisabled ? 'Account disabled.' : 'Account enabled.'))
      .catch((err) => { toast('Update failed.'); console.error(err); });
  }

  const resetEmail = e.target.closest('[data-reset-user-password]')?.getAttribute('data-reset-user-password');
  if (resetEmail) {
    if (!confirmAction(`Send a password reset email to ${resetEmail}?`)) return;
    sendPasswordResetEmail(auth, resetEmail)
      .then(() => toast('Password reset email sent.'))
      .catch((err) => { toast('Could not send reset email.'); console.error(err); });
  }
});

/* =========================================================
   COUPONS
   ========================================================= */
let couponsCache = [];
function renderCouponsTable() {
  $('coupons-table-body').innerHTML = couponsCache.length === 0
    ? `<tr class="empty-row"><td colspan="6">No coupons yet — click "Add Coupon".</td></tr>`
    : couponsCache.map((c) => `
      <tr>
        <td class="mono cell-name">${esc(c.id)}</td>
        <td>${esc(c.type)}</td>
        <td class="mono">${c.type === 'percent' ? `${c.value}%` : c.type === 'flat' ? money(c.value) : '—'}</td>
        <td class="mono">${money(c.minSubtotal)}</td>
        <td><span class="badge ${c.active !== false ? 'badge-active' : 'badge-inactive'}">${c.active !== false ? 'Active' : 'Disabled'}</span></td>
        <td><button class="icon-btn" data-edit-coupon="${c.id}">✎</button><button class="icon-btn" data-delete-coupon="${c.id}">🗑</button></td>
      </tr>`).join('');
}
function couponFormHTML(c = {}, codeEditable = true) {
  return `
    <div class="form-row">
      <div class="field"><label>Code</label><input id="cpf-code" value="${esc(c.id || '')}" ${codeEditable ? '' : 'disabled'} style="text-transform:uppercase;" /></div>
      <div class="field"><label>Type</label>
        <select id="cpf-type">
          <option value="percent" ${c.type === 'percent' ? 'selected' : ''}>Percent off</option>
          <option value="flat" ${c.type === 'flat' ? 'selected' : ''}>Flat amount off</option>
          <option value="freeship" ${c.type === 'freeship' ? 'selected' : ''}>Free delivery</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="field"><label>Value (% or $, ignored for free delivery)</label><input id="cpf-value" type="number" step="0.01" value="${c.value ?? 0}" /></div>
      <div class="field"><label>Minimum Subtotal</label><input id="cpf-minSubtotal" type="number" step="0.01" value="${c.minSubtotal ?? 0}" /></div>
    </div>
    <div class="field"><label>Label (shown to customer)</label><input id="cpf-label" value="${esc(c.label || '')}" /></div>
    <div class="checkbox-row"><input type="checkbox" id="cpf-active" ${c.active !== false ? 'checked' : ''} /><label for="cpf-active">Active</label></div>
  `;
}
$('add-coupon-btn').addEventListener('click', () => {
  openModal('Add Coupon', couponFormHTML(), async () => {
    const code = $('cpf-code').value.trim().toUpperCase();
    if (!code) { toast('Code is required.'); throw new Error('validation'); }
    await setDoc(doc(db, 'coupons', code), {
      type: $('cpf-type').value, value: parseFloat($('cpf-value').value) || 0,
      minSubtotal: parseFloat($('cpf-minSubtotal').value) || 0, label: $('cpf-label').value.trim(),
      active: $('cpf-active').checked, createdAt: serverTimestamp(),
    });
    toast('Coupon added.');
  });
});
document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-coupon]')?.getAttribute('data-edit-coupon');
  if (editId) {
    const c = couponsCache.find((x) => x.id === editId);
    openModal('Edit Coupon', couponFormHTML(c, false), async () => {
      await setDoc(doc(db, 'coupons', editId), {
        type: $('cpf-type').value, value: parseFloat($('cpf-value').value) || 0,
        minSubtotal: parseFloat($('cpf-minSubtotal').value) || 0, label: $('cpf-label').value.trim(),
        active: $('cpf-active').checked,
      }, { merge: true });
      toast('Coupon updated.');
    });
  }
  const delId = e.target.closest('[data-delete-coupon]')?.getAttribute('data-delete-coupon');
  if (delId && confirmAction('Delete this coupon?')) {
    deleteDoc(doc(db, 'coupons', delId)).then(() => toast('Coupon deleted.'));
  }
});

/* =========================================================
   REVIEWS
   ========================================================= */
let reviewsCache = [];
function renderReviewsTable() {
  const q = ($('reviews-search').value || '').toLowerCase();
  const rows = reviewsCache.filter((r) => !q || (r.name || '').toLowerCase().includes(q) || (r.comment || '').toLowerCase().includes(q) || (r.productId || '').toLowerCase().includes(q));
  $('reviews-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="6">No reviews yet.</td></tr>`
    : rows.map((r) => `
      <tr>
        <td class="mono cell-muted">${esc(r.productId)}</td>
        <td class="cell-name">${esc(r.name)}</td>
        <td class="mono">★ ${r.rating}</td>
        <td>${esc((r.comment || '').slice(0, 90))}${(r.comment || '').length > 90 ? '…' : ''}</td>
        <td><span class="badge ${r.approved !== false ? 'badge-active' : 'badge-inactive'}">${r.approved !== false ? 'Approved' : 'Hidden'}</span></td>
        <td><button class="icon-btn" data-edit-review="${r.id}">✎</button> <button class="icon-btn" data-toggle-review="${r.id}">${r.approved !== false ? 'Hide' : 'Approve'}</button> <button class="icon-btn" data-delete-review="${r.id}">🗑</button></td>
      </tr>`).join('');
}
$('reviews-search').addEventListener('input', renderReviewsTable);
function reviewFormHTML(r = {}) {
  return `
    <div class="field"><label>Name</label><input id="rvf-name" value="${esc(r.name || '')}" /></div>
    <div class="field"><label>Rating (1–5)</label><input id="rvf-rating" type="number" min="1" max="5" value="${r.rating ?? 5}" /></div>
    <div class="field"><label>Comment</label><textarea id="rvf-comment" rows="3">${esc(r.comment || '')}</textarea></div>
  `;
}
document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-review]')?.getAttribute('data-edit-review');
  if (editId) {
    const r = reviewsCache.find((x) => x.id === editId);
    openModal('Edit Review', reviewFormHTML(r), async () => {
      await updateDoc(doc(db, 'reviews', editId), {
        name: $('rvf-name').value.trim(),
        rating: Math.max(1, Math.min(5, parseInt($('rvf-rating').value, 10) || 5)),
        comment: $('rvf-comment').value.trim(),
      });
      toast('Review updated.');
    });
  }
  const toggleId = e.target.closest('[data-toggle-review]')?.getAttribute('data-toggle-review');
  if (toggleId) {
    const r = reviewsCache.find((x) => x.id === toggleId);
    updateDoc(doc(db, 'reviews', toggleId), { approved: !(r.approved !== false) }).then(() => toast('Review updated.'));
  }
  const delId = e.target.closest('[data-delete-review]')?.getAttribute('data-delete-review');
  if (delId && confirmAction('Delete this review?')) {
    deleteDoc(doc(db, 'reviews', delId)).then(() => toast('Review deleted.'));
  }
});

/* =========================================================
   SETTINGS
   ========================================================= */
let settingsCache = { storeName: 'FoodHub Pro', currencySymbol: 'Rs ', taxRate: 0.08, deliveryFee: 2.99, freeDeliveryThreshold: 25, logoUrl: '' };
let settingsFormPopulated = false;
function populateSettingsForm(s) {
  $('set-storeName').value = s.storeName || 'FoodHub Pro';
  $('set-currencySymbol').value = s.currencySymbol || 'Rs ';
  $('set-taxRate').value = s.taxRate ?? 0.08;
  $('set-deliveryFee').value = s.deliveryFee ?? 2.99;
  $('set-freeDeliveryThreshold').value = s.freeDeliveryThreshold ?? 25;
  $('set-supportNote').value = s.supportNote || '';
  $('set-maintenanceMode').checked = !!s.maintenanceMode;
}
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settings-msg').textContent = '';
  try {
    await setDoc(doc(db, 'settings', 'site'), {
      storeName: $('set-storeName').value.trim(),
      currencySymbol: $('set-currencySymbol').value.trim() || 'Rs ',
      taxRate: parseFloat($('set-taxRate').value) || 0,
      deliveryFee: parseFloat($('set-deliveryFee').value) || 0,
      freeDeliveryThreshold: parseFloat($('set-freeDeliveryThreshold').value) || 0,
      supportNote: $('set-supportNote').value.trim(),
      maintenanceMode: $('set-maintenanceMode').checked,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    $('settings-msg').textContent = 'Saved.';
    $('settings-msg').style.color = 'var(--herb)';
    toast('Settings saved.');
  } catch (err) {
    $('settings-msg').textContent = 'Save failed.';
    $('settings-msg').style.color = 'var(--chili)';
    console.error(err);
  }
});

/* =========================================================
   WEBSITE CONTENT SETTINGS (new module)
   ---------------------------------------------------------
   Restaurant info, contact details, address, Google Maps, opening
   hours and footer content — all merged into the SAME "settings/site"
   Firestore doc used by the panels above, so it rides the same live
   listener and instantly reaches the storefront with no code changes.
   ========================================================= */
const WS_DAYS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];
const WS_DEFAULT_HOURS = { status: 'open', open: '12:00', close: '23:59' };
let websiteContentFormPopulated = false;

// Builds the day-by-day Opening Hours rows once. Values are filled in
// separately by populateWebsiteContentForm() whenever settings/site loads.
function renderWebsiteHoursRows() {
  const wrap = $('ws-hours-list');
  if (!wrap || wrap.children.length) return; // already built
  wrap.innerHTML = WS_DAYS.map((d) => `
    <div class="ws-day-row" id="ws-day-row-${d.key}" data-day="${d.key}">
      <span class="ws-day-name">${d.label}</span>
      <select class="ws-day-status" id="ws-hours-${d.key}-status">
        <option value="open">Open</option>
        <option value="closed">Closed</option>
        <option value="24h">24 Hours</option>
      </select>
      <div class="ws-day-times">
        <input type="time" id="ws-hours-${d.key}-open" />
        <span>to</span>
        <input type="time" id="ws-hours-${d.key}-close" />
      </div>
    </div>`).join('');
  wrap.querySelectorAll('.ws-day-status').forEach((sel) => {
    sel.addEventListener('change', () => {
      const day = sel.closest('.ws-day-row').getAttribute('data-day');
      updateWsDayRowClass(day, sel.value);
      renderWebsitePreview();
    });
  });
}
function updateWsDayRowClass(day, status) {
  const row = $(`ws-day-row-${day}`);
  if (!row) return;
  row.classList.toggle('is-closed', status === 'closed');
  row.classList.toggle('is-24h', status === '24h');
}

function populateWebsiteContentForm(s) {
  renderWebsiteHoursRows();
  $('ws-restaurantName').value = s.restaurantName || '';
  $('ws-tagline').value = s.tagline || '';
  $('ws-description').value = s.description || '';

  $('ws-supportEmail').value = s.supportEmail || '';
  $('ws-phone').value = s.phone || '';
  $('ws-whatsapp').value = s.whatsapp || '';
  $('ws-facebook').value = s.facebookUrl || '';
  $('ws-instagram').value = s.instagramUrl || '';
  $('ws-tiktok').value = s.tiktokUrl || '';
  $('ws-youtube').value = s.youtubeUrl || '';

  $('ws-shopName').value = s.shopName || '';
  $('ws-addressLine').value = s.addressLine || '';
  $('ws-city').value = s.city || '';
  $('ws-province').value = s.province || '';
  $('ws-country').value = s.country || '';

  $('ws-mapUrl').value = s.mapUrl || '';

  const hours = s.openingHours || {};
  WS_DAYS.forEach((d) => {
    const dayVal = { ...WS_DEFAULT_HOURS, ...(hours[d.key] || {}) };
    $(`ws-hours-${d.key}-status`).value = dayVal.status;
    $(`ws-hours-${d.key}-open`).value = dayVal.open;
    $(`ws-hours-${d.key}-close`).value = dayVal.close;
    updateWsDayRowClass(d.key, dayVal.status);
  });

  $('ws-footerText').value = s.footerText || '';
  $('ws-footerCopyright').value = s.footerCopyright || '';
  $('ws-footerPrivacyUrl').value = s.footerPrivacyUrl || '';
  $('ws-footerTermsUrl').value = s.footerTermsUrl || '';

  updateWsMapPreview();
  renderWebsitePreview();
}

function collectWebsiteContentFormData() {
  const openingHours = {};
  WS_DAYS.forEach((d) => {
    openingHours[d.key] = {
      status: $(`ws-hours-${d.key}-status`).value,
      open: $(`ws-hours-${d.key}-open`).value || WS_DEFAULT_HOURS.open,
      close: $(`ws-hours-${d.key}-close`).value || WS_DEFAULT_HOURS.close,
    };
  });
  return {
    restaurantName: $('ws-restaurantName').value.trim(),
    tagline: $('ws-tagline').value.trim(),
    description: $('ws-description').value.trim(),

    supportEmail: $('ws-supportEmail').value.trim(),
    phone: $('ws-phone').value.trim(),
    whatsapp: $('ws-whatsapp').value.trim(),
    facebookUrl: $('ws-facebook').value.trim(),
    instagramUrl: $('ws-instagram').value.trim(),
    tiktokUrl: $('ws-tiktok').value.trim(),
    youtubeUrl: $('ws-youtube').value.trim(),

    shopName: $('ws-shopName').value.trim(),
    addressLine: $('ws-addressLine').value.trim(),
    city: $('ws-city').value.trim(),
    province: $('ws-province').value.trim(),
    country: $('ws-country').value.trim(),

    mapUrl: $('ws-mapUrl').value.trim(),
    openingHours,

    footerText: $('ws-footerText').value.trim(),
    footerCopyright: $('ws-footerCopyright').value.trim(),
    footerPrivacyUrl: $('ws-footerPrivacyUrl').value.trim(),
    footerTermsUrl: $('ws-footerTermsUrl').value.trim(),
  };
}

// Turns whatever the admin pasted (a raw address, a normal maps.google.com /
// maps.app.goo.gl share link, an "Embed a map" URL, or a full <iframe> embed
// snippet) into a URL that's safe to drop straight into an <iframe src>.
function toEmbeddableMapUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const iframeMatch = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (iframeMatch) return iframeMatch[1];
  if (/output=embed/i.test(raw) || /\/maps\/embed/i.test(raw)) return raw;
  return `https://www.google.com/maps?q=${encodeURIComponent(raw)}&output=embed`;
}

function updateWsMapPreview() {
  const url = toEmbeddableMapUrl($('ws-mapUrl').value);
  const empty = $('ws-map-preview-empty');
  const frame = $('ws-map-preview-frame');
  if (url) {
    frame.src = url;
    frame.style.display = 'block';
    empty.style.display = 'none';
  } else {
    frame.style.display = 'none';
    frame.removeAttribute('src');
    empty.style.display = 'flex';
  }
}

function formatWsHoursLine(dayVal) {
  if (dayVal.status === 'closed') return 'Closed';
  if (dayVal.status === '24h') return 'Open 24 Hours';
  return `${dayVal.open || '--:--'} – ${dayVal.close || '--:--'}`;
}

function renderWebsitePreview() {
  if (!$('ws-preview-card')) return;
  const d = collectWebsiteContentFormData();

  $('pv-restaurantName').textContent = d.restaurantName || 'Your Restaurant Name';
  $('pv-tagline').textContent = d.tagline || '';
  $('pv-description').textContent = d.description || '';

  $('pv-email').textContent = d.supportEmail || '—';
  $('pv-phone').textContent = d.phone || '—';
  $('pv-whatsapp').textContent = d.whatsapp ? `WhatsApp: ${d.whatsapp}` : '—';

  const socials = [
    ['Facebook', d.facebookUrl], ['Instagram', d.instagramUrl],
    ['TikTok', d.tiktokUrl], ['YouTube', d.youtubeUrl],
  ].filter(([, url]) => url);
  $('pv-socials').innerHTML = socials.length
    ? socials.map(([name]) => `<span>${name}</span>`).join('')
    : '<span class="cell-muted">No social links yet</span>';

  $('pv-shopName').textContent = d.shopName || '—';
  const addressParts = [d.addressLine, d.city, d.province, d.country].filter(Boolean);
  $('pv-addressFull').textContent = addressParts.length ? addressParts.join(', ') : '—';

  $('pv-hours').innerHTML = WS_DAYS.map((day) => `
    <p style="display:flex;justify-content:space-between;gap:10px;">
      <span>${day.label}</span><span class="mono">${escapeHtmlWs(formatWsHoursLine(d.openingHours[day.key]))}</span>
    </p>`).join('');

  const mapUrl = toEmbeddableMapUrl(d.mapUrl);
  const mapWrap = $('pv-map-wrap');
  if (mapUrl) {
    $('pv-map-frame').src = mapUrl;
    mapWrap.style.display = 'block';
  } else {
    mapWrap.style.display = 'none';
  }

  $('pv-footerText').textContent = d.footerText || '';
  $('pv-footerCopyright').textContent = d.footerCopyright ? `© ${d.footerCopyright}` : '';
  $('pv-footerPrivacy').textContent = d.footerPrivacyUrl ? 'Privacy Policy →' : 'Privacy Policy (not set)';
  $('pv-footerTerms').textContent = d.footerTermsUrl ? 'Terms & Conditions →' : 'Terms & Conditions (not set)';
}
// Minimal HTML escaper local to this module — avoids relying on any escaping
// helper that may or may not exist elsewhere in this file.
function escapeHtmlWs(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Live preview + map preview update as the admin types — delegated on the
// form so it works for every field without a per-input listener.
$('website-content-form').addEventListener('input', () => {
  updateWsMapPreview();
  renderWebsitePreview();
});

$('website-content-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ws-save-msg').textContent = '';
  $('ws-save-btn').disabled = true;
  try {
    await setDoc(doc(db, 'settings', 'site'), {
      ...collectWebsiteContentFormData(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    $('ws-save-msg').textContent = 'Saved — live on the storefront now.';
    $('ws-save-msg').style.color = 'var(--herb)';
    toast('Website settings saved.');
  } catch (err) {
    $('ws-save-msg').textContent = 'Save failed.';
    $('ws-save-msg').style.color = 'var(--chili)';
    console.error(err);
  } finally {
    $('ws-save-btn').disabled = false;
  }
});

/* =========================================================
   LOGO MANAGEMENT
   ---------------------------------------------------------
   Also lives in the "settings/site" doc (field: logoUrl), so it rides
   the same live listener as the rest of Website Settings — saving here
   updates the storefront navbar, loading screen, footer, and favicon
   instantly, with no separate collection needed. Uploads reuse the same
   Cloudinary cloud name / unsigned upload preset as every other image
   in this app (see uploadToCloudinary above) — this just adds an
   XHR-based variant so we can report real upload progress, which plain
   fetch() cannot do.
   ========================================================= */
const LOGO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOGO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
let logoSelectedFile = null;

function renderLogoManager(s) {
  const url = s?.logoUrl || '';
  const img = $('logo-current-preview');
  const empty = $('logo-current-empty');
  if (url) { img.src = url; img.style.display = ''; empty.style.display = 'none'; }
  else { img.removeAttribute('src'); img.style.display = 'none'; empty.style.display = ''; }
}

$('logo-file-input').addEventListener('change', () => {
  const file = $('logo-file-input').files[0];
  $('logo-msg').textContent = '';
  $('logo-msg').style.color = 'var(--chili)';
  logoSelectedFile = null;
  $('logo-preview-wrap').style.display = 'none';

  if (!file) return;

  if (!LOGO_ALLOWED_TYPES.includes(file.type)) {
    $('logo-msg').textContent = 'Please choose a PNG, JPG, JPEG, or WebP image.';
    $('logo-file-input').value = '';
    return;
  }
  if (file.size > LOGO_MAX_BYTES) {
    $('logo-msg').textContent = `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the maximum is 5 MB.`;
    $('logo-file-input').value = '';
    return;
  }

  logoSelectedFile = file;
  $('logo-new-preview').src = URL.createObjectURL(file);
  $('logo-preview-wrap').style.display = '';
});

function setLogoProgress(pct, label) {
  $('logo-progress-wrap').style.display = '';
  $('logo-progress-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('logo-progress-text').textContent = label || `Uploading… ${Math.round(pct)}%`;
}
function hideLogoProgress() {
  $('logo-progress-wrap').style.display = 'none';
  $('logo-progress-bar').style.width = '0%';
}

// XHR-based upload to the SAME Cloudinary endpoint/preset as uploadToCloudinary(),
// used only here so we can surface real upload-progress percentages via
// XMLHttpRequest's progress event (fetch() offers no upload-progress API).
function uploadLogoToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = CLOUDINARY_UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    };
    xhr.ontimeout = () => reject(new Error(`Image upload timed out after ${CLOUDINARY_UPLOAD_TIMEOUT_MS / 1000}s — Cloudinary never responded.`));
    xhr.onerror = () => reject(new Error('Image upload failed — could not reach Cloudinary (network/CORS issue).'));
    xhr.onload = () => {
      let result = null;
      try { result = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (_) { /* fall through */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = result?.error?.message
          || (xhr.status === 400 ? 'Bad request — the Upload Preset is likely missing, misspelled, or not configured as "Unsigned".'
            : xhr.status === 401 ? 'Unauthorized — check that the Cloud Name is correct.'
            : xhr.status === 404 ? 'Not found — the Cloud Name is likely incorrect.'
            : `HTTP ${xhr.status} ${xhr.statusText}`);
        reject(new Error(`Image upload failed: ${detail}`));
        return;
      }
      if (!result) { reject(new Error('Image upload failed — Cloudinary returned a response that could not be parsed as JSON.')); return; }
      if (!isValidImageUrl(result.secure_url)) { reject(new Error('Image upload failed — Cloudinary did not return a valid secure_url.')); return; }
      resolve(result.secure_url);
    };
    xhr.send(formData);
  });
}

$('logo-save-btn').addEventListener('click', async () => {
  $('logo-msg').textContent = '';
  if (!logoSelectedFile) {
    $('logo-msg').style.color = 'var(--chili)';
    $('logo-msg').textContent = 'Choose an image first.';
    return;
  }
  $('logo-save-btn').disabled = true;
  $('logo-restore-btn').disabled = true;
  setLogoProgress(0, 'Uploading… 0%');
  try {
    const url = await uploadLogoToCloudinary(logoSelectedFile, (pct) => setLogoProgress(pct));
    setLogoProgress(100, 'Saving…');
    await setDoc(doc(db, 'settings', 'site'), { logoUrl: url, updatedAt: serverTimestamp() }, { merge: true });
    hideLogoProgress();
    logoSelectedFile = null;
    $('logo-file-input').value = '';
    $('logo-preview-wrap').style.display = 'none';
    $('logo-msg').style.color = 'var(--herb)';
    $('logo-msg').textContent = 'Logo saved.';
    toast('Logo saved — live on the storefront now.');
  } catch (err) {
    hideLogoProgress();
    $('logo-msg').style.color = 'var(--chili)';
    $('logo-msg').textContent = err.message || 'Upload failed.';
    console.error(err);
  }
  $('logo-save-btn').disabled = false;
  $('logo-restore-btn').disabled = false;
});

$('logo-restore-btn').addEventListener('click', async () => {
  if (!confirmAction('Restore the default logo? This removes your custom logo everywhere on the storefront.')) return;
  $('logo-msg').textContent = '';
  $('logo-save-btn').disabled = true;
  $('logo-restore-btn').disabled = true;
  try {
    await setDoc(doc(db, 'settings', 'site'), { logoUrl: '', updatedAt: serverTimestamp() }, { merge: true });
    logoSelectedFile = null;
    $('logo-file-input').value = '';
    $('logo-preview-wrap').style.display = 'none';
    $('logo-msg').style.color = 'var(--herb)';
    $('logo-msg').textContent = 'Default logo restored.';
    toast('Default logo restored.');
  } catch (err) {
    $('logo-msg').style.color = 'var(--chili)';
    $('logo-msg').textContent = 'Restore failed.';
    console.error(err);
  }
  $('logo-save-btn').disabled = false;
  $('logo-restore-btn').disabled = false;
});

/* =========================================================
   PAYMENT MANAGEMENT
   ---------------------------------------------------------
   Lives in the SAME "settings/site" Firestore doc as the rest of the
   storefront config, so it rides the same live listener — a toggle or
   QR upload here updates the checkout page instantly, with no separate
   collection or extra round trip needed.
   ========================================================= */
let paymentsFormPopulated = false;
function populatePaymentsForm(s) {
  $('pm-easypaisa-enabled').checked = s.easypaisaEnabled !== false;
  $('pm-easypaisa-title').value = s.easypaisaAccountTitle || '';
  $('pm-easypaisa-number').value = s.easypaisaNumber || '';
  if (s.easypaisaQrUrl) { $('pm-easypaisa-qr-preview').src = s.easypaisaQrUrl; $('pm-easypaisa-qr-preview').classList.add('visible'); }

  $('pm-jazzcash-enabled').checked = s.jazzcashEnabled !== false;
  $('pm-jazzcash-title').value = s.jazzcashAccountTitle || '';
  $('pm-jazzcash-number').value = s.jazzcashNumber || '';
  if (s.jazzcashQrUrl) { $('pm-jazzcash-qr-preview').src = s.jazzcashQrUrl; $('pm-jazzcash-qr-preview').classList.add('visible'); }

  $('pm-cod-enabled').checked = s.codEnabled !== false;
}
function wireQrPreview(fileInputId, previewId) {
  $(fileInputId).addEventListener('change', () => {
    const file = $(fileInputId).files[0];
    if (!file) return;
    const preview = $(previewId);
    preview.src = URL.createObjectURL(file);
    preview.classList.add('visible');
  });
}
wireQrPreview('pm-easypaisa-qr-file', 'pm-easypaisa-qr-preview');
wireQrPreview('pm-jazzcash-qr-file', 'pm-jazzcash-qr-preview');

async function uploadQrCode(method, file) {
  // Same Cloudinary unsigned-upload path used for product photos — see
  // uploadToCloudinary() above. Kept as a thin wrapper (rather than calling
  // uploadToCloudinary directly at each call site) so the `method` name is
  // still available here if per-method logging/handling is ever needed.
  return uploadToCloudinary(file);
}

$('payments-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('payments-msg').textContent = '';
  $('payments-save-btn').disabled = true;
  try {
    const update = {
      easypaisaEnabled: $('pm-easypaisa-enabled').checked,
      easypaisaAccountTitle: $('pm-easypaisa-title').value.trim(),
      easypaisaNumber: $('pm-easypaisa-number').value.trim(),
      jazzcashEnabled: $('pm-jazzcash-enabled').checked,
      jazzcashAccountTitle: $('pm-jazzcash-title').value.trim(),
      jazzcashNumber: $('pm-jazzcash-number').value.trim(),
      codEnabled: $('pm-cod-enabled').checked,
      updatedAt: serverTimestamp(),
    };
    const easypaisaFile = $('pm-easypaisa-qr-file').files[0];
    if (easypaisaFile) update.easypaisaQrUrl = await uploadQrCode('easypaisa', easypaisaFile);
    const jazzcashFile = $('pm-jazzcash-qr-file').files[0];
    if (jazzcashFile) update.jazzcashQrUrl = await uploadQrCode('jazzcash', jazzcashFile);

    await setDoc(doc(db, 'settings', 'site'), update, { merge: true });
    $('pm-easypaisa-qr-file').value = '';
    $('pm-jazzcash-qr-file').value = '';
    $('payments-msg').textContent = 'Saved.';
    $('payments-msg').style.color = 'var(--herb)';
    toast('Payment settings saved — live on the storefront now.');
  } catch (err) {
    $('payments-msg').textContent = 'Save failed.';
    $('payments-msg').style.color = 'var(--chili)';
    console.error(err);
  }
  $('payments-save-btn').disabled = false;
});

/* =========================================================
   DASHBOARD
   ========================================================= */
function renderDashboard() {
  const now = new Date();
  const todayKey = now.toDateString();
  const todaysOrders = ordersCache.filter((o) => {
    const d = o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt ? new Date(o.createdAt) : null);
    return d && d.toDateString() === todayKey;
  });
  $('stat-orders-today').textContent = todaysOrders.length;
  $('stat-orders-pending').textContent = ordersCache.filter((o) => o.status === 'Pending').length;
  $('stat-revenue-today').textContent = money(todaysOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0));
  $('stat-products').textContent = productsCache.length;
  $('stat-customers').textContent = customersCache.length;

  const recent = ordersCache.slice(0, 8);
  $('dashboard-recent-orders').innerHTML = recent.length === 0
    ? `<tr class="empty-row"><td colspan="6">No orders yet.</td></tr>`
    : recent.map((o) => `
      <tr>
        <td class="mono">${esc(o.orderNumber)}</td>
        <td>${esc(o.customer?.name || '—')}</td>
        <td class="cell-muted">${(o.items || []).length} item${(o.items || []).length === 1 ? '' : 's'}</td>
        <td class="mono">${money(o.total)}</td>
        <td><span class="badge ${statusBadgeClass(o.status)}">${esc(o.status)}</span></td>
        <td class="cell-muted">${fmtDate(o.createdAt)}</td>
      </tr>`).join('');
}

/* =========================================================
   LIVE LISTENERS (started only after admin auth confirmed)
   ========================================================= */
function startListeners() {
  unsubscribers.push(onSnapshot(collection(db, 'products'), (snap) => {
    productsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderProductsTable(); renderDashboard();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'categories'), (snap) => {
    categoriesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCategoriesTable();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'homepageSections'), (snap) => {
    sectionsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSectionsTable();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'comboMeals'), (snap) => {
    combosCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCombosTable();
  }, (err) => console.warn('combo meals listener error:', err)));
  unsubscribers.push(onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc')), (snap) => {
    ordersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderOrdersTable(); renderDashboard();
    if (openDrawerOrderId) openOrderDrawer(openDrawerOrderId);
  }, (err) => console.warn('orders listener error (needs an index the first time — Firestore will log a console link to auto-create it):', err)));
  unsubscribers.push(onSnapshot(collection(db, 'customers'), (snap) => {
    customersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCustomersTable(); renderDashboard();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'users'), (snap) => {
    usersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderUsersTable();
  }, (err) => console.warn('users listener error:', err)));
  unsubscribers.push(onSnapshot(collection(db, 'coupons'), (snap) => {
    couponsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCouponsTable();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'reviews'), (snap) => {
    reviewsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderReviewsTable();
  }));
  unsubscribers.push(onSnapshot(doc(db, 'settings', 'site'), (snap) => {
    settingsCache = snap.exists() ? { ...settingsCache, ...snap.data() } : settingsCache;
    ADMIN_CURRENCY = settingsCache.currencySymbol || 'Rs ';
    if (!settingsFormPopulated) { populateSettingsForm(settingsCache); settingsFormPopulated = true; }
    if (!paymentsFormPopulated) { populatePaymentsForm(settingsCache); paymentsFormPopulated = true; }
    if (!websiteContentFormPopulated) { populateWebsiteContentForm(settingsCache); websiteContentFormPopulated = true; }
    renderLogoManager(settingsCache);
    renderProductsTable(); renderOrdersTable(); renderCustomersTable(); renderCouponsTable(); renderCombosTable(); renderDashboard();
  }));
}
