// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// Writes the shared server spec: conformance/server-spec.v1.json and the copies the Go and Python packages embed.
import { writeFileSync } from 'node:fs';
import { buildServerSpec, SPEC_COPIES } from './server-spec.js';

const text = `${JSON.stringify(buildServerSpec())}\n`;
for (const path of SPEC_COPIES) writeFileSync(new URL(`../${path}`, import.meta.url), text);
console.log(`server spec: ${text.length} bytes -> ${SPEC_COPIES.join(', ')}`);
