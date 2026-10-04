// Подставляет версию в public/sw.js при сборке на Vercel,
// чтобы у пользователей автоматически обновлялся офлайн-кеш.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'public', 'sw.js');
const stamp =
  (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) ||
  new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const src = fs.readFileSync(file, 'utf8');
const token = '__' + 'BUILD' + '__';
if (!src.includes(token)) {
  console.log('stamp: метка версии уже подставлена, пропускаю');
  process.exit(0);
}
fs.writeFileSync(file, src.replace(token, stamp));
console.log('stamp: версия service worker = ' + stamp);
