#!/usr/bin/env node
// A stand-in e2e runner that records the selectors the red check hands it and runs nothing.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const io = process.env.E2E_IO_DIR;
appendFileSync(process.env.RECORD_SELECTION_TO, readFileSync(path.join(io, 'select.txt'), 'utf8'));
writeFileSync(path.join(io, 'report.json'), JSON.stringify({ config: { configFile: path.join(process.cwd(), 'playwright.config.ts') }, suites: [], errors: [] }));
