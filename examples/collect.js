import { collectEnvironment } from '../src/index.js';

const report = await collectEnvironment();
console.log(JSON.stringify(report, null, 2));
