// Crea un unico file HTML con le immagini incorporate
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'app'), out = path.join(__dirname, '..', 'dist');
const uri = (f, t) => 'data:' + t + ';base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
let h = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const swap = (a, b) => { if (!h.includes(a)) throw new Error('non trovato: ' + a); h = h.split(a).join(b); };
swap('src="logo.png"', 'src="' + uri('logo.png', 'image/png') + '"');
swap('src="wordmark.png"', 'src="' + uri('wordmark.png', 'image/png') + '"');
swap("SAMPLE.src = 'kat.jpg'", "SAMPLE.src = '" + uri('kat.jpg', 'image/jpeg') + "'");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'ST-Card-Creator.html'), h);
console.log('ok', (h.length / 1024).toFixed(0) + ' KB');
