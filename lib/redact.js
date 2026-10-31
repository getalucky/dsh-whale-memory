/**
 * redact.js —— 把凭据从记忆里拿掉
 *
 * 为什么要有：QQ 里会有人直接贴 API key、密码、token。原来的链路是
 * 「原话 → staging → 分片 → system prompt」，等于把密钥写到盘上再送进上下文。
 *
 * 只认有明确前缀/字段名的东西（sk-、ghp_、Bearer、password: …），
 * 不做「一串长字符就一定是密钥」这种猜测 —— QQ 号、订单号不能被误伤。
 */

const RULES = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[密钥已隐藏]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[密钥已隐藏]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[密钥已隐藏]'],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, 'Bearer [已隐藏]'],
  [
    /((?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|token|password|passwd|密码|口令|cookie)\s*[:=：]\s*)([^\s，。；,;]{4,})/gi,
    '$1[已隐藏]',
  ],
]

/** 打码。没有命中就原样返回（同一个字符串引用，方便调用方判断）。 */
export function redactText(text) {
  let s = String(text ?? '')
  for (const [re, to] of RULES) s = s.replace(re, to)
  return s
}

/** 这段话里有没有凭据（入库前判断要不要记一笔审计）。 */
export function hasSecret(text) {
  const s = String(text ?? '')
  return RULES.some(([re]) => {
    re.lastIndex = 0
    return re.test(s)
  })
}
