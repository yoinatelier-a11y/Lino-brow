import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getRecipients() {
  const { data } = await supabase
    .from("app_data")
    .select("value")
    .eq("key", "lb-line-recipients")
    .maybeSingle();
  return data ? data.value : [];
}

async function saveRecipients(v) {
  await supabase
    .from("app_data")
    .upsert({ key: "lb-line-recipients", value: v, updated_at: new Date().toISOString() });
}

async function lineReply(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

async function getProfile(userId) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-line-signature"];
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET || "")
    .update(rawBody)
    .digest("base64");

  if (!signature || signature !== expected) {
    res.status(401).send("invalid signature");
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    res.status(400).send("bad request");
    return;
  }

  const events = body.events || [];
  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const userId = event.source?.userId;
    if (!userId) continue;

    const recipients = await getRecipients();
    const already = recipients.find((r) => r.userId === userId);

    if (already) {
      if (event.replyToken) {
        await lineReply(event.replyToken, "すでに予約通知の登録が完了しています。");
      }
      continue;
    }

    const profile = await getProfile(userId);
    const name = profile?.displayName || "スタッフ";
    const updated = [
      ...recipients,
      { userId, name, registeredAt: new Date().toISOString() },
    ];
    await saveRecipients(updated);

    if (event.replyToken) {
      await lineReply(
        event.replyToken,
        `予約通知の登録が完了しました（${name}さん）。新しいご予約が入ると、こちらに自動でお知らせします。`
      );
    }
  }

  res.status(200).send("OK");
}