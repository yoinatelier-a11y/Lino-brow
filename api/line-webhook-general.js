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
    channelSecret: process.env.LINE_GENERAL_CHANNEL_SECRET,
    accessToken: process.env.LINE_GENERAL_CHANNEL_ACCESS_TOKEN,
    storageKey: "lb-line-recipients-general",
    accountLabel: "LINO BROW",
  });
}
