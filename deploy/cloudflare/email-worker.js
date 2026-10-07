/**
 * Cloudflare Email Routing Worker for Heurion Platform
 * 
 * 作用：拦截所有发往 *@heurion.org 的外部来信，以 Webhook 形式自动推送到 Heurion 生产服务器。
 * Heurion 平台收到后自动执行「方案 3」：
 * 1. 精准存入对应医生的 Heurion 站内【📥 收件箱】
 * 2. 若医生绑定了个人外部邮箱（如 Gmail/医院邮箱），自动将副本实时转交至其个人邮箱
 * 
 * 部署指引：
 * 1. 登录 Cloudflare 控制台 -> Workers & Pages -> Create Worker
 * 2. 将本文件代码粘贴入 Worker 编辑器中并保存部署（例如名称: heurion-inbound-mail）
 * 3. 在 Worker 的 Settings -> Variables 中添加环境变量：
 *    - HEURION_INBOUND_URL: https://heurion.org/api/mail/inbound
 *    - MAIL_INBOUND_SECRET: 你的安全通信密钥（与 Heurion 服务器 .env 中的 MAIL_INBOUND_SECRET 一致）
 * 4. 进入 Cloudflare 控制台 -> 域名 heurion.org -> Email Routing -> Routing Rules：
 *    - 添加 Catch-all 规则：Catch-all address -> Send to a Worker -> 选择本 Worker (heurion-inbound-mail)
 */

export default {
  async fetch(request, env, ctx) {
    return new Response("Heurion Inbound Email Worker is active", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject") || "(无主题)";
    
    // 读取原始邮件正文
    let rawText = "";
    try {
      rawText = await new Response(message.raw).text();
    } catch (err) {
      console.error("读取邮件流失败:", err);
    }

    // 简单解析出文本正文（去除 MIME 头）
    let cleanBody = rawText;
    const boundaryMatch = rawText.match(/boundary="?([^"\r\n]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = rawText.split(`--${boundary}`);
      for (const part of parts) {
        if (part.includes("Content-Type: text/plain")) {
          const bodySplit = part.split(/\r?\n\r?\n/);
          if (bodySplit.length > 1) {
            cleanBody = bodySplit.slice(1).join("\n\n").trim();
            break;
          }
        }
      }
    } else {
      // 非 multipart 纯文本邮件：头部与正文以双换行分隔
      const headerBodySplit = rawText.split(/\r?\n\r?\n/);
      if (headerBodySplit.length > 1) {
        cleanBody = headerBodySplit.slice(1).join("\n\n").trim();
      }
    }

    const payload = {
      from,
      to,
      subject,
      body: cleanBody || rawText || "(无正文内容)",
    };

    const targetUrl = env.HEURION_INBOUND_URL || "https://heurion.org/api/mail/inbound";
    const secret = env.MAIL_INBOUND_SECRET || "";

    const headers = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers["X-Inbound-Secret"] = secret;
    }

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error(`Heurion 接收端返回错误 ${res.status}: ${errText}`);
      } else {
        console.log(`[Heurion Email Routing] 邮件成功投递至平台: from=${from} to=${to} subject=${subject}`);
      }
    } catch (err) {
      console.error("请求 Heurion Webhook 接口失败:", err);
    }
  },
};
