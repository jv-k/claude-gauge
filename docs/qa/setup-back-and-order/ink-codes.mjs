// Prints the codes Ink draws for one marked part, to check that reverse
// video survives Ink's own handling of the codes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { previewer, samplePayload } = require('../../../dist/wizard.js');
const ink = await import('ink');
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const nowMs = Date.UTC(2026, 10, 3, 12);
const p = previewer(samplePayload(nowMs), { nowMs });
const row = p(['--show', 'ctx,5h,7d', '--show', 'time,duration,repo', '--bar-style', 'classic,ctx=dots,5h=hairline', '--no-labels'], false, false, { row: 0, part: 1 }).split('\n')[0];
const app = render(React.createElement(ink.Text, null, row));
console.log(JSON.stringify(app.lastFrame()));
app.unmount();
