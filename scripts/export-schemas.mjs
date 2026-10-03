import { mkdir, writeFile } from 'node:fs/promises';
import { documentSchema, transactionSchema } from '../packages/transports/dist/index.js';
const directory = new URL('../schemas/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schema] of [['document-v1', documentSchema], ['transaction-v1', transactionSchema]]) {
  await writeFile(new URL(`${name}.schema.json`, directory), `${JSON.stringify(schema, null, 2)}\n`);
}
