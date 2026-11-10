/**
 * Hermes Agent — Multi-Bot Cloudflare Worker Gateway
 * Supports:
 *   - 3 Input Telegram Bots: BOT_1 (/webhook/bot1), BOT_2 (/webhook/bot2), BOT_3 (/webhook/bot3)
 *   - 1 Fixed Main Bot:      MAIN_BOT (/webhook/main)
 *   - One-click Webhook registration: GET /setup-webhooks?key=<WEBHOOK_SECRET>
 *   - One-click Webhook removal:      GET /delete-webhooks?key=<WEBHOOK_SECRET>
 */

const BOT_SLOTS = {
  main: {
    label: "MAIN_BOT",
    envKeys: ["TELEGRAM_MAIN_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
  },
  bot1: {
    label: "BOT_1",
    envKeys: ["TELEGRAM_BOT_TOKEN_1"],
  },
  bot2: {
    label: "BOT_2",
    envKeys: ["TELEGRAM_BOT_TOKEN_2"],
  },
  bot3: {
    label: "BOT_3",
    envKeys: ["TELEGRAM_BOT_TOKEN_3"],
  },
};

function getBotToken(env, slotKey) {
  const slot = BOT_SLOTS[slotKey];
  if (!slot) return "";
  for (const key of slot.envKeys) {
    if (env[key] && String(env[key]).trim()) {
      return String(env[key]).trim();
    }
  }
  return "";
}

function isAllowedChat(env, chatId) {
  const rawAllowed = String(env.ALLOWED_CHAT_ID || env.TELEGRAM_CHAT_ID || "").trim();
  if (!rawAllowed) return false;
  const allowedSet = new Set(
    rawAllowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return allowedSet.has(String(chatId).trim());
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 1. Health check endpoint
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      const configuredSlots = Object.keys(BOT_SLOTS).filter((k) =>
        Boolean(getBotToken(env, k))
      );
      return Response.json({
        ok: true,
        service: "hermes-telegram-gateway",
        target_repo: env.GITHUB_REPO || "alann5245-crypto/ctd-075",
        configured_bots: configuredSlots.map((k) => BOT_SLOTS[k].label),
        endpoints: {
          main: "/webhook/main",
          bot1: "/webhook/bot1",
          bot2: "/webhook/bot2",
          bot3: "/webhook/bot3",
          setup: "/setup-webhooks?key=<WEBHOOK_SECRET>",
        },
      });
    }

    // 2. One-click setWebhook / deleteWebhook management endpoints
    if (
      request.method === "GET" &&
      (path === "/setup-webhooks" || path === "/delete-webhooks")
    ) {
      const expectedKey = String(
        env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || ""
      ).trim();
      const rawProvided = String(
        url.searchParams.get("key") || url.searchParams.get("secret") || ""
      ).trim();
      const providedKey = decodeURIComponent(rawProvided);

      if (!expectedKey) {
        return Response.json(
          {
            ok: false,
            error:
              "Biến WEBHOOK_SECRET chưa được cài trong Worker Settings -> Variables and Secrets. Hãy tạo biến này trên Cloudflare trước.",
          },
          { status: 400 }
        );
      }

      if (providedKey !== expectedKey && rawProvided !== expectedKey) {
        return Response.json(
          {
            ok: false,
            error:
              "Mật khẩu key không khớp với WEBHOOK_SECRET trên Cloudflare Worker. Hãy kiểm tra lại giá trị đã nhập.",
            hint: `Độ dài key bạn gửi: ${rawProvided.length}, độ dài secret trên Cloudflare: ${expectedKey.length}`,
          },
          { status: 401 }
        );
      }

      const results = {};
      const origin = url.origin;
      const isSetup = path === "/setup-webhooks";
      // Auto-sanitize for Telegram requirement: A-Z, a-z, 0-9, _ and -
      const tgSecretToken = expectedKey.replace(/[^a-zA-Z0-9_-]/g, "_") || "hermes_secret";

      for (const [slotKey, slotMeta] of Object.entries(BOT_SLOTS)) {
        const token = getBotToken(env, slotKey);
        if (!token) {
          results[slotMeta.label] = "SKIPPED (token not configured)";
          continue;
        }

        const tgUrl = isSetup
          ? `https://api.telegram.org/bot${token}/setWebhook`
          : `https://api.telegram.org/bot${token}/deleteWebhook`;

        const bodyPayload = isSetup
          ? {
              url: `${origin}/webhook/${slotKey}`,
              secret_token: tgSecretToken,
              allowed_updates: ["message", "edited_message"],
              drop_pending_updates: false,
            }
          : { drop_pending_updates: false };

        try {
          const resp = await fetch(tgUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyPayload),
          });
          const data = await resp.json();
          results[slotMeta.label] = {
            webhook_url: isSetup ? `${origin}/webhook/${slotKey}` : null,
            telegram_response: data,
          };
        } catch (err) {
          results[slotMeta.label] = { error: String(err) };
        }
      }

      return Response.json({
        ok: true,
        action: isSetup ? "setWebhook" : "deleteWebhook",
        results,
      });
    }

    // 3. Incoming Telegram Webhook handler: POST /webhook/:slot
    if (request.method === "POST" && path.startsWith("/webhook")) {
      const expectedSecret = String(
        env.WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || ""
      ).trim();
      if (expectedSecret) {
        const headerSecret = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        ) || "";
        const tgSecretToken = expectedSecret.replace(/[^a-zA-Z0-9_-]/g, "_") || "hermes_secret";
        if (headerSecret !== expectedSecret && headerSecret !== tgSecretToken) {
          return new Response("Unauthorized webhook secret", { status: 401 });
        }
      }

      const segments = path.split("/").filter(Boolean);
      const slotParam = (
        segments[1] ||
        url.searchParams.get("bot") ||
        "main"
      ).toLowerCase();
      const slotMeta = BOT_SLOTS[slotParam] || {
        label: slotParam.toUpperCase(),
      };

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;
      if (!msg || !msg.chat) {
        return new Response("Ignored non-message update", { status: 200 });
      }

      if (!isAllowedChat(env, msg.chat.id)) {
        return new Response("Ignored unauthorized chat_id", { status: 200 });
      }

      const text = String(msg.text || msg.caption || "").trim();
      if (!text) {
        return new Response("Ignored empty text", { status: 200 });
      }

      const targetRepo = env.GITHUB_REPO || "alann5245-crypto/ctd-075";
      const ghPat = String(env.GITHUB_PAT || "").trim();
      if (!ghPat) {
        return new Response("Missing GITHUB_PAT in Worker env", { status: 500 });
      }

      const ghResponse = await fetch(
        `https://api.github.com/repos/${targetRepo}/dispatches`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${ghPat}`,
            "User-Agent": "Hermes-MultiBot-Cloudflare-Worker",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: "telegram_webhook",
            client_payload: {
              bot_label: slotMeta.label,
              bot_slot: slotParam,
              update_id: update.update_id,
              message_id: msg.message_id,
              timestamp: msg.date || Math.floor(Date.now() / 1000),
              prompt: text,
            },
          }),
        }
      );

      if (!ghResponse.ok) {
        return new Response("GitHub dispatch failed", { status: 502 });
      }

      // Immediate acknowledgement on the Fixed Main Bot so the phone shows status within ~1s
      if (ctx && typeof ctx.waitUntil === "function") {
        const sourceNote = slotMeta.label !== "MAIN_BOT" ? ` (qua ${slotMeta.label})` : "";
        ctx.waitUntil(
          notifyMainBot(
            env,
            msg.chat.id,
            `⚡ Đã nhận lệnh${sourceNote}. Hermes đang khởi động GitHub Actions (khoảng 15–30 giây) và sẽ phản hồi chi tiết tại đây.`
          )
        );
      }

      return Response.json({
        ok: true,
        dispatched_to: targetRepo,
        bot_label: slotMeta.label,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function notifyMainBot(env, chatId, text) {
  const mainToken = getBotToken(env, "main");
  if (!mainToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${mainToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Non-blocking courtesy notification
  }
}

