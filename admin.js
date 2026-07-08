/* =========================================================
   FoodHub Pro — Admin Panel logic
   ---------------------------------------------------------
   Loaded by admin/index.html as:
     <script type="module" src="admin.js"></script>
   (swap the old inline <script type="module">...</script>
   block in that file for this tag — nothing else on the page
   needs to change; every element id it queries already exists
   in that HTML.)

   Connects to:
   - Firebase Authentication (admin email/password login, gated
     by an admins/{uid} Firestore doc — see SETUP.md)
   - Firestore (products, categories, orders, customers,
     coupons, reviews, settings — all real-time via onSnapshot)
   - Firebase Storage (product image uploads)

   Firebase bootstrap: this file calls initializeFirebaseApp()
   from ../firebase-config.js and never touches initializeApp()
   directly, so the app is still only ever initialized once no
   matter how many pages/scripts import that module. If the
   config is missing or invalid, initializeFirebaseApp() throws
   a FirebaseConfigError, which is caught below and shown as a
   full-screen notice via renderFirebaseConfigError() — Auth/
   Firestore/Storage listeners are then simply never wired up
   (firebaseReady stays false) instead of throwing further
   errors into the console.

   No localStorage/sessionStorage anywhere — Firestore and
   Storage are the only persistence layer, so every admin
   session and every browser tab always sees live, current data.
   ========================================================= */

import { initializeFirebaseApp, renderFirebaseConfigError } from '../firebase-config.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';

// The Admin Panel cannot do anything useful without Firebase, so a missing
// or invalid config gets a blocking, full-screen notice (replacing the
// login card) rather than a half-broken login form or a console crash.
let auth = null;
let db = null;
let storage = null;
let firebaseReady = false;
try {
  const app = initializeFirebaseApp();
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  firebaseReady = true;
} catch (err) {
  console.error('FoodHub Admin: Firebase is not configured.', err);
  renderFirebaseConfigError(err.message || 'Firebase is not configured.', {
    mode: 'fullscreen',
    targetSelector: '#login-screen',
  });
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

// Only wired up when Firebase actually initialized — otherwise the login
// screen already shows the full-screen configuration notice and there is
// nothing further to set up.
if (firebaseReady) {
  onAuthStateChanged(auth, async (user) => {
    teardownListeners();
    if (!user) {
      $('login-screen').style.display = 'flex';
      $('app-shell').classList.remove('visible');
      return;
    }
    // Verify this user is an authorized admin (admins/{uid} doc must exist —
    // created manually by you in the Firebase Console, see SETUP.md).
    try {
      const adminDoc = await getDoc(doc(db, 'admins', user.uid));
      if (!adminDoc.exists()) {
        $('login-error').textContent = 'This account is not authorized as an admin.';
        await signOut(auth);
        return;
      }
    } catch (err) {
      $('login-error').textContent = 'Could not verify admin access. Check your Firestore rules.';
      await signOut(auth);
      return;
    }
    $('login-screen').style.display = 'none';
    $('app-shell').classList.add('visible');
    $('admin-email').textContent = user.email;
    startListeners();
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
  try { await modalOnSave(); closeModal(); }
  catch (err) { toast('Something went wrong — check the console.'); console.error(err); }
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
        if (existing?.imageUrl) deleteObject(storageRef(storage, existing.imageUrl)).catch(() => {}); // best-effort cleanup
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
async function uploadProductImage(productId, file, oldImageUrl) {
  const path = `product-images/${productId}-${Date.now()}-${file.name}`;
  const ref = storageRef(storage, path);
  await uploadBytes(ref, file);
  const url = await getDownloadURL(ref);
  await updateDoc(doc(db, 'products', productId), { imageUrl: url, updatedAt: serverTimestamp() });
  if (oldImageUrl && oldImageUrl !== url) {
    deleteObject(storageRef(storage, oldImageUrl)).catch(() => {}); // best-effort cleanup, ignore if already gone
  }
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
