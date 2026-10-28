import fs from "node:fs";
import path from "node:path";

/**
 * 校验仓库中已提交的 wrangler.jsonc 与 wrangler.example.jsonc 的绑定声明一致，
 * 并确认 worker-configuration.d.ts 包含所有运行时绑定名。
 *
 * 背景：CI 会用 example 覆盖 wrangler.jsonc 后跑测试，而部署使用仓库里已提交的
 * wrangler.jsonc。如果两边 binding 漂移，CI 会通过但线上可能缺 binding。
 */

const cwd = process.cwd();
const realConfigPath = path.join(cwd, "wrangler.jsonc");
const exampleConfigPath = path.join(cwd, "wrangler.example.jsonc");
const envTypesPath = path.join(cwd, "worker-configuration.d.ts");

function stripJsonc(input: string): string {
  let output = "";
  let index = 0;
  let inString = false;

  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  // 去掉尾随逗号
  return output.replace(/,(\s*[}\]])/g, "$1");
}

type JsonObject = Record<string, unknown>;

function asArray(value: unknown): Array<JsonObject> {
  return Array.isArray(value) ? (value as Array<JsonObject>) : [];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

export function extractBindingSignatures(config: JsonObject): Array<string> {
  const signatures: Array<string> = [];

  for (const entry of asArray(config.d1_databases)) {
    if (entry.binding) signatures.push(`d1:${String(entry.binding)}`);
  }
  for (const entry of asArray(config.kv_namespaces)) {
    if (entry.binding) signatures.push(`kv:${String(entry.binding)}`);
  }
  for (const entry of asArray(config.r2_buckets)) {
    if (entry.binding) signatures.push(`r2:${String(entry.binding)}`);
  }
  const queues = asObject(config.queues);
  for (const entry of asArray(queues.producers)) {
    if (entry.binding) signatures.push(`queue-producer:${String(entry.binding)}`);
    if (entry.queue) signatures.push(`queue-name:${String(entry.queue)}`);
  }
  for (const entry of asArray(queues.consumers)) {
    if (entry.queue) signatures.push(`queue-consumer:${String(entry.queue)}`);
  }
  for (const entry of asArray(config.workflows)) {
    if (entry.binding) signatures.push(`workflow:${String(entry.binding)}`);
    if (entry.name) signatures.push(`workflow-name:${String(entry.name)}`);
  }
  for (const entry of asArray(asObject(config.durable_objects).bindings)) {
    if (entry.name) signatures.push(`do:${String(entry.name)}`);
  }
  const ai = asObject(config.ai);
  if (ai.binding) signatures.push(`ai:${String(ai.binding)}`);
  for (const entry of asArray(config.vectorize)) {
    if (entry.binding) signatures.push(`vectorize:${String(entry.binding)}`);
  }
  for (const entry of asArray(config.services)) {
    if (entry.binding) signatures.push(`service:${String(entry.binding)}`);
  }
  for (const entry of asArray(config.hyperdrive)) {
    if (entry.binding) signatures.push(`hyperdrive:${String(entry.binding)}`);
  }

  signatures.push(`main:${String(config.main ?? "")}`);
  signatures.push(`compat-date:${String(config.compatibility_date ?? "")}`);

  return [...new Set(signatures)].sort();
}

function readConfig(filePath: string): JsonObject {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonc(content)) as JsonObject;
}

function checkEnvTypes(bindings: Array<string>): Array<string> {
  const types = fs.readFileSync(envTypesPath, "utf8");
  const problems: Array<string> = [];

  const bindingPrefixes = [
    "d1:",
    "kv:",
    "r2:",
    "queue-producer:",
    "workflow:",
    "do:",
    "ai:",
    "vectorize:",
    "service:",
    "hyperdrive:",
  ];

  for (const signature of bindings) {
    if (!bindingPrefixes.some((prefix) => signature.startsWith(prefix))) {
      continue;
    }
    const [, name] = signature.split(":");
    if (!name) continue;
    if (!types.includes(`${name}:`)) {
      problems.push(`worker-configuration.d.ts 缺少绑定类型: ${name}`);
    }
  }

  return problems;
}

function main() {
  const realConfig = readConfig(realConfigPath);
  const exampleConfig = readConfig(exampleConfigPath);

  const realBindings = extractBindingSignatures(realConfig);
  const exampleBindings = extractBindingSignatures(exampleConfig);

  const missingInReal = exampleBindings.filter(
    (binding) => !realBindings.includes(binding),
  );
  const extraInReal = realBindings.filter(
    (binding) => !exampleBindings.includes(binding),
  );

  const problems: Array<string> = [];
  if (missingInReal.length > 0) {
    problems.push(
      `wrangler.jsonc 缺少 example 中的绑定，部署会缺 binding：\n${missingInReal
        .map((binding) => `  - ${binding}`)
        .join("\n")}`,
    );
  }
  if (extraInReal.length > 0) {
    problems.push(
      `wrangler.jsonc 存在 example 没有的绑定（请同步回 example）：\n${extraInReal
        .map((binding) => `  - ${binding}`)
        .join("\n")}`,
    );
  }

  problems.push(...checkEnvTypes(realBindings));

  if (problems.length > 0) {
    console.error("❌ Wrangler config verification failed:\n");
    problems.forEach((problem) => console.error(`${problem}\n`));
    process.exit(1);
  }

  console.log(
    `✅ Wrangler config verification passed (${realBindings.length} bindings, env types in sync).`,
  );
}

main();
