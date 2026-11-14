/**
 * Hermes Agent — Multi-Bot Cloudflare Worker Gateway
 * Supports:
 *   - 3 Input Telegram Bots: BOT_1 (/webhook/bot1), BOT_2 (/webhook/bot2), BOT_3 (/webhook/bot3)
 *   - 1 Fixed Main Bot:      MAIN_BOT (/webhook/main)
 *   - One-click Webhook registration: GET /setup-webhooks?key=<WEBHOOK_SECRET>
 *   - One-click Webhook removal:      GET /delete-webhooks?key=<WEBHOOK_SECRET>
 *   - Diagnostic status:              GET /status?key=<WEBHOOK_SECRET>
 */

const BOT_SLOTS = {
  main: {
    label: "MAIN_BOT",
    envKeys: [
      "TELEGRAM_MAIN_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "MAIN_BOT_TOKEN",
      "BOT_TOKEN",
    ],
  },
  bot1: {
    label: "BOT_1",
    envKeys: ["TELEGRAM_BOT_TOKEN_1", "BOT_1_TOKEN"],
  },
  bot2: {
    label: "BOT_2",
    envKeys: ["TELEGRAM_BOT_TOKEN_2", "BOT_2_TOKEN"],
  },
  bot3: {
    label: "BOT_3",
    envKeys: ["TELEGRAM_BOT_TOKEN_3", "BOT_3_TOKEN"],
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

function getWebhookSecret(env) {
  return String(
    env.WEBHOOK_SECRET ||
    env.TELEGRAM_WEBHOOK_SECRET ||
    env.SECRET ||
    env.KEY ||
    env.WEBHOOK_KEY ||
    env.SECRET_KEY ||
    env.TELEGRAM_SECRET ||
    ""
  ).trim();
}

function getGhPat(env) {
  return String(
    env.GITHUB_PAT ||
    env.GH_PAT ||
    env.GITHUB_TOKEN ||
    env.GH_TOKEN ||
    env.PAT ||
    ""
  ).trim();
}

function getRawAllowedChat(env) {
  return String(
    env.ALLOWED_CHAT_ID ||
    env.TELEGRAM_CHAT_ID ||
    env.CHAT_ID ||
    env.OWNER_CHAT_ID ||
    ""
  ).trim();
}

function isAllowedChat(env, chatId) {
  const rawAllowed = getRawAllowedChat(env);
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

    // 1. Health check & configuration status endpoint
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      const configuredSlots = Object.keys(BOT_SLOTS).filter((k) =>
        Boolean(getBotToken(env, k))
      );
      const rawAllowed = getRawAllowedChat(env);
      const ghPat = getGhPat(env);
      const webhookSecret = getWebhookSecret(env);

      return Response.json({
        ok: true,
        service: "hermes-telegram-gateway",
        target_repo: env.GITHUB_REPO || "alann5245-crypto/ctd-075",
        configured_bots: configuredSlots.map((k) => BOT_SLOTS[k].label),
        worker_variables_status: {
          main_bot_token: configuredSlots.includes("main"),
          webhook_secret: Boolean(webhookSecret),
          allowed_chat_id: rawAllowed ? "CONFIGURED" : "NOT_SET",
          github_pat: Boolean(ghPat) ? "CONFIGURED" : "NOT_SET",
        },
        endpoints: {
          main: "/webhook/main",
          bot1: "/webhook/bot1",
          bot2: "/webhook/bot2",
          bot3: "/webhook/bot3",
          setup: "/setup-webhooks?key=<WEBHOOK_SECRET>",
          status: "/status?key=<WEBHOOK_SECRET>",
        },
      });
    }

    // 2. Comprehensive Diagnostic Endpoint: GET /status?key=<WEBHOOK_SECRET>
    if (request.method === "GET" && path === "/status") {
      const expectedKey = getWebhookSecret(env);
      const rawProvided = String(
        url.searchParams.get("key") || url.searchParams.get("secret") || ""
      ).trim();
      const providedKey = decodeURIComponent(rawProvided);

      if (!expectedKey || (providedKey !== expectedKey && rawProvided !== expectedKey)) {
        return Response.json(
          {
            ok: false,
            error: "Unauthorized. Vui lòng cấu hình WEBHOOK_SECRET và truyền ?key=<WEBHOOK_SECRET>",
          },
          { status: 401 }
        );
      }

      const mainToken = getBotToken(env, "main");
      let tgWebhookInfo = null;
      if (mainToken) {
        try {
          const resp = await fetch(
            `https://api.telegram.org/bot${mainToken}/getWebhookInfo`
          );
          tgWebhookInfo = await resp.json();
        } catch (err) {
          tgWebhookInfo = { error: String(err) };
        }
      }

      const targetRepo = env.GITHUB_REPO || "alann5245-crypto/ctd-075";
      const ghPat = getGhPat(env);
      let githubPatTest = null;
      if (ghPat) {
        try {
          const resp = await fetch(`https://api.github.com/repos/${targetRepo}`, {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${ghPat}`,
              "User-Agent": "Hermes-Diagnostic-Worker",
            },
          });
          githubPatTest = {
            ok: resp.ok,
            status: resp.status,
            permissions: resp.ok
              ? (await resp.json()).permissions
              : await resp.text(),
          };
        } catch (err) {
          githubPatTest = { error: String(err) };
        }
      } else {
        githubPatTest = { ok: false, error: "GITHUB_PAT chưa được đặt trên Cloudflare Worker" };
      }

      return Response.json({
        ok: true,
        target_repo: targetRepo,
        variables: {
          has_main_bot_token: Boolean(mainToken),
          has_webhook_secret: Boolean(expectedKey),
          allowed_chat_configured: Boolean(getRawAllowedChat(env)),
          has_github_pat: Boolean(ghPat),
        },
        telegram_webhook_info: tgWebhookInfo,
        github_pat_test: githubPatTest,
      });
    }

    // 3. One-click setWebhook / deleteWebhook management endpoints
    if (
      request.method === "GET" &&
      (path === "/setup-webhooks" || path === "/delete-webhooks")
    ) {
      const expectedKey = getWebhookSecret(env);
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

    // 4. Incoming Telegram Webhook handler: POST /webhook/:slot
    if (request.method === "POST" && path.startsWith("/webhook")) {
      const expectedSecret = getWebhookSecret(env);
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

      const rawAllowed = getRawAllowedChat(env);
      if (!rawAllowed) {
        console.warn("[HERMES] ALLOWED_CHAT_ID not configured on Worker.");
        if (expectedSecret) {
          await notifyMainBot(
            env,
            msg.chat.id,
            `⚠️ *[Hermes Gateway - Cấu hình thiếu]*\n\nCloudflare Worker chưa được cấu hình biến \`ALLOWED_CHAT_ID\`.\n\n👉 **Chat ID của bạn là:** \`${msg.chat.id}\`\n\nHãy vào Cloudflare Dashboard ➔ Workers & Pages ➔ Settings ➔ Variables and Secrets, thêm biến \`ALLOWED_CHAT_ID\`.`
          );
          return new Response("Missing ALLOWED_CHAT_ID in Worker env", { status: 200 });
        }
        return new Response("Gateway not configured", { status: 503 });
      }

      if (!isAllowedChat(env, msg.chat.id)) {
        console.warn("[HERMES] Ignored unauthorized chat request.");
        return new Response("Ignored unauthorized chat_id", { status: 200 });
      }

      const text = String(msg.text || msg.caption || "").trim();
      if (!text) {
        return new Response("Ignored empty text", { status: 200 });
      }

      const targetRepo = env.GITHUB_REPO || "alann5245-crypto/ctd-075";
      const ghPat = getGhPat(env);
      if (!ghPat) {
        console.error("[HERMES] Missing GITHUB_PAT in Worker env");
        await notifyMainBot(
          env,
          msg.chat.id,
          `⚠️ *[Hermes Gateway - Thiếu GITHUB_PAT]*\n\nCloudflare Worker chưa có biến bí mật \`GITHUB_PAT\` để kích hoạt GitHub Actions.\n\nHãy tạo GitHub Personal Access Token (PAT) có quyền \`repo\` hoặc \`Contents: Read and write\` trên repo \`${targetRepo}\`, rồi thêm vào Cloudflare Worker Settings ➔ Variables and Secrets!`
        );
        return new Response("Missing GITHUB_PAT in Worker env", { status: 200 });
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
        const ghErrText = await ghResponse.text();
        console.error(`[HERMES] GitHub dispatch failed (${ghResponse.status}): ${ghErrText}`);
        await notifyMainBot(
          env,
          msg.chat.id,
          `⚠️ *[Hermes Gateway - Lỗi GitHub API]*\n\nKhông thể kích hoạt GitHub Actions (\`HTTP ${ghResponse.status}\`):\n\`${ghErrText.slice(0, 200)}\`\n\nVui lòng kiểm tra lại quyền hạn của \`GITHUB_PAT\` trên repo \`${targetRepo}\`.`
        );
        return new Response("GitHub dispatch failed", { status: 502 });
      }

      // Immediate acknowledgement on the matching Bot (BOT_1 for RSS commands/BOT_1, otherwise MAIN_BOT)
      const isRssCmd = /^\/(rss|news|feeds)\b/i.test(text);
      const ackSlot = slotParam === "bot1" || isRssCmd ? "bot1" : "main";
      const sourceNote =
        slotMeta.label !== "MAIN_BOT" && ackSlot === "main"
          ? ` (qua ${slotMeta.label})`
          : "";
      const ackMessage = `⚡ Đã nhận lệnh${sourceNote}. Hermes đang khởi động GitHub Actions (khoảng 15–30 giây) và sẽ phản hồi chi tiết tại đây.`;

      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(notifyBot(env, ackSlot, msg.chat.id, ackMessage));
      } else {
        await notifyBot(env, ackSlot, msg.chat.id, ackMessage);
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
  return notifyBot(env, "main", chatId, text);
}

async function notifyBot(env, preferredSlot, chatId, text) {
  const token = getBotToken(env, preferredSlot) || getBotToken(env, "main");
  if (!token) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // Retry without Markdown if parse mode error occurred
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
    }
  } catch {
    // Non-blocking
  }
}
