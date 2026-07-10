/* =========================================================
   FoodHub Pro — Admin Panel logic
   ---------------------------------------------------------
   Loaded by admin/index.html as:
     <script type="module" src="admin.js"></script>
   (swap the inline <script type="module">...</script> block
   in that file for this tag if you'd rather keep the logic in
   its own file — nothing else on the page needs to change;
   every element id it queries already exists in that HTML.)

   Connects to:
   - Firebase Authentication (admin email/password login, gated
     by an admins/{uid} Firestore doc — see SETUP.md)
   - Firestore (products, categories, orders, customers,
     coupons, reviews, settings — all real-time via onSnapshot)
   - Cloudinary (product image uploads, via unsigned upload preset)

   Firebase bootstrap: this file loads firebase-config.js from
   one folder up (../firebase-config.js — i.e. this file is
   expected to live at admin/admin.js, next to admin/index.html,
   with firebase-config.js at the site root) via a DYNAMIC
   import with a couple of fallback paths, and never touches
   initializeApp() directly. A static top-level import of a
   relative path would silently kill this entire module the
   moment the folder layout doesn't match exactly — nothing
   below it would run at all, including the login form's submit
   handler — with nothing but a console error to explain why.
   The dynamic import + fallback avoids that trap and shows a
   clear on-screen message instead.

   No localStorage/sessionStorage anywhere — Firestore is the
   persistence layer for data (Cloudinary hosts image files),
   so every admin session and every browser tab always sees
   live, current data.
   ========================================================= */

import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
// Product photos are uploaded to Cloudinary (unsigned upload preset) instead
// of Firebase Storage — see uploadProductImage() below. Firestore is still
// the source of truth: only the resulting secure_url is saved, into the
// existing imageUrl field, exactly as before.
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
let ADMIN_CURRENCY = '$';
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
function teardownListeners() { unsubscribers.forEach((u) => u()); unsubscribers = []; settingsFormPopulated = false; }

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
  $('modal-save').disabled = true;
  try {
    await modalOnSave();
    closeModal();
  } catch (err) {
    // BUG FIX: this used to always show a generic "Something went wrong"
    // toast, discarding whatever specific error modalOnSave() threw —
    // including the detailed Cloudinary/Firestore error messages that
    // uploadProductImage() below now produces. err.message === 'validation'
    // is a special sentinel thrown by a couple of form-validation checks
    // (which already show their own toast before throwing), so it stays
    // silent here to avoid clobbering that message.
    if (err && err.message !== 'validation') {
      toast(err && err.message ? err.message : 'Something went wrong — check the console.');
    }
    console.error(err);
  }
  $('modal-save').disabled = false;
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

function productFormHTML(p = {}) {
  return `
    <div class="field"><label>Dish Name</label><input id="pf-name" value="${esc(p.name || '')}" /></div>
    <div class="field"><label>Description</label><textarea id="pf-description" rows="2">${esc(p.description || '')}</textarea></div>
    <div class="form-row">
      <div class="field"><label>Category</label><select id="pf-category">${categoryOptionsHTML(p.category)}</select></div>
      <div class="field"><label>Price (USD)</label><input id="pf-price" type="number" step="0.01" value="${p.price ?? ''}" /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Restaurant / Kitchen</label><input id="pf-restaurant" value="${esc(p.restaurant || '')}" /></div>
      <div class="field"><label>Rating (0–5)</label><input id="pf-rating" type="number" step="0.1" min="0" max="5" value="${p.rating ?? 4.5}" /></div>
    </div>
    <div class="field"><label>Badge (optional, e.g. BESTSELLER, NEW)</label><input id="pf-badge" value="${esc(p.badge || '')}" /></div>
    <div class="field">
      <label>Product Image</label>
      <img class="image-preview ${p.imageUrl ? 'visible' : ''}" id="pf-image-preview" src="${esc(p.imageUrl || '')}" />
      <input type="file" id="pf-image-file" accept="image/*" />
      <div class="cell-muted" style="margin-top:6px;">Leave empty to keep the current image, or to fall back to a live stock photo for the category.</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="pf-vegetarian" ${p.vegetarian ? 'checked' : ''} /><label for="pf-vegetarian">Vegetarian (drives the storefront's "Vegetarian mode" filter)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="pf-active" ${p.active !== false ? 'checked' : ''} /><label for="pf-active">Active (visible on storefront)</label></div>
  `;
}

$('add-product-btn').addEventListener('click', () => {
  openModal('Add Product', productFormHTML(), async () => {
    const file = $('pf-image-file').files[0];
    const data = {
      name: $('pf-name').value.trim(),
      description: $('pf-description').value.trim(),
      category: $('pf-category').value,
      price: parseFloat($('pf-price').value) || 0,
      restaurant: $('pf-restaurant').value.trim(),
      rating: parseFloat($('pf-rating').value) || 4.5,
      badge: $('pf-badge').value.trim(),
      vegetarian: $('pf-vegetarian').checked,
      active: $('pf-active').checked,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (!data.name || !data.category) { toast('Name and category are required.'); throw new Error('validation'); }
    const ref = await addDoc(collection(db, 'products'), data);
    if (file) await uploadProductImage(ref.id, file);
    toast('Product added.');
  });
  $('pf-image-file').addEventListener('change', previewImage);
});

document.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit-product]')?.getAttribute('data-edit-product');
  if (editId) {
    const p = productsCache.find((x) => x.id === editId);
    openModal('Edit Product', productFormHTML(p), async () => {
      const file = $('pf-image-file').files[0];
      const data = {
        name: $('pf-name').value.trim(),
        description: $('pf-description').value.trim(),
        category: $('pf-category').value,
        price: parseFloat($('pf-price').value) || 0,
        restaurant: $('pf-restaurant').value.trim(),
        rating: parseFloat($('pf-rating').value) || 4.5,
        badge: $('pf-badge').value.trim(),
        vegetarian: $('pf-vegetarian').checked,
        active: $('pf-active').checked,
        updatedAt: serverTimestamp(),
      };
      await updateDoc(doc(db, 'products', editId), data);
      if (file) await uploadProductImage(editId, file, p.imageUrl);
      toast('Product updated.');
    });
    $('pf-image-file').addEventListener('change', previewImage);
  }
  const delId = e.target.closest('[data-delete-product]')?.getAttribute('data-delete-product');
  if (delId && confirmAction('Delete this product? This cannot be undone.')) {
    const existing = productsCache.find((x) => x.id === delId);
    deleteDoc(doc(db, 'products', delId))
      .then(() => {
        toast('Product deleted.');
        // Cloudinary images aren't auto-deleted here — unsigned client
        // uploads have no safe delete path (see uploadProductImage above).
        // Remove existing?.imageUrl from Cloudinary manually if needed.
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
// How long we're willing to wait on the Cloudinary POST before giving up.
// ROOT CAUSE OF THE ORIGINAL BUG: the old fetch() call here had no timeout
// and no AbortController. If Cloudinary/the network ever stalls (bad
// cloud name, an ad-blocker/firewall silently dropping the request, a
// flaky connection, etc.) fetch() just hangs — it never resolves AND
// never rejects. Because everything here was awaited in a chain
// (modalOnSave -> uploadProductImage -> fetch), the Save button stayed
// disabled and the modal just sat there until the *browser's own*
// underlying socket timeout eventually fired (which is what showed up
// as a vague "timeout" after several seconds), and even then the
// generic catch in the modal-save handler (see above) threw away
// whatever real reason was available. Wrapping fetch in an
// AbortController with an explicit timeout guarantees Save always
// settles one way or another within a bounded time.
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 30000;

// A Cloudinary secure_url should always be a valid https:// URL. We
// verify this before ever writing it into Firestore, so a malformed or
// missing URL (e.g. from a corrupted response) can never end up saved
// against a product.
function isValidImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !!parsed.hostname;
  } catch (_) {
    return false;
  }
}

async function uploadProductImage(productId, file, oldImageUrl) {
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
    // failure on the cloud name, or the browser blocking the request as
    // a CORS violation (Cloudinary's own endpoint sends permissive CORS
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

  try {
    await updateDoc(doc(db, 'products', productId), { imageUrl: result.secure_url, updatedAt: serverTimestamp() });
  } catch (err) {
    console.error('[Firestore] Image uploaded to Cloudinary, but saving imageUrl to product', productId, 'failed:', err);
    throw new Error(`Image uploaded to Cloudinary, but saving it to the product failed: ${err.code ? `${err.code} — ` : ''}${err.message || err}`);
  }
  // Note: unlike Firebase Storage's deleteObject(), Cloudinary's unsigned
  // upload API has no client-safe way to delete the old image (deleting
  // requires a signed request using your API secret, which must stay
  // server-side). oldImageUrl is intentionally left alone here — old photos
  // will remain in your Cloudinary media library and can be cleaned up
  // there manually or via a server-side job if desired.
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
   ORDERS
   ========================================================= */
let ordersCache = [];
const STATUS_OPTIONS = ['Pending', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

function statusSelectHTML(orderId, current) {
  return `<select class="status-select" data-status-select="${orderId}">
    ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`).join('')}
  </select>`;
}
function renderOrdersTable() {
  const q = ($('orders-search').value || '').toLowerCase();
  const statusFilter = $('orders-status-filter').value;
  const rows = ordersCache.filter((o) =>
    (!statusFilter || o.status === statusFilter) &&
    (!q || (o.orderNumber || '').toLowerCase().includes(q) || (o.customer?.phone || '').includes(q) || (o.customer?.name || '').toLowerCase().includes(q))
  );
  $('orders-table-body').innerHTML = rows.length === 0
    ? `<tr class="empty-row"><td colspan="7">No orders match your filters.</td></tr>`
    : rows.map((o) => `
      <tr>
        <td class="mono cell-name" style="cursor:pointer;" data-open-order="${o.id}">${esc(o.orderNumber)}</td>
        <td>${esc(o.customer?.name || '—')}</td>
        <td class="mono">${esc(o.customer?.phone || '—')}</td>
        <td class="mono">${money(o.total)}</td>
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
      <select id="mo-payment"><option>Cash on Delivery</option><option>Card</option><option>Wallet</option></select>
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
    await addDoc(collection(db, 'orders'), {
      orderNumber,
      customer: { name, phone, city: $('mo-city').value.trim(), address: $('mo-address').value.trim() },
      items,
      subtotal: round2(subtotal), discount: 0, delivery: round2(delivery), tax: round2(tax), total: round2(total),
      couponCode: null, paymentMethod: $('mo-payment').value, status: 'Pending',
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

function openOrderDrawer(orderId) {
  const o = ordersCache.find((x) => x.id === orderId);
  if (!o) return;
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
      <div class="cell-muted">${esc(o.paymentMethod || '—')}</div>
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
function closeOrderDrawer() { $('order-drawer').classList.remove('open'); $('order-drawer-overlay').classList.remove('visible'); }

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
let settingsCache = { storeName: 'FoodHub Pro', currencySymbol: '$', taxRate: 0.08, deliveryFee: 2.99, freeDeliveryThreshold: 25 };
let settingsFormPopulated = false;
function populateSettingsForm(s) {
  $('set-storeName').value = s.storeName || 'FoodHub Pro';
  $('set-currencySymbol').value = s.currencySymbol || '$';
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
      currencySymbol: $('set-currencySymbol').value.trim() || '$',
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
  unsubscribers.push(onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc')), (snap) => {
    ordersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderOrdersTable(); renderDashboard();
  }, (err) => console.warn('orders listener error (needs an index the first time — Firestore will log a console link to auto-create it):', err)));
  unsubscribers.push(onSnapshot(collection(db, 'customers'), (snap) => {
    customersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCustomersTable(); renderDashboard();
  }));
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
    ADMIN_CURRENCY = settingsCache.currencySymbol || '$';
    if (!settingsFormPopulated) { populateSettingsForm(settingsCache); settingsFormPopulated = true; }
    renderProductsTable(); renderOrdersTable(); renderCustomersTable(); renderCouponsTable(); renderDashboard();
  }));
}
