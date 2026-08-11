import liff from "@line/liff";

// Set these in Vercel's Environment Variables after creating each LIFF app.
const LIFF_IDS = {
  general: import.meta.env.VITE_LIFF_ID_GENERAL || "",
  corp: import.meta.env.VITE_LIFF_ID_CORP || "",
};

/**
 * Determines which account this page was opened for, based on a `?account=corp`
 * (or `?account=general`) query parameter. The two rich menus / LIFF endpoint
 * URLs should each include this parameter. Defaults to "general".
 */
export function getSourceAccount() {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("account");
    return v === "corp" ? "corp" : "general";
  } catch (e) {
    return "general";
  }
}

let initPromise = null;

export function initLiff(account) {
  const liffId = LIFF_IDS[account] || LIFF_IDS.general;
  if (!liffId) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = liff
      .init({ liffId })
      .then(() => true)
      .catch((e) => {
        console.error("LIFF init failed", e);
        return false;
      });
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

export function liffLogin() {
  try {
    liff.login({ redirectUri: window.location.href });
  } catch (e) {}
}

export { liff };