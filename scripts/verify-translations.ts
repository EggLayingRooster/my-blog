import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The localization messages are located in 'messages' directory
const messagesDir = path.resolve(__dirname, "../messages");
const zhPath = path.join(messagesDir, "zh.json");
const enPath = path.join(messagesDir, "en.json");

type Messages = Record<string, string>;

function getPlaceholders(message: unknown): string {
  // 部分消息可能是复数/对象形式，占位符检查只针对普通字符串
  if (typeof message !== "string") return "";
  const matches = [...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(
    (match) => match[1],
  );
  return [...new Set(matches)].sort().join(",");
}

try {
  const zhContent = JSON.parse(fs.readFileSync(zhPath, "utf8")) as Messages;
  const enContent = JSON.parse(fs.readFileSync(enPath, "utf8")) as Messages;

  // Get keys from source language file, excluding the schema property
  const zhKeys = Object.keys(zhContent).filter((k) => k !== "$schema");
  const enKeys = Object.keys(enContent).filter((k) => k !== "$schema");

  const problems: Array<string> = [];

  // 1. zh -> en 缺失
  const missingKeys = zhKeys.filter((key) => !(key in enContent));
  if (missingKeys.length > 0) {
    problems.push(
      `en.json 缺少 ${missingKeys.length} 个键：\n${missingKeys
        .map((key) => `  - ${key}`)
        .join("\n")}`,
    );
  }

  // 2. en 多余（可能是拼写错误/残留键）
  const extraKeys = enKeys.filter((key) => !(key in zhContent));
  if (extraKeys.length > 0) {
    problems.push(
      `en.json 存在 ${extraKeys.length} 个 zh.json 没有的键：\n${extraKeys
        .map((key) => `  - ${key}`)
        .join("\n")}`,
    );
  }

  // 3. 占位符一致性（例如 {name} / {count} 参数不匹配会导致运行时错误）
  const placeholderMismatches: Array<string> = [];
  for (const key of zhKeys) {
    if (!(key in enContent)) continue;
    const zhPlaceholders = getPlaceholders(zhContent[key] ?? "");
    const enPlaceholders = getPlaceholders(enContent[key] ?? "");
    if (zhPlaceholders !== enPlaceholders) {
      placeholderMismatches.push(
        `  - ${key}: zh[{${zhPlaceholders}}] vs en[{${enPlaceholders}}]`,
      );
    }
  }
  if (placeholderMismatches.length > 0) {
    problems.push(
      `占位符不一致（${placeholderMismatches.length} 个）：\n${placeholderMismatches.join("\n")}`,
    );
  }

  // 4. 空值检查
  const emptyZhKeys = zhKeys.filter((key) => !String(zhContent[key] ?? "").trim());
  if (emptyZhKeys.length > 0) {
    problems.push(
      `zh.json 存在空翻译（${emptyZhKeys.length} 个）：\n${emptyZhKeys
        .map((key) => `  - ${key}`)
        .join("\n")}`,
    );
  }

  if (problems.length > 0) {
    console.error("❌ Translation verification failed:\n");
    problems.forEach((problem) => console.error(problem + "\n"));
    process.exit(1);
  }

  console.log(
    `✅ Translation verification passed (${zhKeys.length} keys, placeholders consistent).`,
  );
  process.exit(0);
} catch (error) {
  console.error("❌ Error verifying translations:", error);
  process.exit(1);
}
