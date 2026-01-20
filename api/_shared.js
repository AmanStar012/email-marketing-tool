const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { createClient } = require("redis");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-auto-secret");
}

// Sleep function
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load accounts from file
function loadAccountsConfig() {
  const filePath = path.join(process.cwd(), "accounts.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("accounts.json file not found in project root");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let accounts;
  try {
    accounts = JSON.parse(raw);
  } catch {
    throw new Error("accounts.json is not valid JSON");
  }

  if (!Array.isArray(accounts)) {
    throw new Error("accounts.json must be an array");
  }

  return accounts.map((a) => {
    const id = a.id;
    const email = (a.email || "").trim();
    const senderName = (a.senderName || "").trim();
    const passFromFile = String(a.pass || a.password || "").trim();
    const passFromEnv = String(process.env[`PASS_${id}`] || "").trim();

    return {
      ...a,
      id,
      email,
      senderName,
      pass: passFromFile || passFromEnv
    };
  });
}

// Merge helper
function applyMerge(text, vars = {}) {
  if (!text || typeof text !== "string") return "";
  let out = text;

  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, v == null ? "" : String(v));
  }

  return out.replace(/{{[^}]*}}/g, "");
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Convert text to HTML
function convertTextToHTML(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r?\n/g, "<br>")
    .replace(/  +/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(
      /^/,
      '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color: #333;">'
    )
    .replace(/$/, "</div>");
}

// Nodemailer transporter
function createTransporter(account) {
  const user = (account.email || "").trim();
  const pass = (account.pass || "").trim();

  if (!user || !pass) {
    throw new Error(`Missing email/pass for account id=${account.id}`);
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });
}

// 🔴 THIS WAS MISSING — ROOT CAUSE FIX
function looksLikeAccountLevelFailure(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();

  return (
    msg.includes("invalid login") ||
    msg.includes("authentication failed") ||
    msg.includes("bad credentials") ||
    msg.includes("username and password not accepted") ||
    msg.includes("account disabled") ||
    msg.includes("not authorized") ||
    msg.includes("smtp authentication") ||
    msg.includes("login not allowed")
  );
}

// Redis
let _redisClient = null;
let _redisConnecting = null;

async function getRedisClient() {
  if (_redisClient) return _redisClient;
  if (_redisConnecting) {
    await _redisConnecting;
    return _redisClient;
  }

  const url = process.env.REDIS_URL;
  if (!url) throw new Error("Missing REDIS_URL env var");

  _redisClient = createClient({ url });

  _redisConnecting = _redisClient.connect().catch((e) => {
    _redisClient = null;
    _redisConnecting = null;
    throw e;
  });

  await _redisConnecting;
  _redisConnecting = null;
  return _redisClient;
}

async function redisGet(key) {
  const client = await getRedisClient();
  const raw = await client.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function redisSet(key, value) {
  const client = await getRedisClient();
  const v = typeof value === "string" ? value : JSON.stringify(value);
  await client.set(key, v);
}

async function redisDel(key) {
  const client = await getRedisClient();
  await client.del(key);
}

module.exports = {
  cors,
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge,
  loadAccountsConfig,
  redisGet,
  redisSet,
  redisDel
};
