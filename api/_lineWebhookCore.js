import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function getRecipients(storageKey) {
  const { data } = await supabase
    .from("app_data")
    .select("value")
    .eq("key", storageKey)
    .maybeSingle();
  return data ? data.value : [];
}

async function saveRecipients(storageKey, v) {
  await supabase
    .from("app_data")
    .upsert({ key: storageKey, value: v, updated_at: new Date().toISOString() });
}

async function lineReply(accessToken, replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

async function getProfile(accessToken, userId) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/**
 * Handles a LINE webhook request for one specific official account.
 * @param {object} opts
 * @param {import('http').IncomingMessage} opts.req
 * @param {import('http').ServerResponse} opts.res
 * @param {string} opts.channelSecret
 * @param {string} opts.accessToken
 * @param {string} opts.storageKey  e.g. "lb-line-recipients-general"
 * @param {string} opts.accountLabel  e.g. "LINO BROW" for reply text
 */
export async function handleLineWebhook({ req, res, channelSecret, accessToken, storageKey, accountLabel }) {
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-line-signature"];
  const expected = crypto.createHmac("sha256", channelSecret || "").update(rawBody).digest("base64");

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

    const recipients = await getRecipients(storageKey);
    const already = recipients.find((r) => r.userId === userId);

    if (already) {
      if (event.replyToken) {
        await lineReply(accessToken, event.replyToken, "すでに予約通知の登録が完了しています。");
      }
      continue;
    }

    const profile = await getProfile(accessToken, userId);
    const name = profile?.displayName || "スタッフ";
    const updated = [...recipients, { userId, name, registeredAt: new Date().toISOString() }];
    await saveRecipients(storageKey, updated);

    if (event.replyToken) {
      await lineReply(
        accessToken,
        event.replyToken,
        `【${accountLabel}】予約通知の登録が完了しました（${name}さん）。新しいご予約が入ると、こちらに自動でお知らせします。`
      );
    }
  }

  res.status(200).send("OK");
}