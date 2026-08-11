import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: true,
  },
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const booking = req.body || {};

    const { data } = await supabase
      .from("app_data")
      .select("value")
      .eq("key", "lb-line-recipients")
      .maybeSingle();
    const recipients = data ? data.value : [];

    if (!recipients || recipients.length === 0) {
      res.status(200).json({ sent: false, reason: "no recipients registered" });
      return;
    }

    const userIds = recipients.map((r) => r.userId);
    const text = [
      "【新しいご予約】",
      `区分: ${booking.type === "corporate" ? "法人" : "個人"}`,
      `お名前/企業名: ${booking.companyOrName || ""}`,
      `メニュー: ${booking.menuName || ""}`,
      `日時: ${booking.date || ""} ${booking.time || ""}〜`,
    ].join("\n");

    const lineRes = await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: userIds,
        messages: [{ type: "text", text }],
      }),
    });

    if (!lineRes.ok) {
      const errText = await lineRes.text();
      res.status(200).json({ sent: false, error: errText });
      return;
    }

    res.status(200).json({ sent: true, count: userIds.length });
  } catch (e) {
    res.status(200).json({ sent: false, error: String(e) });
  }
}