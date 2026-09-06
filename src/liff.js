import liff from "@line/liff";

// Set these in Vercel's Environment Variables after creating each LIFF app.
const LIFF_IDS = {
  general: import.meta.env.VITE_LIFF_ID_GENERAL || "",
  corp: import.meta.env.VITE_LIFF_ID_CORP || "",
};

/**
 * Determines which account this page load belongs to. Prefers the `?account=`
 * URL query param (set on the two rich-menu / LIFF endpoint URLs). LINE's
 * login redirect strips custom query params from the return URL, so we also
 * fall back to a value saved in sessionStorage right before starting login.
 */
export function getSourceAccount() {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("account");
    if (v === "corp" || v === "general") return v;
    const saved = sessionStorage.getItem("lb-pending-account");
    if (saved === "corp" || saved === "general") return saved;
  } catch (e) {}
  return "general";
}

export function rememberAccountForLogin(account) {
  try {
    sessionStorage.setItem("lb-pending-account", account);
  } catch (e) {}
}

let initPromise = null;

/**
 * Returns { ok: true } on success, or { ok: false, reason } on failure —
 * including the case where the LIFF ID env var itself is missing, so this
 * is visible for debugging instead of silently doing nothing.
 */
export function initLiff(account) {
  const liffId = LIFF_IDS[account] || LIFF_IDS.general;
  if (!liffId) {
    return Promise.resolve({
      ok: false,
      reason: `LIFF IDが未設定です（account=${account}）。VercelのVITE_LIFF_ID_${account.toUpperCase()}を確認してください。`,
    });
  }
  if (!initPromise) {
    initPromise = liff
      .init({ liffId })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
  }
  return initPromise;
}

export function isLiffLoggedIn() {
  try {
    return liff.isLoggedIn();
  } catch (e) {
    return false;
  }
}

export async function getLiffProfile() {
  try {
    if (!liff.isLoggedIn()) return null;
    return await liff.getProfile(); // { userId, displayName, pictureUrl }
  } catch (e) {
    return null;
  }
}

export function liffLogin(account) {
  try {
    if (account) rememberAccountForLogin(account);
    liff.login({ redirectUri: window.location.href });
  } catch (e) {}
}

export { liff };