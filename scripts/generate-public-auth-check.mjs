import { execFile } from "node:child_process";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const publicAuthPath = resolve(root, "data/public-auth-check.enc.json");
const passwordService = "com.tanwenjie.business-dashboard.public.password";
const iterations = 60000;

async function readPublicPassword() {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-a",
    "default",
    "-s",
    passwordService,
    "-w"
  ]);
  const password = stdout.trim();
  if (!password) throw new Error("钥匙串中没有公网看板访问密码。");
  return password;
}

function encryptAuthPayload(password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = {
    ok: true,
    purpose: "public-dashboard-password-check",
    createdAt: new Date().toISOString()
  };
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final()
  ]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
    updatedAt: new Date().toISOString()
  };
}

const password = await readPublicPassword();
mkdirSync(resolve(root, "data"), { recursive: true });
writeFileSync(publicAuthPath, `${JSON.stringify(encryptAuthPayload(password), null, 2)}\n`);
console.log(`已生成轻量密码校验文件：${publicAuthPath}`);
