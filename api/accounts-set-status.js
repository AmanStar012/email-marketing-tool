const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { accountId, connected, lastError } = req.body || {};
    if (!accountId) return res.status(400).json({ success: false, error: "accountId is required" });

    const runtime = (await redisGet("accounts:runtime")) || {};
    runtime[String(accountId)] = {
      ...(runtime[String(accountId)] || {}),
      connected: connected !== false, // default true
      lastError: lastError || (connected === false ? "Disconnected" : "")
    };

    await redisSet("accounts:runtime", runtime);
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
