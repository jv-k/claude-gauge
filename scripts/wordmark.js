// Draws the README's wordmark as an SVG on stdout: the CLI's rows from the
// build, each box-drawing cell as thick strokes, under the CLI's diagonal
// gradient. scripts/media.sh turns it into docs/media/wordmark-dark.png and
// wordmark-light.png. Pass `light` for the darker stops that read on white.
const { wordmark } = require('../dist/wordmark.js');

const rows = wordmark(false).trimEnd().split('\n');

// The gradient's stops, as in src/wordmark.ts, and darker ones for a light
// background.
const STOPS = {
  dark: ['#f2774a', '#e04592', '#8b5cf6'],
  light: ['#d9572b', '#c42a78', '#6b3fd9'],
};
const SHIFT = 2;

// Each glyph as the arms it draws from the cell's centre.
const ARMS = {
  '┏': 'rd', '┓': 'ld', '┗': 'ur', '┛': 'ul', '━': 'lr', '┃': 'ud',
  '┣': 'udr', '┫': 'udl', '┳': 'lrd', '┻': 'lru',
  '╸': 'l', '╺': 'r', '╹': 'u', '╻': 'd',
};

const W = 38.5;
const H = 63.5;
const STROKE = 14;
const LEFT = 52;
const TOP = 55;
const half = STROKE / 2;

const rects = [];
rows.forEach((row, y) => {
  [...row].forEach((cell, x) => {
    const cx = LEFT + x * W;
    const cy = TOP + y * H;
    for (const arm of ARMS[cell] ?? '') {
      const r = {
        l: [cx - W / 2, cy - half, W / 2 + half, STROKE],
        r: [cx - half, cy - half, W / 2 + half, STROKE],
        u: [cx - half, cy - H / 2, STROKE, H / 2 + half],
        d: [cx - half, cy - half, STROKE, H / 2 + half],
      }[arm];
      rects.push(`<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}"/>`);
    }
  });
});

// The gradient runs from the first cell's centre, across the direction in
// which a cell's place in it, (x + SHIFT * y) / span, grows.
const span = [...rows[0]].length - 1 + SHIFT * (rows.length - 1);
const [gx, gy] = [1 / W, SHIFT / H];
const s = span / (gx * gx + gy * gy);
const stops = STOPS[process.argv[2] === 'light' ? 'light' : 'dark'];

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="1480" height="260" viewBox="0 0 1480 260">
<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${LEFT}" y1="${TOP}" x2="${LEFT + s * gx}" y2="${TOP + s * gy}">
${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('\n')}
</linearGradient></defs>
<g fill="url(#g)" shape-rendering="crispEdges">
${rects.join('\n')}
</g>
</svg>
`);
