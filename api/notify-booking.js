import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: true,
  },
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ACCOUNTS = {
  general: {
    accessToken: process.env.LINE_GENERAL_CHANNEL_ACCESS_TOKEN,
    recipientsKey: "lb-line-recipients-general",
    label: "LINO BROW",
  },
  corp: {
    accessToken: process.env.LINE_CORP_CHANNEL_ACCESS_TOKEN,
    recipientsKey: "lb-line-recipients-corp",
    label: "yoin° Beauty",
  },
};

async function getRecipients(storageKey) {
  const { data } = await supabase
    .from("app_data")
    .select("value")
    .eq("key", storageKey)
    .maybeSingle();
  return data ? data.value : [];
}

function bookingText(booking) {
  return [
    "【新しいご予約】",
    `区分: ${booking.type === "corporate" ? "法人" : "一般"}`,
    `お名前/企業名: ${booking.companyOrName || ""}`,
    `メニュー: ${booking.menuName || ""}`,
    `日時: ${booking.date || ""} ${booking.time || ""}〜`,
  ].join("\n");
}

async function multicast(accessToken, userIds, text) {
  if (!accessToken || !userIds || userIds.length === 0) return { sent: false };
  const r = await fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to: userIds, messages: [{ type: "text", text }] }),
  });
  if (!r.ok) return { sent: false, error: await r.text() };
  return { sent: true, count: userIds.length };
}

async function push(accessToken, userId, text) {
  if (!accessToken || !userId) return { sent: false };
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!r.ok) return { sent: false, error: await r.text() };
  return { sent: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const booking = req.body || {};

    // staff notification: routed by booking type (法人 -> yoin° Beauty staff, 一般 -> LINO BROW staff)
    const staffAccountKey = booking.type === "corporate" ? "corp" : "general";
    const staffAccount = ACCOUNTS[staffAccountKey];
    const staffRecipients = await getRecipients(staffAccount.recipientsKey);
    const staffResult = await multicast(
      staffAccount.accessToken,
      staffRecipients.map((r) => r.userId),
      bookingText(booking)
    );

    // customer notification: routed by which account's LIFF the customer opened the app from
    let customerResult = { sent: false, reason: "no lineUserId" };
    if (booking.lineUserId) {
      const sourceAccountKey = booking.sourceAccount === "corp" ? "corp" : "general";
      const sourceAccount = ACCOUNTS[sourceAccountKey];
      const confirmText = [
        "ご予約ありがとうございます。",
        `メニュー: ${booking.menuName || ""}`,
        `日時: ${booking.date || ""} ${booking.time || ""}〜`,
        "変更・キャンセルは公式LINEメッセージにてご連絡ください。",
        "",
        "access：https://maps.app.goo.gl/yCmZqqav4Eh1YJcy6?g_st=ipc",
        "【602号室】",
      ].join("\n");
      customerResult = await push(sourceAccount.accessToken, booking.lineUserId, confirmText);
    }

    res.status(200).json({ staff: staffResult, customer: customerResult });
  } catch (e) {
    res.status(200).json({ sent: false, error: String(e) });
  }
}