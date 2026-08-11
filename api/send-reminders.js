import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: true,
  },
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ACCOUNTS = {
  general: { accessToken: process.env.LINE_GENERAL_CHANNEL_ACCESS_TOKEN },
  corp: { accessToken: process.env.LINE_CORP_CHANNEL_ACCESS_TOKEN },
};

// Vercel Cron runs in UTC. Compute "tomorrow" as a JST calendar date.
function getTomorrowJST() {
  const now = new Date();
  const jstShifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jstShifted.setUTCDate(jstShifted.getUTCDate() + 1);
  return jstShifted.toISOString().slice(0, 10);
}

function reminderText(booking) {
  return [
    "【ご予約リマインド】🌿",
    "明日はご来店予定です。お会いできるのを楽しみにしております✨",
    "",
    `メニュー: ${booking.menuName || ""}`,
    `日時: ${booking.date || ""} ${booking.time || ""}〜`,
    "",
    "お気をつけてお越しくださいませ😊",
  ].join("\n");
}

async function push(accessToken, userId, text) {
  if (!accessToken || !userId) return false;
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  // Optional protection: if CRON_SECRET is set in env, require a matching Authorization header.
  // Vercel automatically sends this header for scheduled Cron invocations when CRON_SECRET is set.
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).send("unauthorized");
      return;
    }
  }

  try {
    const { data } = await supabase
      .from("app_data")
      .select("value")
      .eq("key", "lb-bookings")
      .maybeSingle();
    const bookings = data ? data.value : [];

    const tomorrow = getTomorrowJST();
    const targets = bookings.filter(
      (b) => b.date === tomorrow && b.status !== "cancelled" && b.lineUserId
    );

    let sent = 0;
    for (const b of targets) {
      const accountKey = b.sourceAccount === "corp" ? "corp" : "general";
      const ok = await push(ACCOUNTS[accountKey]?.accessToken, b.lineUserId, reminderText(b));
      if (ok) sent++;
    }

    res.status(200).json({ date: tomorrow, checked: bookings.length, targets: targets.length, sent });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}