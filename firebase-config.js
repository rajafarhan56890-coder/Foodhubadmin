/* =========================================================
   FoodHub Pro — Firebase configuration & bootstrap
   ---------------------------------------------------------
   This is the ONLY file you need to edit to connect FoodHub Pro
   to your own Firebase project. Both the storefront (index.html)
   and the Admin Panel (admin/index.html) import it, so your
   credentials only ever live in one place.

   HOW TO SET THIS UP
   -------------------
   1. Firebase Console → Project settings → General → "Your apps"
      → SDK setup and configuration → Config.
   2. Copy each value into FIREBASE_CONFIG below (leave the key
      names exactly as they are).
   3. Save. Both pages pick it up automatically on next load.

   Full walkthrough: see SETUP.md.

   WHAT THIS FILE ALSO DOES
   -------------------------
   Beyond just holding your config, this module:
     - Validates the config before anything tries to use it.
     - Initializes the Firebase App exactly once, even if multiple
       scripts on the same page import this module (Firebase logs
       a warning — or in some environments throws — if you call
       initializeApp() more than once for the same app).
     - Never throws an uncaught error into the page. If the config
       is missing/invalid, or Firebase fails to initialize for any
       other reason, callers get a clear, typed error back and can
       decide how to degrade gracefully — the site should never go
       blank or throw a raw stack trace at a shopper or an admin.
     - Provides a ready-made, professional-looking error banner /
       full-screen notice (renderFirebaseConfigError) so both pages
       can present the same "Firebase isn't configured yet" message
       without duplicating UI code.
   ========================================================= */

import {
  initializeApp,
  getApps,
  getApp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';

/**
 * Your Firebase project's web config. Replace every empty string
 * below with the matching value from the Firebase Console. Do not
 * rename the keys — the SDK expects these exact names.
 *
 * Left blank, FoodHub Pro will still run: the storefront falls back
 * to local-only behavior (cart/wishlist keep working, but there is
 * no live catalog, checkout sync, or admin access) and shows a
 * clear, dismissible notice instead of breaking. See SETUP.md.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyCbcHkG6ONk8BbNg2zx3lja5R16s3gZRFs',
  authDomain: 'foodhub-68331.firebaseapp.com',
  databaseURL: 'https://foodhub-68331-default-rtdb.firebaseio.com',
  projectId: 'foodhub-68331',
  storageBucket: 'foodhub-68331.firebasestorage.app',
  messagingSenderId: '112903210902',
  appId: '1:112903210902:web:8acfbd3243440cddbfbfb7',
  // Not in REQUIRED_KEYS below (this module doesn't wire up Analytics),
  // kept here in case you add it later.
  measurementId: 'G-QJ00H23FCC',
};

/** Keys every valid Firebase web config must have a real value for. */
const REQUIRED_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

/**
 * A typed error so callers can distinguish "you haven't configured
 * Firebase yet" from an unrelated runtime error, without parsing
 * error message strings.
 */
export class FirebaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirebaseConfigError';
  }
}

/**
 * Checks that every required key is present and non-empty. Does not
 * check that the values are *correct* (that can only be discovered
 * by actually trying to initialize/connect), only that the config
 * has been filled in at all.
 */
export function isFirebaseConfigValid(config = firebaseConfig) {
  if (!config || typeof config !== 'object') return false;
  return REQUIRED_KEYS.every(
    (key) => typeof config[key] === 'string' && config[key].trim().length > 0
  );
}

/**
 * Initializes (or reuses) the single Firebase App instance for this
 * page. Safe to call multiple times — every caller after the first
 * gets back the same already-initialized app instead of triggering
 * a duplicate-app error.
 *
 * Throws FirebaseConfigError if the config is missing/invalid, or
 * if the underlying Firebase SDK call itself fails (e.g. malformed
 * values). Callers should wrap this in a try/catch and fall back to
 * renderFirebaseConfigError() rather than letting it propagate.
 */
export function initializeFirebaseApp(config = firebaseConfig) {
  if (!isFirebaseConfigValid(config)) {
    throw new FirebaseConfigError(
      'Firebase configuration is missing or incomplete. Add your project credentials to firebase-config.js.'
    );
  }
  try {
    // getApps() returns every app already initialized on this page.
    // Reusing it (rather than calling initializeApp again) is what
    // makes this safe to call from more than one script/module.
    return getApps().length ? getApp() : initializeApp(config);
  } catch (err) {
    throw new FirebaseConfigError(`Firebase failed to initialize: ${err.message || err}`);
  }
}

/* ---------------------------------------------------------
   Shared, dependency-free error UI
   ---------------------------------------------------------
   Deliberately uses inline styles (no external stylesheet, no
   class names that could collide with either host page's CSS)
   so it renders consistently and safely on both the storefront
   and the Admin Panel, however this module ends up being used.
   --------------------------------------------------------- */

const BANNER_ID = 'firebase-config-banner';

function baseNoticeStyles() {
  return `
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #2A2521;
  `;
}

/**
 * Shows a non-blocking, dismissible banner fixed to the top of the
 * page. Intended for pages that can still be partially useful
 * without Firebase (e.g. the storefront, whose cart/wishlist still
 * work locally even with no live catalog).
 */
function renderBanner(message) {
  if (document.getElementById(BANNER_ID)) return; // don't stack duplicates
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.style.cssText = `
    ${baseNoticeStyles()}
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    background: #FFF4DE; border-bottom: 1px solid #F0C878;
    padding: 12px 16px; font-size: 13.5px; line-height: 1.5;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
  `;
  banner.innerHTML = `
    <span style="font-size:16px;">⚠️</span>
    <span style="flex:1;min-width:200px;"><strong>Firebase isn't configured yet.</strong> ${escapeForHtml(message)} See <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:4px;">SETUP.md</code> for setup steps.</span>
    <button type="button" aria-label="Dismiss" style="
      background:transparent;border:1px solid rgba(0,0,0,0.15);border-radius:6px;
      padding:4px 10px;font-size:12.5px;cursor:pointer;color:inherit;
    ">Dismiss</button>
  `;
  banner.querySelector('button').addEventListener('click', () => banner.remove());
  document.body.prepend(banner);
}

/**
 * Shows a full-screen, blocking notice. Intended for pages that
 * cannot function at all without Firebase (e.g. the Admin Panel,
 * which has nothing useful to do without Auth/Firestore). Replaces
 * the contents of `targetSelector` if provided and found; otherwise
 * falls back to injecting a full-viewport overlay.
 */
function renderFullScreen(message, targetSelector) {
  const html = `
    <div style="
      ${baseNoticeStyles()}
      max-width: 420px; margin: 0 auto; text-align: center;
      background: #FAF6EE; border: 1px solid rgba(30,27,24,0.12);
      border-radius: 14px; padding: 36px 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.15);
    ">
      <div style="font-size:32px;margin-bottom:12px;">⚠️</div>
      <h1 style="font-size:17px;margin:0 0 10px;">Firebase isn't configured yet</h1>
      <p style="font-size:13.5px;color:#6B6560;line-height:1.6;margin:0 0 4px;">${escapeForHtml(message)}</p>
      <p style="font-size:13.5px;color:#6B6560;line-height:1.6;margin:0;">Add your project credentials to <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:4px;">firebase-config.js</code>, then reload. Full steps are in <code style="background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:4px;">SETUP.md</code>.</p>
    </div>
  `;
  const target = targetSelector ? document.querySelector(targetSelector) : null;
  if (target) {
    target.innerHTML = html;
    target.style.display = 'flex';
    target.style.alignItems = 'center';
    target.style.justifyContent = 'center';
    target.style.minHeight = '100vh';
    target.style.padding = '24px';
    target.style.background = '#1E1B18';
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'firebase-config-fullscreen';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647; background: #1E1B18;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  `;
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function escapeForHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Displays a professional "Firebase isn't configured" notice instead
 * of letting the page break or show a raw console error.
 *
 * @param {string} message - human-readable detail (from a caught
 *   FirebaseConfigError, typically).
 * @param {object} [options]
 * @param {'banner'|'fullscreen'} [options.mode='banner'] - 'banner'
 *   for pages that stay partially usable without Firebase (the
 *   storefront); 'fullscreen' for pages that cannot function at all
 *   without it (the Admin Panel).
 * @param {string} [options.targetSelector] - for 'fullscreen' mode,
 *   a CSS selector for an existing element whose content should be
 *   replaced (e.g. the login screen container). If omitted or not
 *   found, a full-viewport overlay is injected instead.
 */
export function renderFirebaseConfigError(message, options = {}) {
  const { mode = 'banner', targetSelector = null } = options;
  const run = () => {
    if (mode === 'fullscreen') renderFullScreen(message, targetSelector);
    else renderBanner(message);
  };
  if (document.body) run();
  else document.addEventListener('DOMContentLoaded', run, { once: true });
}
