import { handleLineWebhook } from "./_lineWebhookCore.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  await handleLineWebhook({
    req,
    res,
    channelSecret: process.env.LINE_CORP_CHANNEL_SECRET,
    accessToken: process.env.LINE_CORP_CHANNEL_ACCESS_TOKEN,
    storageKey: "lb-line-recipients-corp",
    accountLabel: "yoin° Beauty",
  });
}