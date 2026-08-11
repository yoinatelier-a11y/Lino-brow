import { createClient } from "@supabase/supabase-js";

// Publishable key is safe to expose client-side (RLS policy controls access).
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://whhvzobsysfaeqaclfjp.supabase.co";
const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_cD5Vl51gszAuvWVQ5-jPfA_MJx9_Qri";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---- generic key/value storage helpers backed by the `app_data` table ---- */
export async function storageGet(key) {
  const { data, error } = await supabase
    .from("app_data")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error("storageGet error", key, error);
    return null;
  }
  return data ? data.value : null;
}

export async function storageSet(key, value) {
  const { error } = await supabase
    .from("app_data")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) console.error("storageSet error", key, error);
}
