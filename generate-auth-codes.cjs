/**
 * MMPEA 授权码批量生成器
 *
 * 用法: node generate-auth-codes.js
 *
 * 输出:
 *   auth-codes.txt       — 1000个授权码明文（你自己留着，发给授权的人）
 *   auth-hashes.js       — 哈希数组（复制到 index.js 里）
 */

const crypto = require('crypto');
const fs = require('fs');

const COUNT = 1000;
const codes = [];
const hashes = [];

function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `MMPEA-${seg()}-${seg()}`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// 生成
const codeSet = new Set();
while (codeSet.size < COUNT) {
    codeSet.add(randomCode());
}

for (const code of codeSet) {
    codes.push(code);
    hashes.push(sha256(code));
}

// 写授权码明文
fs.writeFileSync('auth-codes.txt', codes.join('\n'), 'utf8');
console.log(`已生成 ${COUNT} 个授权码 → auth-codes.txt`);

// 写哈希数组
const jsContent = `// MMPEA 授权码哈希表 — 生成于 ${new Date().toISOString()}
// 共 ${COUNT} 个有效码
const VALID_AUTH_HASHES = new Set([
${hashes.map(h => `    '${h}',`).join('\n')}
]);
`;
fs.writeFileSync('auth-hashes.js', jsContent, 'utf8');
console.log(`已生成哈希数组 → auth-hashes.js`);
console.log(`\n示例码: ${codes[0]} → ${hashes[0].substring(0, 16)}...`);
