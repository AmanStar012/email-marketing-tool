const fs = require("fs");
const path = require("path");
const Redis = require("ioredis");

// Load .env.local only when running locally
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

/**
 * ---------- CORS ----------
 */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AUTO-SECRET");
}

/**
 * ---------- ACCOUNTS ----------
 * accounts.json in project root:
 * [
 *   { "id": 1, "email": "...", "senderName": "..." },
 *   ...
 * ]
 *
 * Passwords must be in env: PASS_1, PASS_2, ...
 */
function loadAccountsConfig() {
  const filePath = path.join(process.cwd(), "accounts.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("accounts.json file not found in project root");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const accounts = JSON.parse(raw);

  if (!Array.isArray(accounts)) {
    throw new Error("accounts.json must be an array");
  }

  return accounts.map((a) => ({
    ...a,
    pass: process.env[`PASS_${a.id}`] || ""
  }));
}

/**
 * ---------- REDIS (ioredis) ----------
 */
let _redis = null;

function getRedis() {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("Missing REDIS_URL environment variable");
  }

  _redis = new Redis(url, {
    // Safe defaults for serverless
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true
  });

  _redis.on("error", () => {
    // don't crash serverless; errors will surface on command
  });

  return _redis;
}

async function redisGet(key) {
  const r = getRedis();
  const v = await r.get(key);
  if (v == null) return null;

  // try json
  if (typeof v === "string" && (v.startsWith("{") || v.startsWith("[") || v === "null")) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

async function redisSet(key, value) {
  const r = getRedis();
  if (value === undefined) value = null;

  // store objects/arrays as json
  if (typeof value === "object") {
    return r.set(key, JSON.stringify(value));
  }
  return r.set(key, String(value));
}

async function redisDel(key) {
  const r = getRedis();
  return r.del(key);
}

/**
 * ---------- HELPERS ----------
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function convertTextToHTML(text) {
  if (!text) return "";
  return text
    .replace(/\r?\n/g, "<br>")
    .replace(/  +/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(
      /^/,
      '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color: #333;">'
    )
    .replace(/$/, "</div>");
}

function applyMerge(templateStr, vars) {
  if (!templateStr || typeof templateStr !== "string") return templateStr;
  let out = templateStr;
  Object.keys(vars || {}).forEach((k) => {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, vars[k] || "");
  });
  out = out.replace(/{{[^}]*}}/g, "");
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeAccountLevelFailure(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  // Most common account-level problems:
  // - auth / password / invalid login
  // - disabled account / blocked by google
  // - too many login attempts / rate-limited / daily limit exceeded
  return (
    msg.includes("invalid login") ||
    msg.includes("authentication") ||
    msg.includes("username and password not accepted") ||
    msg.includes("bad credentials") ||
    msg.includes("application-specific password") ||
    msg.includes("daily user sending quota exceeded") ||
    msg.includes("rate limit") ||
    msg.includes("too many") ||
    msg.includes("account has been blocked") ||
    msg.includes("login not permitted") ||
    msg.includes("534-5.7.9") ||
    msg.includes("535-5.7.8")
  );
}

function createTransporter(account) {
  const nodemailer = require("nodemailer");
  if (!account?.email || !account?.pass) {
    throw new Error(`Missing email/pass for account id=${account?.id}`);
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: account.email,
      pass: account.pass
    }
  });
}

module.exports = {
  cors,
  loadAccountsConfig,

  // redis wrappers
  redisGet,
  redisSet,
  redisDel,

  // mail helpers
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge
};
