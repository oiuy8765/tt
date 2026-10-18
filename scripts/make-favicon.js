// 把 16/32 的 PNG 封装成 ICO（PNG-in-ICO，Vista+ 全支持）
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.tmp-ico');
const imgs = [
  { size: 32, file: 'icon32.png' },
  { size: 16, file: 'icon16.png' },
].map((x) => ({ ...x, data: fs.readFileSync(path.join(dir, x.file)) }));

const count = imgs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

let offset = 6 + count * 16;
const entries = [];
for (const img of imgs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += img.data.length;
}

const out = Buffer.concat([header, ...entries, ...imgs.map((i) => i.data)]);
const dest = path.join(__dirname, '..', 'public', 'favicon.ico');
fs.writeFileSync(dest, out);
console.log('saved ' + dest + ' ' + out.length + ' bytes');
